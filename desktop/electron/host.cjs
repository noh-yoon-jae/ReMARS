const { app, BrowserWindow, dialog, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { readFile, writeFile } = require('node:fs/promises')
const { existsSync, mkdirSync } = require('node:fs')
const { basename, delimiter, join } = require('node:path')

const isPackaged = app.isPackaged
const resources = process.resourcesPath
const webRoot = join(__dirname, '..', '..')
const projectRoot = join(webRoot, '..')
const jarPath = isPackaged ? join(resources, 'Mars45.jar') : join(projectRoot, 'Mars45.jar')
const bridgePath = isPackaged ? join(resources, 'engine') : join(projectRoot, 'mars-engine', 'build', 'classes')
const javaName = process.platform === 'win32' ? 'java.exe' : 'java'
const javaHomePath = process.env.JAVA_HOME ? join(process.env.JAVA_HOME, 'bin', javaName) : ''
const bundledJavaPath = isPackaged ? join(resources, 'runtime', 'bin', javaName) : ''
const javaPath = bundledJavaPath || (javaHomePath && existsSync(javaHomePath) ? javaHomePath : 'java')
const windows = new Set()

class MarsEngine {
  constructor() {
    this.child = null
    this.counter = 0
    this.pending = new Map()
    this.buffer = ''
    this.ready = null
    this.startupReject = null
  }

  start() {
    if (this.child) return this.ready
    const workingDirectory = app.getPath('userData')
    if (!existsSync(jarPath)) throw new Error(`MARS JAR not found: ${jarPath}`)
    if (!existsSync(join(bridgePath, 'remars', 'MarsBridge.class'))) throw new Error(`MARS bridge class not found: ${bridgePath}`)
    if (pathIsExecutable(javaPath) && !existsSync(javaPath)) throw new Error(`Java executable not found: ${javaPath}`)
    mkdirSync(workingDirectory, { recursive: true })
    console.info(`[reMARS] Starting MARS engine: Java=${javaPath}; JAR=${jarPath}; bridge=${bridgePath}; cwd=${workingDirectory}`)
    const classpath = [jarPath, bridgePath].join(delimiter)
    this.buffer = ''
    const child = spawn(javaPath, ['-Dfile.encoding=UTF-8', '-cp', classpath, 'remars.MarsBridge'], {
      cwd: workingDirectory,
      windowsHide: true,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child
    this.ready = new Promise((resolve, reject) => {
      let settled = false
      const finish = (error) => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        this.startupReject = null
        this._ready = null
        if (error) reject(error)
        else resolve()
      }
      const timer = setTimeout(() => {
        finish(new Error(`MARS engine startup timed out. Check Java and the engine files. Java: ${javaPath}; bridge: ${bridgePath}`))
        child.kill()
      }, 15_000)
      this.startupReject = finish
      child.once('error', (error) => finish(new Error(`Could not start Java (${javaPath}): ${error.message}`)))
      this._ready = () => finish()
    })
    child.stdout.setEncoding('utf8').on('data', (chunk) => this._consume(chunk))
    child.stderr.setEncoding('utf8').on('data', (chunk) => {
      console.error(`[reMARS Java] ${chunk.trimEnd()}`)
      this._broadcast({ event: 'engine-log', text: chunk })
    })
    child.once('spawn', () => console.info('[reMARS] Java process started.'))
    child.once('close', (code, signal) => {
      console.error(`[reMARS] Java process exited: ${signal || code}`)
      this.startupReject?.(new Error(`MARS engine stopped before becoming ready (exit ${signal || code}). Java: ${javaPath}; bridge: ${bridgePath}`))
      this.child = null
      this._ready = null
      const error = new Error(`MARS engine exited (${signal || code}).`)
      for (const pending of this.pending.values()) pending.reject(error)
      this.pending.clear()
      this._broadcast({ event: 'engine-error', text: error.message })
    })
    return this.ready
  }

  _consume(chunk) {
    this.buffer += chunk
    for (;;) {
      const newline = this.buffer.indexOf('\n')
      if (newline < 0) break
      const line = this.buffer.slice(0, newline).trim()
      this.buffer = this.buffer.slice(newline + 1)
      if (!line) continue
      let message
      try { message = JSON.parse(line) } catch { console.error(`[reMARS Java stdout] ${line}`); this._broadcast({ event: 'engine-log', text: line }); continue }
      if (message.event === 'engine-ready') { console.info(`[reMARS] MARS engine ${message.version || ''} ready.`); this._ready?.(); continue }
      if (message.id !== undefined) {
        const pending = this.pending.get(String(message.id))
        if (pending) {
          this.pending.delete(String(message.id))
          pending.resolve(message)
        }
      } else this._broadcast(message)
    }
  }

  async request(command, ...fields) {
    await this.start()
    if (!this.child || !this.child.stdin.writable) throw new Error('MARS engine is unavailable.')
    const id = String(++this.counter)
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error('MARS command timed out.'))
      }, 30_000)
      this.pending.set(id, {
        resolve: (value) => { clearTimeout(timer); resolve(value) },
        reject: (error) => { clearTimeout(timer); console.error(`[reMARS] Engine request ${id} failed: ${error.message}`); reject(error) },
      })
      this.child.stdin.write([id, command, ...fields].join('\t') + '\n', 'utf8', (error) => {
        if (!error) return
        this.pending.delete(id)
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  _broadcast(message) {
    for (const win of windows) if (!win.isDestroyed()) win.webContents.send('mars:event', message)
  }

  shutdown() { this.child?.kill() }
}

function pathIsExecutable(value) {
  return value.includes('/') || value.includes('\\')
}

const engine = new MarsEngine()
const encode = (value) => Buffer.from(String(value ?? ''), 'utf8').toString('base64')
const lines = (value) => Array.isArray(value) ? value.map((line) => Number(line)).filter(Number.isInteger).join(',') : ''
const options = (value = {}) => encode(`startAtMain=${value.startAtMain !== false};delayedBranching=${value.delayedBranching === true};warningsAreErrors=${value.warningsAreErrors === true}`)

ipcMain.handle('mars:command', async (_event, { action, payload = {} }) => {
  switch (action) {
    case 'assemble':
      if (typeof payload.code !== 'string' || payload.code.length > 1_000_000) throw new Error('Source must be under 1 MB.')
      return engine.request('assemble', encode(payload.code), options(payload.settings))
    case 'run':
      return engine.request('run', String(Math.min(Math.max(Number(payload.maxSteps) || 1_000_000, 1), 10_000_000)), String(Math.max(0, Number(payload.delayMs) || 0)), encode(lines(payload.breakpoints)), encode(payload.code || ''))
    case 'step':
      return engine.request('step', encode(payload.code || ''), options(payload.settings), encode(lines(payload.breakpoints)))
    case 'pause': case 'stop': case 'reset': case 'backstep': case 'snapshot':
      return engine.request(action)
    case 'breakpoints':
      return engine.request('breakpoints', encode(lines(payload.lines)))
    case 'memory':
      return engine.request('memory', encode(payload.address || '0x10010000'))
    case 'input':
      if (typeof payload.text !== 'string' || payload.text.length > 16_384) throw new Error('Input must be under 16 KB.')
      return engine.request('input', encode(payload.text + '\n'))
    default: throw new Error('Unsupported reMARS command.')
  }
})

ipcMain.handle('files:open', async (event) => {
  const win = BrowserWindow.fromWebContents(event.sender)
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'], filters: [{ name: 'MIPS Assembly', extensions: ['asm', 's', 'txt'] }] })
  if (result.canceled || !result.filePaths[0]) return null
  const path = result.filePaths[0]
  const contents = await readFile(path, 'utf8')
  return { path, name: basename(path), contents }
})

ipcMain.handle('files:save', async (event, { path, name, contents }) => {
  if (typeof contents !== 'string' || contents.length > 1_000_000) throw new Error('Source must be under 1 MB.')
  const win = BrowserWindow.fromWebContents(event.sender)
  let target = typeof path === 'string' && path ? path : ''
  if (!target) {
    const result = await dialog.showSaveDialog(win, {
      defaultPath: name || 'program.asm',
      filters: [{ name: 'MIPS Assembly', extensions: ['asm'] }],
    })
    if (result.canceled || !result.filePath) return null
    target = result.filePath
  }
  await writeFile(target, contents, 'utf8')
  return { path: target, name: basename(target) }
})

function launchWindow() {
  const win = new BrowserWindow({
    width: 1440, height: 940, minWidth: 960, minHeight: 650,
    backgroundColor: '#0b1017', title: 'reMARS',
    webPreferences: { preload: join(__dirname, 'preload.cjs'), contextIsolation: true, nodeIntegration: false, sandbox: true },
  })
  windows.add(win)
  win.on('closed', () => windows.delete(win))
  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, validatedURL) => {
    console.error(`[reMARS] Renderer navigation failed (${errorCode}): ${errorDescription} — ${validatedURL}`)
  })
  win.webContents.once('did-finish-load', () => {
    console.info('[reMARS] Renderer finished loading.')
    engine.request('snapshot').then((result) => {
      if (win.isDestroyed()) return
      win.webContents.send('mars:event', { event: 'engine-ready', version: '4.5' })
      win.webContents.send('mars:event', { event: 'snapshot', snapshot: result.snapshot, instructions: result.instructions, symbols: result.symbols })
    }).catch((error) => {
      console.error('[reMARS] Initial snapshot request failed:', error)
      if (!win.isDestroyed()) win.webContents.send('mars:event', { event: 'engine-error', text: error.message })
    })
  })
  if (isPackaged) win.loadFile(join(webRoot, 'out', 'index.html'))
  else win.loadURL(process.env.REMARS_DEV_URL || 'http://localhost:3000')
}

app.whenReady().then(async () => {
  try { await engine.start() } catch (error) {
    console.error('[reMARS] Engine startup failed:', error)
    engine._broadcast({ event: 'engine-error', text: error.message })
  }
  launchWindow()
})
app.on('before-quit', () => engine.shutdown())
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) launchWindow() })
