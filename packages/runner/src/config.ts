/**
 * The agent's way to read and change a script's settings: the local config
 * copy, never the original project's files. Only files
 * the pack lists under `config.files`; each write keeps the previous local
 * file under `<dataDir>/config-history/<script>/<time>/`. `profile` picks
 * one of the script's config profiles (id or name; default: the current one).
 */
import { join } from 'node:path'
import { globToRegExp, type ScriptManifest } from '@adg/pack-schema'
import { DEFAULT_PROFILE, type ConfigProfiles, type ProfileEntry, type ProfileStatus } from './profiles.ts'
import type { LibraryView } from './runs.ts'

const MAX_READ = 60_000

/** The declared config file matching `file`, or an error naming the allowed ones. */
function allowed(manifest: ScriptManifest, file: string): void {
  const normalized = file.replace(/\\/g, '/')
  const ok = manifest.config.files.some(entry => globToRegExp(entry.path.replace(/\\/g, '/')).test(normalized))
  if (!ok) {
    const list = manifest.config.files.map(f => f.path).join('、')
    throw new Error(list === '' ? `${manifest.name} 的脚本包没有声明可修改的配置文件` : `只能修改脚本包声明的配置文件：${list}`)
  }
}

export function packFor(library: LibraryView, scriptId: string): { manifest: ScriptManifest; dir: string } {
  const script = library.get(scriptId)
  const pack = library.packOf(scriptId)
  if (pack === undefined) throw new Error(`${script.name} 没有脚本包，不知道哪些配置可以修改`)
  if (script.dir === undefined) throw new Error(`${script.name} 还没有安装`)
  return { manifest: pack.manifest, dir: script.dir }
}

export async function readConfig(library: LibraryView, profiles: ConfigProfiles, scriptId: string, file: string, profileRef?: string): Promise<{ file: string; content: string; truncated: boolean; copy: 'local'; profile: string }> {
  const { manifest, dir } = packFor(library, scriptId)
  allowed(manifest, file)
  const profile = await profiles.resolve(scriptId, profileRef)
  const text = await profiles.read(scriptId, dir, manifest, file, profile.id)
  return { file, content: text.slice(0, MAX_READ), truncated: text.length > MAX_READ, copy: 'local', profile: profile.name }
}

export async function writeConfig(
  library: LibraryView, profiles: ConfigProfiles, dataDir: string, scriptId: string, file: string, path: readonly (string | number)[], value: unknown, now = Date.now(), profileRef?: string,
): Promise<{ file: string; backup: string; copy: 'local'; profile: string }> {
  const { manifest, dir } = packFor(library, scriptId)
  allowed(manifest, file)
  const profile = await profiles.resolve(scriptId, profileRef)
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const historyDir = join(dataDir, 'config-history', scriptId, profile.id === DEFAULT_PROFILE ? stamp : `${stamp}-${profile.id}`)
  await profiles.write(scriptId, dir, manifest, file, path, value, historyDir, profile.id)
  return { file, backup: join(historyDir, file), copy: 'local', profile: profile.name }
}

export async function configStatus(library: LibraryView, profiles: ConfigProfiles, scriptId: string, profileRef?: string): Promise<ProfileStatus & { dir: string; profile: ProfileEntry }> {
  const { manifest, dir } = packFor(library, scriptId)
  const profile = await profiles.resolve(scriptId, profileRef)
  await profiles.ensure(scriptId, dir, manifest, Date.now(), profile.id)
  return { ...(await profiles.status(scriptId, dir, manifest, profile.id)), dir: profiles.filesDir(scriptId, profile.id), profile }
}

export async function importConfig(library: LibraryView, profiles: ConfigProfiles, scriptId: string, profileRef?: string): Promise<string[]> {
  const { manifest, dir } = packFor(library, scriptId)
  const profile = await profiles.resolve(scriptId, profileRef)
  return profiles.importFromOriginal(scriptId, dir, manifest, Date.now(), profile.id)
}
