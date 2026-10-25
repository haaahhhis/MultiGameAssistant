#!/usr/bin/env node
/**
 * Build the Windows installer: `dist/desktop/MultiGameAssistant-Setup-<version>.exe`.
 *
 * 1. `pnpm build` (skip with --skip-build).
 * 2. `pnpm deploy` the desktop app into dist/desktop/app with its production
 *    dependencies only — dsh, the bundle and our plugins — as a flat
 *    node_modules with no links, so the installer can copy it as is.
 * 3. Add the UI (apps/web/dist → web/), the startup screen's stylesheet, the
 *    icon, and installed.json (the shell reads it to know it is installed:
 *    data goes to %LOCALAPPDATA%\MultiGameAssistant, see apps/desktop/main.mjs).
 * 4. electron-builder: the Electron runtime already in node_modules (no
 *    download), no asar (dsh runs the files as a separate Node process), an
 *    NSIS installer per user (no administrator), Chinese, desktop and Start
 *    menu shortcuts; uninstalling keeps the data (apps/desktop/installer.nsh).
 *    Source maps are left out (a quarter of the files; nothing reads them).
 *
 *   pnpm package:desktop [--skip-build] [--version 0.7.0] [--dir] [--out <folder>]
 *
 * --dir stops after the unpacked app (<out>/win-unpacked), for a quick try.
 * --out builds somewhere else than dist/desktop. electron-builder runs a stub
 * of the installer it builds; on a machine where dsh's sandbox has labelled
 * the repository low-integrity, programs started from under it fail, so
 * build outside it there.
 * electron-builder downloads NSIS once; ELECTRON_BUILDER_BINARIES_MIRROR picks
 * a mirror (e.g. https://npmmirror.com/mirrors/electron-builder-binaries/).
 */
