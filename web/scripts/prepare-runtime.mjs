import { execFileSync } from 'node:child_process'
import { rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '.build', 'runtime')
const javaHome = process.env.JAVA_HOME
if (!javaHome) throw new Error('Set JAVA_HOME to a JDK 17+ before building the Windows app.')
const jlink = resolve(javaHome, 'bin', process.platform === 'win32' ? 'jlink.exe' : 'jlink')

rmSync(output, { recursive: true, force: true })
execFileSync(jlink, [
  '--add-modules', 'java.base,java.desktop,java.logging,java.prefs,java.xml',
  '--strip-debug', '--no-man-pages', '--no-header-files', '--compress=2',
  '--output', output,
], { stdio: 'inherit' })
console.log(`Bundled Java runtime created at ${output}`)
