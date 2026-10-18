/**
 * The agent's way to read and change a script's settings: the local config
 * copy (docs/PLAN.zh.md §5.7), never the original project's files. Only files
 * the pack lists under `config.files`; each write keeps the previous local
 * file under `<dataDir>/config-history/<script>/<time>/`.
 */
import { join } from 'node:path'
import { globToRegExp, type ScriptManifest } from '@adg/pack-schema'
import type { ConfigProfiles, ProfileStatus } from './profiles.ts'
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

export async function readConfig(library: LibraryView, profiles: ConfigProfiles, scriptId: string, file: string): Promise<{ file: string; content: string; truncated: boolean; copy: 'local' }> {
  const { manifest, dir } = packFor(library, scriptId)
  allowed(manifest, file)
  const text = await profiles.read(scriptId, dir, manifest, file)
  return { file, content: text.slice(0, MAX_READ), truncated: text.length > MAX_READ, copy: 'local' }
}

export async function writeConfig(
  library: LibraryView, profiles: ConfigProfiles, dataDir: string, scriptId: string, file: string, path: readonly (string | number)[], value: unknown, now = Date.now(),
): Promise<{ file: string; backup: string; copy: 'local' }> {
  const { manifest, dir } = packFor(library, scriptId)
  allowed(manifest, file)
  const historyDir = join(dataDir, 'config-history', scriptId, new Date(now).toISOString().replace(/[:.]/g, '-'))
  await profiles.write(scriptId, dir, manifest, file, path, value, historyDir)
  return { file, backup: join(historyDir, file), copy: 'local' }
}

export async function configStatus(library: LibraryView, profiles: ConfigProfiles, scriptId: string): Promise<ProfileStatus & { dir: string }> {
  const { manifest, dir } = packFor(library, scriptId)
  await profiles.ensure(scriptId, dir, manifest)
  return { ...(await profiles.status(scriptId, dir, manifest)), dir: profiles.filesDir(scriptId) }
}

export async function importConfig(library: LibraryView, profiles: ConfigProfiles, scriptId: string): Promise<string[]> {
  const { manifest, dir } = packFor(library, scriptId)
  return profiles.importFromOriginal(scriptId, dir, manifest)
}
