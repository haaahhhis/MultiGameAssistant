#!/usr/bin/env node
/** Boot `dsh --profile adg` against .dev-home; extra args pass through. */
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const bin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
const args = ['--profile', 'adg', ...process.argv.slice(2)]
if (!args.includes('--no-open')) args.push('--no-open')
const home = process.env.DSH_HOME ?? join(root, '.dev-home')
// The agent's working folder, apart from the repository (see agentWorkspace in profile.mjs).
mkdirSync(process.env.ADG_WORKSPACE_DIR || join(home, 'adg', 'workspace'), { recursive: true })
const child = spawn(process.execPath, [bin, ...args], {
  env: { ...process.env, DSH_HOME: home },
  stdio: 'inherit',
})
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => child.kill(signal))
child.on('exit', code => process.exit(code ?? 0))
