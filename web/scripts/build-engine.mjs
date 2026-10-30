import { execFileSync } from 'node:child_process'
import { mkdirSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const root = resolve(import.meta.dirname, '..')
const output = resolve(root, '..', 'mars-engine', 'build', 'classes')
const javaHome = process.env.JAVA_HOME
if (!javaHome) throw new Error('Set JAVA_HOME to a JDK 17+ before compiling the MARS bridge.')
const javac = resolve(javaHome, 'bin', process.platform === 'win32' ? 'javac.exe' : 'javac')
const jar = resolve(root, '..', 'Mars45.jar')

rmSync(output, { recursive: true, force: true })
mkdirSync(output, { recursive: true })
execFileSync(javac, ['--release', '8', '-encoding', 'UTF-8', '-cp', jar, '-d', output, resolve(root, '..', 'mars-engine', 'src', 'MarsBridge.java')], { stdio: 'inherit' })
console.log(`Compiled MARS bridge to ${output}`)
