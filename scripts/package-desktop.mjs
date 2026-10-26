#!/usr/bin/env node
/**
 * Build the Windows installer: `dist/desktop/MultiGameAssistant-Setup-<version>.exe`
 * (x64), or `…-Setup-<version>-arm64.exe` for Windows on ARM.
 *
 * 1. `pnpm build` (skip with --skip-build).
 * 2. `pnpm deploy` the desktop app into dist/desktop/app with its production
 *    dependencies only — dsh, the bundle and our plugins — as a flat
 *    node_modules with no links, so the installer can copy it as is. Native
 *    modules come for the target architecture (`--cpu`); each one is checked
 *    to be built for it.
 * 3. Add the UI (apps/web/dist → web/), the startup screen's stylesheet, the
 *    icon, and installed.json (the shell reads it to know it is installed:
 *    data goes to %LOCALAPPDATA%\MultiGameAssistant, see apps/desktop/main.mjs).
 * 4. electron-builder: the Electron runtime already in node_modules (no
 *    download; for another architecture, scripts/fetch-electron.mjs unpacks
 *    that one beside the output), no asar (dsh runs the files as a separate Node process), an
 *    NSIS installer per user (no administrator), Chinese, desktop and Start
 *    menu shortcuts; uninstalling keeps the data (apps/desktop/installer.nsh).
 *    Source maps are left out (a quarter of the files; nothing reads them).
 *
 *   pnpm package:desktop [--arch x64|arm64] [--skip-build] [--version 0.7.0] [--dir] [--out <folder>]
 *
 * --arch: x64 (default) or arm64. There is no 32-bit build: Electron no longer
 * makes one for Windows.
 * --dir stops after the unpacked app (<out>/win-unpacked, win-arm64-unpacked), for a quick try.
 * --out builds somewhere else than dist/desktop. electron-builder runs a stub
 * of the installer it builds; on a machine where dsh's sandbox has labelled
 * the repository low-integrity, programs started from under it fail, so
 * build outside it there.
 * electron-builder downloads NSIS once; ELECTRON_BUILDER_BINARIES_MIRROR picks
 * a mirror (e.g. https://npmmirror.com/mirrors/electron-builder-binaries/).
 */
import { execFileSync } from 'node:child_process'
import { closeSync, copyFileSync, cpSync, existsSync, mkdirSync, openSync, readdirSync, readFileSync, readSync, rmSync, writeFileSync } from 'node:fs'
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
const arch = option('--arch') ?? 'x64'
if (arch !== 'x64' && arch !== 'arm64') throw new Error(`--arch ${arch}: only x64 and arm64 (Electron makes no 32-bit Windows build)`)
const staging = join(out, 'app')
const resources = join(out, 'build')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const run = (cmd, cmdArgs, cwd = root) => execFileSync(cmd, cmdArgs, { cwd, stdio: 'inherit', shell: process.platform === 'win32' })
const step = text => console.log(`\n▸ ${text}`)

const version = option('--version') ?? versionFromGit()
const commit = git(['rev-parse', '--short', 'HEAD'])
console.log(`MultiGameAssistant ${version} (${commit ?? 'no git'}) for Windows ${arch}`)

if (!flag('--skip-build')) {
  step('pnpm build')
  run(pnpm, ['build'])
}
if (!existsSync(join(root, 'apps', 'web', 'dist', 'index.html'))) throw new Error('apps/web/dist is missing: run pnpm build first')

