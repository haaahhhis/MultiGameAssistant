#!/usr/bin/env node
/** Boot `dsh --profile adg` against .dev-home; extra args pass through. */
import { spawn } from 'node:child_process'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const args = ['--profile', 'adg', ...process.argv.slice(2)]
if (!args.includes('--no-open')) args.push('--no-open')
const child = spawn(process.execPath, [bin, ...args], {
  env: { ...process.env, DSH_HOME: process.env.DSH_HOME ?? join(root, '.dev-home') },
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => process.exit(code ?? 0))
