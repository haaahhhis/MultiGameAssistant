/**
 * Local config profiles, the AUTO-MAS way: AutoDailyGamePlay keeps its own
 * copy of a script's declared config files and never changes the original
 * project's configuration for good.
 *
 *   <dataDir>/configs/<script>/files/<relative path>   the local copy (what runs use)
 *   <dataDir>/configs/<script>/profile.json            when it was imported, and the
 *                                                      originals' hashes at that time
 *
 * - Agent edits (`script_config_set`) change the local copy only.
 * - A run injects the local copy (plus the task's temporary patches) into the
 *   script directory and puts the original bytes back afterwards; whatever
 *   the script wrote meanwhile is discarded.
 * - A settings session injects the local copy, opens the script's own window
 *   for the user, then saves what the script wrote back into the local copy
 *   before restoring the original.
 * - If the original changed since the import (the user edited settings in the
 *   script's own window), that is reported as drift; importing again is the
 *   user's call.
 */
import { createHash } from 'node:crypto'
import { copyFile, mkdir, readdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { globToRegExp, type ConfigPatch, type ScriptManifest } from '@adg/pack-schema'
import { editText, inside } from './patch.ts'

export interface ProfileFile {
  readonly file: string
  /** Present in the local copy. */
  readonly local: boolean
  /** Present in the script directory. */
  readonly original: boolean
  /** The original differs from what it was when the local copy was imported. */
  readonly changed: boolean
}

export interface ProfileStatus {
  readonly importedAt?: number
  readonly files: readonly ProfileFile[]
  /** Files whose original changed since the import. */
  readonly drift: readonly string[]
}

export interface Injection {
  /** Files written into the script directory for this run. */
  readonly files: readonly string[]
  /** Patched files that exist in neither copy (skipped). */
  readonly skipped: readonly string[]
  readonly drift: readonly string[]
  /** Copy the script's current config files into the local copy (after a settings session). */
  saveBack(): Promise<string[]>
  /** Put the original bytes back; delete files that did not exist before. Safe to call twice. */
  restore(): Promise<void>
}

interface Meta {
  importedAt: number
  /** sha256 of each original file at import; `null` = it did not exist. */
  hashes: Record<string, string | null>
}

export class ConfigProfiles {
  readonly #root: string

  constructor(dataDir: string) {
    this.#root = join(dataDir, 'configs')
  }

  filesDir(scriptId: string): string {
    return join(this.#root, scriptId, 'files')
  }

  async status(scriptId: string, scriptDir: string, manifest: ScriptManifest): Promise<ProfileStatus> {
    const meta = await this.#meta(scriptId)
    const names = await declaredFiles(manifest, [scriptDir, this.filesDir(scriptId)])
    const files: ProfileFile[] = []
    for (const file of names) {
      const original = await readBytes(inside(scriptDir, file))
      const local = await readBytes(inside(this.filesDir(scriptId), file))
      const changed = meta !== undefined && hash(original) !== (meta.hashes[file] ?? null)
      files.push({ file, local: local !== undefined, original: original !== undefined, changed })
    }
    return { ...(meta === undefined ? {} : { importedAt: meta.importedAt }), files, drift: files.filter(f => f.changed).map(f => f.file) }
  }

  /** Create the local copy from the original the first time it is needed. */
  async ensure(scriptId: string, scriptDir: string, manifest: ScriptManifest, now = Date.now()): Promise<boolean> {
    if (await this.#meta(scriptId) !== undefined) return false
    await this.importFromOriginal(scriptId, scriptDir, manifest, now)
    return true
  }

  /** Replace the local copy with the script's current config files. */
  async importFromOriginal(scriptId: string, scriptDir: string, manifest: ScriptManifest, now = Date.now()): Promise<string[]> {
    const dir = this.filesDir(scriptId)
    await rm(dir, { recursive: true, force: true })
    const names = await declaredFiles(manifest, [scriptDir])
    const hashes: Record<string, string | null> = {}
    const copied: string[] = []
    for (const file of names) {
      const bytes = await readBytes(inside(scriptDir, file))
      hashes[file] = hash(bytes)
      if (bytes === undefined) continue
      const target = inside(dir, file)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      copied.push(file)
    }
    await this.#writeMeta(scriptId, { importedAt: now, hashes })
    return copied
  }

  async read(scriptId: string, scriptDir: string, manifest: ScriptManifest, file: string): Promise<string> {
    await this.ensure(scriptId, scriptDir, manifest)
    const bytes = await readBytes(inside(this.filesDir(scriptId), file))
    if (bytes === undefined) throw new Error(`本地配置里还没有 ${file}：脚本可能还没生成它。可以先「打开脚本修改设置」，在脚本里保存一次`)
    return bytes.toString('utf8')
  }

  /**
   * Set one value in the local copy; the previous local file goes to `historyDir`.
   * @throws Error when the local copy has no such file yet.
   */
  async write(scriptId: string, scriptDir: string, manifest: ScriptManifest, file: string, path: readonly (string | number)[], value: unknown, historyDir: string): Promise<void> {
    const text = await this.read(scriptId, scriptDir, manifest, file)
    const target = inside(this.filesDir(scriptId), file)
    const backup = inside(historyDir, file)
    await mkdir(dirname(backup), { recursive: true })
    await copyFile(target, backup)
    await writeFile(target, editText(file, text, [{ path: [...path], value }]))
  }

  /**
   * Put the local copy, plus `patches`, into the script directory for a run.
   * Originals are also copied to `backupDir` first, so a crash still leaves a way back.
   * @throws Error for a required patched file that exists nowhere; nothing is left changed.
   */
  async inject(scriptId: string, scriptDir: string, manifest: ScriptManifest, patches: readonly ConfigPatch[], backupDir: string): Promise<Injection> {
    await this.ensure(scriptId, scriptDir, manifest)
    const { drift } = await this.status(scriptId, scriptDir, manifest)
    const localDir = this.filesDir(scriptId)
    const declared = await declaredFiles(manifest, [scriptDir, localDir])
    const names = [...new Set([...declared, ...patches.map(p => p.file)])]

    const originals = new Map<string, Buffer | undefined>()
    const finals = new Map<string, string | Buffer>()
    const skipped: string[] = []
    for (const file of names) {
      const original = await readBytes(inside(scriptDir, file))
      originals.set(file, original)
      const local = declared.includes(file) ? await readBytes(inside(localDir, file)) : undefined
      const base = local ?? original
      const ops = patches.filter(p => p.file === file).flatMap(p => p.set)
      if (base === undefined) {
        if (patches.some(p => p.file === file && p.required)) throw new Error(`缺少配置文件 ${file}；请先「打开脚本修改设置」，让脚本生成并保存一次配置`)
        if (ops.length > 0) skipped.push(file)
        continue
      }
      if (ops.length > 0) finals.set(file, editText(file, base.toString('utf8'), ops))
      else if (local !== undefined && (original === undefined || !local.equals(original))) finals.set(file, local)
    }

    for (const [file, bytes] of originals) {
      if (bytes === undefined) continue
      const backup = inside(backupDir, file)
      await mkdir(dirname(backup), { recursive: true })
      await writeFile(backup, bytes)
    }
    const written: string[] = []
    let restored = false
    // Every declared file goes back to its original bytes, whether we wrote it or
    // the script did during the run; declared files the run created are removed.
    const restore = async () => {
      if (restored) return
      restored = true
      const current = await declaredFiles(manifest, [scriptDir])
      for (const file of new Set([...originals.keys(), ...current])) {
        const original = originals.get(file)
        const path = inside(scriptDir, file)
        const now = await readBytes(path)
        if (original === undefined) {
          if (now !== undefined) await rm(path, { force: true })
        } else if (now === undefined || !now.equals(original)) {
          await mkdir(dirname(path), { recursive: true })
          await writeFile(path, original)
        }
      }
    }
    try {
      for (const [file, content] of finals) {
        const path = inside(scriptDir, file)
        await mkdir(dirname(path), { recursive: true })
        await writeFile(path, content)
        written.push(file)
      }
    } catch (error) {
      await restore()
      throw error
    }

    const saveBack = async () => {
      const saved: string[] = []
      for (const file of await declaredFiles(manifest, [scriptDir])) {
        const bytes = await readBytes(inside(scriptDir, file))
        if (bytes === undefined) continue
        const target = inside(localDir, file)
        await mkdir(dirname(target), { recursive: true })
        await writeFile(target, bytes)
        saved.push(file)
      }
      return saved
    }
    return { files: [...written], skipped, drift, saveBack, restore }
  }

  async #meta(scriptId: string): Promise<Meta | undefined> {
    try {
      return JSON.parse(await readFile(join(this.#root, scriptId, 'profile.json'), 'utf8')) as Meta
    } catch {
      return undefined
    }
  }

  async #writeMeta(scriptId: string, meta: Meta): Promise<void> {
    await mkdir(join(this.#root, scriptId), { recursive: true })
    await writeFile(join(this.#root, scriptId, 'profile.json'), `${JSON.stringify(meta, null, 2)}\n`)
  }
}

/** The pack's declared config files that exist in any of `dirs` (`*` expands within one segment). */
export async function declaredFiles(manifest: ScriptManifest, dirs: readonly string[]): Promise<string[]> {
  const names = new Set<string>()
  for (const entry of manifest.config.files) {
    const parts = entry.path.replace(/\\/g, '/').split('/')
    const last = parts.pop()!
    const sub = parts.join('/')
    if (!last.includes('*') && !last.includes('?')) {
      names.add(entry.path.replace(/\\/g, '/'))
      continue
    }
    const pattern = globToRegExp(last)
    for (const dir of dirs) {
      for (const name of await readdir(join(dir, sub)).catch(() => [] as string[])) {
        if (pattern.test(name)) names.add(sub === '' ? name : `${sub}/${name}`)
      }
    }
  }
  return [...names].sort()
}

async function readBytes(path: string): Promise<Buffer | undefined> {
  return readFile(path).catch(() => undefined)
}

function hash(bytes: Buffer | undefined): string | null {
  return bytes === undefined ? null : createHash('sha256').update(bytes).digest('hex')
}