step(`production dependencies (win32-${arch}) → dist/desktop/app`)
rmSync(out, { recursive: true, force: true, maxRetries: 5 })
mkdirSync(out, { recursive: true })
// --legacy: the workspace has two cordis versions in its graph; hoisted: a flat node_modules without links.
// --os / --cpu: the native modules' platform packages (sharp, koffi…) for the target, not this machine.
// For another architecture, no install scripts: they check (or build) a binary for the machine running them —
// koffi's fails looking for this machine's — while each module loads the target's prebuilt one when the app runs.
const crossArch = arch === process.arch ? [] : ['--ignore-scripts']
run(pnpm, ['--filter', '@adg/desktop', 'deploy', '--prod', '--legacy', '--config.node-linker=hoisted', '--os=win32', `--cpu=${arch}`, ...crossArch, staging])
const wrong = nativeMismatches(join(staging, 'node_modules'), arch)
if (wrong.length > 0) throw new Error(`these packages have no ${arch} build of their native module:\n${wrong.map(w => `  ${w}`).join('\n')}`)

step('UI, startup screen, icon, license, installed.json')
cpSync(join(root, 'apps', 'web', 'dist'), join(staging, 'web'), { recursive: true })
// AGPL-3.0: the license goes with the program, as LICENSE.txt in the install folder (extraFiles takes it from here).
copyFileSync(join(root, 'LICENSE'), join(staging, 'LICENSE'))
// The splash links the page's stylesheet from the repository; installed, it sits next to it.
copyFileSync(join(root, 'apps', 'web', 'src', 'boot.css'), join(staging, 'boot.css'))
const splash = readFileSync(join(staging, 'splash.html'), 'utf8')
if (!splash.includes('href="../web/src/boot.css"')) throw new Error('splash.html no longer links ../web/src/boot.css: update package-desktop.mjs')
writeFileSync(join(staging, 'splash.html'), splash.replace('href="../web/src/boot.css"', 'href="./boot.css"'))
for (const junk of ['installer.nsh']) rmSync(join(staging, junk), { force: true })
// Source maps are a quarter of the files and nothing reads them: fewer files install much faster.
const maps = removeFiles(join(staging, 'node_modules'), name => name.endsWith('.map'))
console.log(`  removed ${maps} source maps`)
writeFileSync(join(staging, 'installed.json'), `${JSON.stringify({ version, arch, ...(commit === undefined ? {} : { commit }), builtAt: new Date().toISOString() }, null, 2)}\n`)
const manifest = JSON.parse(readFileSync(join(staging, 'package.json'), 'utf8'))
delete manifest.devDependencies
delete manifest.scripts
// electron-builder copies what `dependencies` leads to, and does not follow peer dependencies, which dsh wires
// most of its plugins through: list every package pnpm deploy put at the top level (afterPack fills what it still misses).
manifest.dependencies = topLevelPackages(join(staging, 'node_modules'))
writeFileSync(join(staging, 'package.json'), `${JSON.stringify({ ...manifest, name: 'multigameassistant', productName: 'MultiGameAssistant', version, author: 'MultiGameAssistant' }, null, 2)}\n`)
mkdirSync(resources, { recursive: true })
writeFileSync(join(resources, 'icon.ico'), appIconIco())
copyFileSync(join(desktop, 'installer.nsh'), join(resources, 'installer.nsh'))