import { execFileSync } from 'node:child_process'
import { copyFileSync, cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { appIconIco } from '../apps/desktop/icon.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const desktop = join(root, 'apps', 'desktop')
const args = process.argv.slice(2)
const flag = name => args.includes(name)
const option = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const out = resolve(option('--out') ?? join(root, 'dist', 'desktop'))
const staging = join(out, 'app')
const resources = join(out, 'build')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const run = (cmd, cmdArgs, cwd = root) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
const step = text => console.log(`\n▸ ${text}`)

const version = option('--version') ?? versionFromGit()
const commit = git(['rev-parse', '--short', 'HEAD'])
console.log(`MultiGameAssistant ${version} (${commit ?? 'no git'})`)

if (!flag('--skip-build')) {
  step('pnpm build')
  run(pnpm, ['build'])
}
if (!existsSync(join(root, 'apps', 'web', 'dist', 'index.html'))) throw new Error('apps/web/dist is missing: run pnpm build first')

step('production dependencies → dist/desktop/app')
rmSync(out, { recursive: true, force: true, maxRetries: 5 })
mkdirSync(out, { recursive: true })
// --legacy: the workspace has two cordis versions in its graph; hoisted: a flat node_modules without links.
run(pnpm, ['--filter', '@adg/desktop', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', staging])

step('UI, startup screen, icon, installed.json')
cpSync(join(root, 'apps', 'web', 'dist'), join(staging, 'web'), { recursive: true })
// The splash links the page's stylesheet from the repository; installed, it sits next to it.
copyFileSync(join(root, 'apps', 'web', 'src', 'boot.css'), join(staging, 'boot.css'))
const splash = readFileSync(join(staging, 'splash.html'), 'utf8')
if (!splash.includes('href="../web/src/boot.css"')) throw new Error('splash.html no longer links ../web/src/boot.css: update package-desktop.mjs')
writeFileSync(join(staging, 'splash.html'), splash.replace('href="../web/src/boot.css"', 'href="./boot.css"'))
for (const junk of ['installer.nsh']) rmSync(join(staging, junk), { force: true })
// Source maps are a quarter of the files and nothing reads them: fewer files install much faster.
const maps = removeFiles(join(staging, 'node_modules'), name => name.endsWith('.map'))
console.log(`  removed ${maps} source maps`)
writeFileSync(join(staging, 'installed.json'), `${JSON.stringify({ version, ...(commit === undefined ? {} : { commit }), builtAt: new Date().toISOString() }, null, 2)}\n`)
const manifest = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'))
delete manifest.devDependencies
delete manifest.scripts
// electron-builder copies what `dependencies` leads to, and does not follow peer dependencies, which dsh wires
// most of its plugins through: list every package pnpm deploy put at the top level, so all of node_modules goes in.
manifest.dependencies = topLevelPackages(join(staging, 'node_modules'))
writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ ...manifest, name: 'multigameassistant', productName: 'MultiGameAssistant', version, author: 'MultiGameAssistant' }, null, 2)}\n`)
mkdirSync(resources, { recursive: true })
writeFileSync(join(resources, 'icon.ico'), appIconIco())
copyFileSync(join(desktop, 'installer.nsh'), join(resources, 'installer.nsh'))

step(flag('--dir') ? 'electron-builder (unpacked only)' : 'electron-builder → NSIS installer')
const require = createRequire(join(desktop, 'package.json'))
const { build, Platform, Arch } = require('electron-builder')
const electronVersion = require('electron/package.json').version
// The runtime electron-builder copies (pnpm setup:electron puts it in place, without downloading twice).
if (!existsSync(join(dirname(require.resolve('electron/package.json')), 'dist', 'electron.exe'))) run(process.execPath, [join(root, 'scripts', 'fetch-electron.mjs')])
const files = await build({
  projectDir: staging,
  targets: Platform.WINDOWS.createTarget(flag('--dir') ? 'dir' : 'nsis', Arch.x64),
  config: {
    // The id from before the rename (AutoDailyGamePlay): Windows knows the installed app by it, so a new
    // version still replaces the old one instead of installing beside it. People never see it.
    appId: 'com.autodailygameplay.desktop',
    productName: 'MultiGameAssistant',
    executableName: 'MultiGameAssistant',
    copyright: 'MultiGameAssistant',
    directories: { output: out, buildResources: resources },
    electronDist: join(dirname(require.resolve('electron/package.json')), 'dist'),
    electronVersion,
    asar: false,
    npmRebuild: false,
    nodeGypRebuild: false,
    // node_modules is already exactly what runs (pnpm deploy --prod): take it whole.
    files: ['**/*'],
    win: { target: 'nsis', icon: join(resources, 'icon.ico'), signAndEditExecutable: true },
    nsis: {
      oneClick: false,
      perMachine: false,
      allowToChangeInstallationDirectory: true,
      createDesktopShortcut: true,
      createStartMenuShortcut: true,
      shortcutName: 'MultiGameAssistant',
      installerIcon: join(resources, 'icon.ico'),
      uninstallerIcon: join(resources, 'icon.ico'),
      installerLanguages: ['zh_CN'],
      language: '2052',
      deleteAppDataOnUninstall: false,
      // Starting the app from the installer goes through the new shortcut and can fail with
      // "Windows cannot find …MultiGameAssistant.lnk": start it from the shortcut instead.
      runAfterFinish: false,
      include: join(resources, 'installer.nsh'),
      artifactName: 'MultiGameAssistant-Setup-${version}.${ext}',
    },
  },
})
console.log(`\ndone:\n${files.map(f => `  ${f}`).join('\n')}`)

/** Delete the files under `dir` whose name matches. @returns how many. */
function removeFiles(dir, match) {
  let count = 0
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name)
    if (entry.isDirectory()) count += removeFiles(path, match)
    else if (match(entry.name)) { rmSync(path, { force: true }); count++ }
  }
  return count
}

/** `{ name: version }` of every package directly in a node_modules folder (scoped ones too). */
function topLevelPackages(dir) {
  const found = {}
  const add = path => {
    try {
      const { name, version: v } = JSON.parse(readFileSync(join(path, 'package.json'), 'utf8'))
      if (typeof name === 'string' && typeof v === 'string') found[name] = v
    } catch { /* not a package */ }
  }
  for (const entry of readdirSync(dir)) {
    if (entry.startsWith('.')) continue
    if (entry.startsWith('@')) for (const scoped of readdirSync(join(dir, entry))) add(join(dir, entry, scoped))
    else add(join(dir, entry))
  }
  return Object.fromEntries(Object.entries(found).sort(([a], [b]) => a.localeCompare(b)))
}

/** The latest tag as the version: v0.6.0-beta.5 → 0.6.0-beta.5; 3 commits after it → 0.6.0-beta.5.3. */
function versionFromGit() {
  const described = git(['describe', '--tags', '--long', '--match', 'v*'])
  const match = described === undefined ? null : /^v(\d+\.\d+\.\d+)(-[0-9A-Za-z.]+)?-(\d+)-g[0-9a-f]+$/.exec(described)
  if (match === null) return '0.0.0-dev'
  const [, base, pre = '', ahead] = match
  if (ahead === '0') return `${base}${pre}`
  return pre === '' ? `${base}-dev.${ahead}` : `${base}${pre}.${ahead}`
}

function git(gitArgs) {
  try {
    return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}
