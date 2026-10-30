const { app, BrowserWindow, ipcMain } = require('electron')
const { spawn } = require('node:child_process')
const { mkdtemp, rm, writeFile } = require('node:fs/promises')
const { join } = require('node:path')
const os = require('node:os')

const isPackaged = app.isPackaged
const jarPath = isPackaged
  ? join(process.resourcesPath, 'Mars45.jar')
  : join(__dirname, '..', '..', 'Mars45.jar')
const bundledJava = isPackaged
  ? join(process.resourcesPath, 'runtime', 'bin', process.platform === 'win32' ? 'java.exe' : 'java')
  : 'java'

function launchWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 940,
    minWidth: 960,
    minHeight: 650,
    backgroundColor: '#0b1017',
    title: 'reMARS',
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  if (isPackaged) win.loadFile(join(__dirname, '..', 'out', 'index.html'))
  else win.loadURL(process.env.REMARS_DEV_URL || 'http://localhost:3000')
}

ipcMain.handle('mars:execute', async (_event, { code, action, maxSteps }) => {
  if (typeof code !== 'string' || code.length > 1_000_000) {
    return { ok: false, stdout: '', stderr: 'Source must be text under 1 MB.', exitCode: 2 }
  }
  if (!['assemble', 'run'].includes(action)) {
    return { ok: false, stdout: '', stderr: 'Unsupported MARS action.', exitCode: 2 }
  }

  const tempDir = await mkdtemp(join(os.tmpdir(), 'remars-'))
  const sourcePath = join(tempDir, 'program.asm')
  await writeFile(sourcePath, code, 'utf8')

  try {
    const args = ['-jar', jarPath, 'nc', 'me']
    if (action === 'assemble') args.push('a', 'ae1')
    else args.push('sm', 'se1', String(Math.min(Math.max(Number(maxSteps) || 0, 0), 10_000_000)), '$v0', '$v1', '$a0', '$a1', '$t0', '$t1', '$t2', '$sp', '$ra')
    args.push(sourcePath)
    const result = await new Promise((resolve) => {
      const child = spawn(bundledJava, args, { windowsHide: true, cwd: tempDir })
      let stdout = ''
      let stderr = ''
      let settled = false
      const timer = setTimeout(() => child.kill(), 12_000)
      child.stdout.setEncoding('utf8').on('data', (chunk) => { stdout += chunk })
      child.stderr.setEncoding('utf8').on('data', (chunk) => { stderr += chunk })
      child.on('error', (error) => {
        if (!settled) { settled = true; clearTimeout(timer); resolve({ ok: false, stdout, stderr: `${stderr}${error.message}`, exitCode: 127 }) }
      })
      child.on('close', (exitCode, signal) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve({ ok: exitCode === 0, stdout, stderr: signal ? `${stderr}MARS execution timed out.` : stderr, exitCode: exitCode ?? 1 })
        }
      })
    })
    return result
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
})

app.whenReady().then(launchWindow)
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit() })
app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) launchWindow() })
