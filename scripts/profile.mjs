/**
 * Shared profile setup: make `<home>/profiles/adg` boot
 * dsh-base → dsh-web-app → @adg/bundle, with the local bundle linked in
 * place. Used by `pnpm dev:home` and by the Electron shell on every start.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
} from 'node:fs'
import { join, resolve } from 'node:path'

const BUNDLE = '@adg/bundle'

/**
 * @param {object} options
 * @param {string} options.home - DSH_HOME directory.
 * @param {string} options.bundleDir - directory of @adg/bundle.
 * @param {string} options.dshBin - path to `@deepseek-ai/dsh/lib/bin.js`.
 * @param {string} [options.node] - JS runtime executing dshBin (default: this process).
 * @param {Record<string, string>} [options.env] - extra environment (e.g. ELECTRON_RUN_AS_NODE).
 * @returns {string} the profile directory.
 */
export function prepareAdgProfile({ home, bundleDir, dshBin, node = process.execPath, env = {} }) {
  const profile = join(home, 'profiles', 'adg')
  if (!existsSync(join(profile, 'package.json'))) {
    execFileSync(node, [dshBin, 'adg', '--from-default-profile', 'web', '--help'], {
      env: { ...process.env, ...env, DSH_HOME: home },
      stdio: 'ignore',
    })
  }

  const manifestPath = join(profile, 'package.json')
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))
  const bundles = manifest.dsh.profile.bundles.filter(b => b !== BUNDLE)
  manifest.dsh.profile.bundles = [...bundles, BUNDLE]
  manifest.dependencies = { ...manifest.dependencies, [BUNDLE]: `link:${bundleDir.replaceAll('\\', '/')}` }
  writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)

  const linkDir = join(profile, 'node_modules', '@adg')
  mkdirSync(linkDir, { recursive: true })
  ensureLink(bundleDir, join(linkDir, 'bundle'))
  return profile
}

/**
 * Point `link` at `target` (a junction on Windows, which needs no elevation).
 *
 * Never removes recursively: a recursive delete of a junction follows it and
 * empties the target. An existing link is left alone when it already points
 * at `target`, otherwise only the link entry itself is removed; a real file or
 * directory at `link` is refused.
 */
export function ensureLink(target, link) {
  let stat
  try {
    stat = lstatSync(link)
  } catch {
    stat = undefined
  }
  if (stat !== undefined) {
    if (!stat.isSymbolicLink()) throw new Error(`refusing to replace ${link}: it is not a link`)
    if (samePath(readlinkSync(link), target)) return
    try {
      unlinkSync(link)
    } catch {
      rmdirSync(link) // non-recursive: removes the junction entry only
    }
  }
  symlinkSync(target, link, 'junction')
}

function samePath(a, b) {
  const norm = p => resolve(p.replace(/^\\\\\?\\/, '')).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}
