/**
 * Shared profile setup: make `<home>/profiles/adg` boot
 * dsh-base → dsh-web-app → @adg/bundle, with the local bundle linked in
 * place. Used by the Electron shell on every start (from the repository or
 * installed) and by `pnpm dev:home`.
 */
import { execFileSync } from 'node:child_process'
import {
  existsSync, lstatSync, mkdirSync, readFileSync, readlinkSync, renameSync, rmdirSync, symlinkSync, unlinkSync, writeFileSync,
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
    // Left half-made by an earlier start that did not finish: dsh refuses an existing folder, so move it aside.
    if (existsSync(profile)) renameSync(profile, `${profile}.unfinished-${Date.now()}`)
    try {
      execFileSync(node, [dshBin, 'adg', '--from-default-profile', 'web', '--help'], {
        env: { ...process.env, ...env, DSH_HOME: home },
        stdio: ['ignore', 'pipe', 'pipe'],
        encoding: 'utf8',
        windowsHide: true,
      })
    } catch (error) {
      // Say why: dsh's own last words, not just "Command failed".
      const said = `${error?.stderr ?? ''}\n${error?.stdout ?? ''}`.split(/\r?\n/).filter(line => line.trim() !== '' && !/^\s+at /.test(line)).slice(-8).join('\n')
      throw new Error(`创建 dsh 配置（${profile}）失败：${said || String(error)}`, { cause: error })
    }
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
  mkdirSync(agentWorkspace(home), { recursive: true })
  return profile
}

/**
 * The agent's working folder (the bundle points dsh's working-directory row
 * at it). Kept apart from the app on purpose: dsh's Windows sandbox labels
 * the working folder low-integrity for good, and a program started from a
 * low-labeled folder (the desktop app's own Electron) runs at low integrity
 * and fails.
 */
export function agentWorkspace(home) {
  return process.env.ADG_WORKSPACE_DIR || join(home, 'adg', 'workspace')
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
