/**
 * The sanctioned way for the agent to change a script's settings: only files
 * the pack lists under `config.files`, one value at a time, with the previous
 * file kept under `<dataDir>/config-history/<script>/<time>/`.
 */
import { copyFile, mkdir, readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { globToRegExp, type ScriptManifest } from '@adg/pack-schema'
import type { LibraryView } from './runs.ts'
import { applyPatches, inside } from './patch.ts'

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

function packFor(library: LibraryView, scriptId: string): { manifest: ScriptManifest; dir: string } {
  const script = library.get(scriptId)
  const pack = library.packOf(scriptId)
  if (pack === undefined) throw new Error(`${script.name} 没有脚本包，不知道哪些配置可以修改`)
  if (script.dir === undefined) throw new Error(`${script.name} 还没有安装`)
  return { manifest: pack.manifest, dir: script.dir }
}

export async function readConfig(library: LibraryView, scriptId: string, file: string): Promise<{ file: string; content: string; truncated: boolean }> {
  const { manifest, dir } = packFor(library, scriptId)
  allowed(manifest, file)
  const text = await readFile(inside(dir, file), 'utf8').catch(() => { throw new Error(`配置文件 ${file} 不存在；可能要先运行一次脚本生成它`) })
  return { file, content: text.slice(0, MAX_READ), truncated: text.length > MAX_READ }
}

export async function writeConfig(
  library: LibraryView, dataDir: string, scriptId: string, file: string, path: readonly (string | number)[], value: unknown, now = Date.now(),
): Promise<{ file: string; backup: string }> {
  const { manifest, dir } = packFor(library, scriptId)
  allowed(manifest, file)
  const source = inside(dir, file)
  const stamp = new Date(now).toISOString().replace(/[:.]/g, '-')
  const backup = join(dataDir, 'config-history', scriptId, stamp, file)
  await mkdir(dirname(backup), { recursive: true })
  await copyFile(source, backup).catch(() => { throw new Error(`配置文件 ${file} 不存在；可能要先运行一次脚本生成它`) })
  await applyPatches(dir, [{ file, required: true, set: [{ path: [...path], value }] }], join(dataDir, 'config-history', scriptId, stamp, '.applied'))
  return { file, backup }
}
