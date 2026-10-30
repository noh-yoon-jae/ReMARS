import { spawn } from 'node:child_process'
import { setTimeout as delay } from 'node:timers/promises'
import { createRequire } from 'node:module'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const nextCli = require.resolve('next/dist/bin/next')
const electronBin = require('electron')
const appUrl = process.env.REMARS_DEV_URL || 'http://127.0.0.1:3000'
const env = { ...process.env, REMARS_DEV_URL: appUrl }
const next = spawn(process.execPath, [nextCli, 'dev', '--hostname', '127.0.0.1'], { cwd: root, env, stdio: 'inherit', windowsHide: true })
let electron
let stopping = false

function stop(code = 0) {
  if (stopping) return
  stopping = true
  if (electron && electron.exitCode === null) electron.kill()
  if (next.exitCode === null) next.kill()
  process.exitCode = code
}

process.once('SIGINT', () => stop(0))
process.once('SIGTERM', () => stop(0))
next.once('error', (error) => { console.error('Could not start Next.js:', error.message); stop(1) })
next.once('exit', (code) => { if (!stopping) stop(code ?? 1) })

async function waitForNext() {
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline && !stopping) {
    try {
      const response = await fetch(appUrl, { method: 'HEAD', signal: AbortSignal.timeout(1500) })
      if (response.ok) return true
    } catch { /* Next.js is still starting. */ }
    await delay(500)
  }
  if (!stopping) { console.error(`Next.js did not become ready at ${appUrl}`); stop(1) }
  return false
}

if (await waitForNext()) {
  electron = spawn(electronBin, [root], { cwd: root, env, stdio: 'inherit', windowsHide: false })
  electron.once('error', (error) => { console.error('Could not start Electron:', error.message); stop(1) })
  electron.once('exit', (code) => stop(code ?? 0))
}