step(flag('--dir') ? 'electron-builder (unpacked only)' : 'electron-builder → NSIS installer')
const require = createRequire(join(desktop, 'package.json'))
const { build, Platform, Arch } = require('electron-builder')
const electronVersion = require('electron/package.json').version
// The runtime electron-builder copies: this machine's is the one in node_modules (pnpm setup:electron puts it in
// place, without downloading twice); another architecture's is unpacked beside the output.
const electronDist = arch === process.arch ? join(dirname(require.resolve('electron/package.json')), 'dist') : join(out, `electron-${arch}`)
if (arch === process.arch) {
  if (!existsSync(join(electronDist, 'electron.exe'))) run(process.execPath, [join(root, 'scripts', 'fetch-electron.mjs')])
} else {
  run(process.execPath, [join(root, 'scripts', 'fetch-electron.mjs'), '--arch', arch, '--to', electronDist])
}
if (machineOf(join(electronDist, 'electron.exe')) !== arch) throw new Error(`${join(electronDist, 'electron.exe')} is not a ${arch} build`)
const files = await build({
  projectDir: staging,
  targets: Platform.WINDOWS.createTarget(flag('--dir') ? 'dir' : 'nsis', Arch[arch]),
  config: {
    // The id from before the rename (AutoDailyGamePlay): Windows knows the installed app by it, so a new
    // version still replaces the old one instead of installing beside it. People never see it.
    appId: 'com.autodailygameplay.desktop',
    productName: 'MultiGameAssistant',
    executableName: 'MultiGameAssistant',
    copyright: 'MultiGameAssistant',
    directories: { output: out, buildResources: resources },
    electronDist,
    electronVersion,
    asar: false,
    npmRebuild: false,
    nodeGypRebuild: false,
    // node_modules is already exactly what runs (pnpm deploy --prod): take it whole.
    files: ['**/*'],
    // electron-builder still rebuilds the dependency tree from pnpm's metadata and leaves out packages dsh only
    // reaches through peer dependencies (28 of them, @deepseek-ai/cordis-plugin-group among them: the installed app
    // could not start). So the deployed node_modules goes over its copy, and every package is checked to be there.
    afterPack: async context => {
      const from = join(staging, 'node_modules')
      const to = join(context.appOutDir, 'resources', 'app', 'node_modules')
      cpSync(from, to, { recursive: true, force: true, filter: source => !/^\.(bin|pnpm|modules\.yaml)$/.test(source.slice(from.length + 1).split(/[\\/]/)[0] ?? '') })
      const missing = Object.keys(topLevelPackages(from)).filter(name => !existsSync(join(to, ...name.split('/'), 'package.json')))
      if (missing.length > 0) throw new Error(`packages missing from the packaged app: ${missing.join(', ')}`)
      console.log(`  node_modules: all ${Object.keys(topLevelPackages(from)).length} deployed packages are in the app`)
    },
    // Beside Electron's own LICENSE.electron.txt and LICENSES.chromium.html.
    extraFiles: [{ from: 'LICENSE', to: 'LICENSE.txt' }],
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
      artifactName: `MultiGameAssistant-Setup-\${version}${arch === 'x64' ? '' : `-${arch}`}.\${ext}`,
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

/** What a Windows binary (exe, dll, .node) is built for: 'x64', 'arm64', 'ia32', or undefined when it is not one. */
function machineOf(file) {
  try {
    const head = Buffer.alloc(4096)
    const fd = openSync(file, 'r')
    try { readSync(fd, head, 0, head.length, 0) } finally { closeSync(fd) }
    if (head.readUInt16LE(0) !== 0x5a4d) return undefined // MZ
    const pe = head.readUInt32LE(0x3c)
    return { 0x8664: 'x64', 0xaa64: 'arm64', 0x14c: 'ia32' }[head.readUInt16LE(pe + 4)]
  } catch {
    return undefined
  }
}

/**
 * Packages whose Windows native modules (.node) include none for `arch`
 * (one package may carry builds for several, like node-pty's prebuilds).
 * @returns their names, with the architectures they do have.
 */
function nativeMismatches(dir, arch) {
  const byPackage = new Map()
  const walk = (path, pkg) => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const full = join(path, entry.name)
      if (entry.isDirectory()) {
        // The nearest package.json above a file names its package.
        walk(full, existsSync(join(full, 'package.json')) ? full : pkg)
      } else if (entry.name.endsWith('.node')) {
        const machine = machineOf(full)
        if (machine === undefined) continue // another system's (an ELF or Mach-O prebuild)
        const found = byPackage.get(pkg) ?? new Set()
        found.add(machine)
        byPackage.set(pkg, found)
      }
    }
  }
  walk(dir, dir)
  return [...byPackage].filter(([, found]) => !found.has(arch)).map(([pkg, found]) => `${pkg.slice(dir.length + 1)} (${[...found].join(', ')})`)
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
