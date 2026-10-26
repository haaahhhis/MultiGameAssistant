#!/usr/bin/env node
/**
 * Install the Electron binary without Electron's native unzip helper.
 *
 * `electron/install.js` extracts with @electron-internal/extract-zip, a
 * native module that needs the Visual C++ runtime (vcruntime140.dll). Machines
 * without it (e.g. Windows LTSC) fail with "Cannot find native binding". This
 * script downloads the same checksummed archive through @electron/get and
 * unpacks it with the system `tar` (bsdtar ships with Windows 10+).
 *
 *   node scripts/fetch-electron.mjs [--force]
 *   node scripts/fetch-electron.mjs --arch arm64 --to <folder>
 *
 * With --to, Electron for that architecture (this system) is unpacked into
 * the folder only, for packaging (scripts/package-desktop.mjs --arch); the
 * Electron the repository runs stays as it is.
 */
import { execFileSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const require = createRequire(join(root, 'apps', 'desktop', 'package.json'))
const electronDir = dirname(require.resolve('electron/package.json'))
const { version } = require('electron/package.json')
const args = process.argv.slice(2)
const option = name => { const i = args.indexOf(name); return i === -1 ? undefined : args[i + 1] }
const to = option('--to')
const arch = option('--arch') ?? process.arch
const distDir = to === undefined ? join(electronDir, 'dist') : resolve(to)

const platformPath = { win32: 'electron.exe', darwin: 'Electron.app/Contents/MacOS/Electron', linux: 'electron' }[process.platform]
if (platformPath === undefined) throw new Error(`unsupported platform ${process.platform}`)
if (to === undefined && arch !== process.arch) throw new Error('--arch for another architecture needs --to: the Electron the repository runs must be this machine\'s')
if (existsSync(join(distDir, platformPath)) && !args.includes('--force')) {
  console.log(`electron ${version} already installed at ${distDir}`)
  process.exit(0)
}

const electronRequire = createRequire(join(electronDir, 'package.json'))
const { downloadArtifact } = await import(pathToFileURL(electronRequire.resolve('@electron/get')).href)
console.log(`downloading electron ${version} for ${process.platform}-${arch}…`)
const zip = await downloadArtifact({
  version,
  artifactName: 'electron',
  platform: process.platform,
  arch,
  checksums: electronRequire('./checksums.json'),
})

rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })
// On Windows use the system bsdtar explicitly: a GNU tar earlier on PATH (Git Bash)
// reads "C:" as a remote host and cannot open zip archives.
const tar = process.platform === 'win32' ? join(process.env.SystemRoot ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar'
execFileSync(tar, ['-xf', zip, '-C', distDir], { stdio: 'inherit' })
if (to === undefined) writeFileSync(join(electronDir, 'path.txt'), platformPath)
console.log(`electron ${version} installed at ${distDir}`)
