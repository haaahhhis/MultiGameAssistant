#!/usr/bin/env node
/**
 * Why dsh says "failed to import": dsh reports a plugin it could not load
 * without the error. This loads each of them the way dsh resolves it (from
 * its bundles, dsh-base and dsh-web-app) and prints the real error, so a
 * broken install shows which file or module is at fault.
 *
 *   pnpm check:dsh                       the plugins that usually fail together
 *   pnpm check:dsh @deepseek-ai/dsh-schedule …   just these
 *
 * Run it with the Electron runtime too, as the desktop app does
 * (ELECTRON_RUN_AS_NODE): `pnpm check:dsh --electron`.
 */
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const args = process.argv.slice(2)

if (args.includes('--electron')) {
  // The binary itself: requiring the electron package would try to download it when it is missing.
  const exe = join(dirname(createRequire(join(root, 'apps', 'desktop', 'package.json')).resolve('electron/package.json')), 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron')
  if (!existsSync(exe)) {
    console.log(`Electron is not installed (${exe}): run pnpm setup:electron first`)
    process.exit(1)
  }
  const result = spawnSync(exe, [fileURLToPath(import.meta.url), ...args.filter(a => a !== '--electron')], { stdio: 'inherit', env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' } })
  if (result.error !== undefined) console.log(`Electron did not start (${exe}): ${result.error.message}`)
  else if (result.status !== 0 && result.status !== 1) console.log(`Electron exited with ${result.status ?? result.signal} before checking anything (${exe})`)
  process.exit(result.status ?? 1)
}

const DEFAULT = [
  '@deepseek-ai/dsh-session',
  '@deepseek-ai/dsh-jobs-local',
  '@deepseek-ai/dsh-session-query-sqlite',
  '@deepseek-ai/dsh-subagent',
  '@deepseek-ai/dsh-api-session-controller',
  '@deepseek-ai/dsh-schedule',
]
const names = args.length > 0 ? args : DEFAULT

const dshRequire = createRequire(createRequire(join(root, 'package.json')).resolve('@deepseek-ai/dsh/package.json'))
const bases = ['@deepseek-ai/dsh-base', '@deepseek-ai/dsh-web-app'].flatMap(b => {
  try { return [createRequire(dshRequire.resolve(`${b}/package.json`))] } catch { return [] }
})

console.log(`runtime: ${process.versions.electron === undefined ? 'node' : `electron ${process.versions.electron}`} (node ${process.version}, modules ${process.versions.modules})`)
let failed = 0
for (const name of names) {
  let file
  for (const base of [dshRequire, ...bases]) {
    try { file = base.resolve(name); break } catch { /* next base */ }
  }
  if (file === undefined) {
    failed++
    console.log(`✗ ${name}: not found from dsh's bundles (its folder in node_modules is missing)`)
    continue
  }
  try {
    await import(pathToFileURL(file).href)
    console.log(`✓ ${name}`)
  } catch (error) {
    failed++
    const lines = String(error?.stack ?? error).split('\n').slice(0, 6).join('\n    ')
    console.log(`✗ ${name}\n    ${lines}`)
    // Node looks for index.js only when the package has no package.json: its folder is there, its files are not.
    const gone = /Cannot find package '(.+?)[\\/]index\.js'/.exec(String(error?.message ?? ''))?.[1]
    if (gone !== undefined && !existsSync(join(gone, 'package.json'))) console.log(`    → ${gone} 只剩文件夹，里面的文件没了（被删掉或没装完整）`)
  }
}
console.log(failed === 0 ? '\nall load: the problem is elsewhere' : `\n${failed} failed: send these lines; \`pnpm install --force\` usually repairs a broken node_modules`)
process.exit(failed === 0 ? 0 : 1)
