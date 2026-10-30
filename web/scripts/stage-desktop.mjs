import { cp, mkdir, rm } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, '..', 'desktop', 'electron')
const output = resolve(root, '.build', 'desktop')

await rm(output, { recursive: true, force: true })
await mkdir(output, { recursive: true })
await cp(source, output, { recursive: true })
console.log(`Staged Electron app from ${source}`)
