/**
 * Local config profiles, the AUTO-MAS way: MultiGameAssistant keeps its own
 * copies of a script's declared config files and never changes the original
 * project's configuration for good. A script can have several named copies
 * (profiles: another account, another set of tasks); runs and pipeline steps
 * pick one, or use the script's current one.
 *
 *   <dataDir>/configs/<script>/files/<relative path>   the 「默认」 profile's copy
 *   <dataDir>/configs/<script>/profile.json            when it was imported, and the
 *                                                      originals' hashes at that time
 *   <dataDir>/configs/<script>/profiles/<id>/…         the same for every other profile
 *   <dataDir>/configs/<script>/profiles.json           names, and which one is current
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
import { copyFile, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
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

/** The profile every script has; its files are where the single local copy always was. */
export const DEFAULT_PROFILE = 'default'
const MAX_PROFILES = 20

export interface ProfileEntry {
  readonly id: string
  readonly name: string
  readonly createdAt?: number
}

export interface ProfileList {
  /** What runs use when they name no profile. */
  readonly current: string
  readonly items: ProfileEntry[]
}

/** Where a new profile's files come from. */
export type ProfileSource =
  | { readonly kind: 'copy'; readonly profile: string }
  | { readonly kind: 'original' }
  /** Another folder laid out like the script's (another copy of it, or saved config files). */
  | { readonly kind: 'folder'; readonly dir: string }

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

  /** The folder holding a profile's copy and its profile.json. */
  #base(scriptId: string, profile: string): string {
    return profile === DEFAULT_PROFILE ? join(this.#root, scriptId) : join(this.#root, scriptId, 'profiles', profile)
  }

  filesDir(scriptId: string, profile = DEFAULT_PROFILE): string {
    return join(this.#base(scriptId, profile), 'files')
  }

  /** The script's profiles; 「默认」 always exists. */
  async list(scriptId: string): Promise<ProfileList> {
    let stored: { current?: string; items?: ProfileEntry[] } = {}
    try {
      stored = JSON.parse(await readFile(join(this.#root, scriptId, 'profiles.json'), 'utf8')) as typeof stored
    } catch { /* only 默认 */ }
    const items = (stored.items ?? []).filter(i => typeof i.id === 'string' && typeof i.name === 'string')
    if (!items.some(i => i.id === DEFAULT_PROFILE)) items.unshift({ id: DEFAULT_PROFILE, name: '默认' })
    const current = items.some(i => i.id === stored.current) ? stored.current! : DEFAULT_PROFILE
    return { current, items }
  }

  /**
   * The profile id `ref` names (an id or a name; undefined: the current one).
   * @throws Error naming the script's profiles when there is no such profile.
   */
  async resolve(scriptId: string, ref?: string): Promise<ProfileEntry> {
    const { current, items } = await this.list(scriptId)
    const wanted = ref === undefined || ref === '' ? current : ref.trim()
    const found = items.find(i => i.id === wanted) ?? items.find(i => i.name === wanted)
    if (found === undefined) throw new Error(`没有叫「${wanted}」的配置；现有：${items.map(i => i.name).join('、')}`)
    return found
  }

  /**
   * Save a new profile.
   * @throws Error for a taken or empty name, too many profiles, or a source with none of the config files.
   */
  async create(scriptId: string, scriptDir: string, manifest: ScriptManifest, name: string, source: ProfileSource, now = Date.now()): Promise<{ profile: ProfileEntry; files: string[] }> {
    const list = await this.list(scriptId)
    const clean = checkName(name, list.items)
    if (list.items.length >= MAX_PROFILES) throw new Error(`一个脚本最多 ${MAX_PROFILES} 份配置`)
    const id = `p${now.toString(36)}${Math.random().toString(36).slice(2, 5)}`
    const profile: ProfileEntry = { id, name: clean, createdAt: now }
    let files: string[]
    if (source.kind === 'copy') {
      const from = (await this.resolve(scriptId, source.profile)).id
      await this.ensure(scriptId, scriptDir, manifest, now, from)
      await mkdir(this.#base(scriptId, id), { recursive: true })
      await cp(this.filesDir(scriptId, from), this.filesDir(scriptId, id), { recursive: true }).catch(error => {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      })
      const meta = await this.#meta(scriptId, from)
      if (meta !== undefined) await this.#writeMeta(scriptId, id, meta)
      files = []
      for (const file of await declaredFiles(manifest, [this.filesDir(scriptId, id)])) {
        if (await readBytes(inside(this.filesDir(scriptId, id), file)) !== undefined) files.push(file)
      }
    } else {
      const dir = source.kind === 'original' ? scriptDir : source.dir
      if (source.kind === 'folder' && !(await stat(dir).then(s => s.isDirectory(), () => false))) throw new Error(`找不到文件夹 ${dir}`)
      files = await this.importFromOriginal(scriptId, dir, manifest, now, id, source.kind === 'folder' ? scriptDir : undefined)
      if (files.length === 0) {
        await rm(this.#base(scriptId, id), { recursive: true, force: true })
        const declared = manifest.config.files.map(f => f.path).join('、')
        throw new Error(source.kind === 'folder' ? `${dir} 里没有这个脚本的配置文件（${declared}）` : `原项目里还没有配置文件（${declared}）：先在脚本里保存一次设置`)
      }
    }
    await this.#writeList(scriptId, { current: list.current, items: [...list.items, profile] })
    return { profile, files }
  }

  async rename(scriptId: string, ref: string, name: string): Promise<ProfileEntry> {
    const list = await this.list(scriptId)
    const target = await this.resolve(scriptId, ref)
    const clean = checkName(name, list.items.filter(i => i.id !== target.id))
    const renamed = { ...target, name: clean }
    await this.#writeList(scriptId, { current: list.current, items: list.items.map(i => (i.id === target.id ? renamed : i)) })
    return renamed
  }

  /** Make a profile the one runs use when they name none. */
  async setCurrent(scriptId: string, ref: string): Promise<ProfileEntry> {
    const list = await this.list(scriptId)
    const target = await this.resolve(scriptId, ref)
    await this.#writeList(scriptId, { current: target.id, items: list.items })
    return target
  }

  /** @throws Error for 「默认」, which every script keeps. */
  async remove(scriptId: string, ref: string): Promise<void> {
    const list = await this.list(scriptId)
    const target = await this.resolve(scriptId, ref)
    if (target.id === DEFAULT_PROFILE) throw new Error('「默认」配置不能删除')
    await rm(this.#base(scriptId, target.id), { recursive: true, force: true })
    await this.#writeList(scriptId, { current: list.current === target.id ? DEFAULT_PROFILE : list.current, items: list.items.filter(i => i.id !== target.id) })
  }

  async status(scriptId: string, scriptDir: string, manifest: ScriptManifest, profile = DEFAULT_PROFILE): Promise<ProfileStatus> {
    const meta = await this.#meta(scriptId, profile)
    const localDir = this.filesDir(scriptId, profile)
    const names = await declaredFiles(manifest, [scriptDir, localDir])
    const files: ProfileFile[] = []
    for (const file of names) {
      const original = await readBytes(inside(scriptDir, file))
      const local = await readBytes(inside(localDir, file))
      const changed = meta !== undefined && hash(original) !== (meta.hashes[file] ?? null)
      files.push({ file, local: local !== undefined, original: original !== undefined, changed })
    }
    return { ...(meta === undefined ? {} : { importedAt: meta.importedAt }), files, drift: files.filter(f => f.changed).map(f => f.file) }
  }

  /** Create the local copy from the original the first time it is needed. */
  async ensure(scriptId: string, scriptDir: string, manifest: ScriptManifest, now = Date.now(), profile = DEFAULT_PROFILE): Promise<boolean> {
    if (await this.#meta(scriptId, profile) !== undefined) return false
    await this.importFromOriginal(scriptId, scriptDir, manifest, now, profile)
    return true
  }

  /**
   * Replace a profile's copy with the config files in `fromDir` (the script's own directory,
   * or another folder laid out the same way). Drift is judged against `scriptDir`'s files.
   */
  async importFromOriginal(scriptId: string, fromDir: string, manifest: ScriptManifest, now = Date.now(), profile = DEFAULT_PROFILE, scriptDir = fromDir): Promise<string[]> {
    const dir = this.filesDir(scriptId, profile)
    await rm(dir, { recursive: true, force: true })
    const names = await declaredFiles(manifest, fromDir === scriptDir ? [fromDir] : [fromDir, scriptDir])
    const hashes: Record<string, string | null> = {}
    const copied: string[] = []
    for (const file of names) {
      const bytes = await readBytes(inside(fromDir, file))
      hashes[file] = hash(fromDir === scriptDir ? bytes : await readBytes(inside(scriptDir, file)))
      if (bytes === undefined) continue
      const target = inside(dir, file)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
      copied.push(file)
    }
    await this.#writeMeta(scriptId, profile, { importedAt: now, hashes })
    return copied
  }

  async read(scriptId: string, scriptDir: string, manifest: ScriptManifest, file: string, profile = DEFAULT_PROFILE): Promise<string> {
    await this.ensure(scriptId, scriptDir, manifest, Date.now(), profile)
    const bytes = await readBytes(inside(this.filesDir(scriptId, profile), file))
    if (bytes === undefined) throw new Error(`本地配置里还没有 ${file}：脚本可能还没生成它。可以先「打开脚本修改设置」，在脚本里保存一次`)
    return bytes.toString('utf8')
  }

  /**
   * Set one value in the local copy; the previous local file goes to `historyDir`.
   * @throws Error when the local copy has no such file yet.
   */
  async write(scriptId: string, scriptDir: string, manifest: ScriptManifest, file: string, path: readonly (string | number)[], value: unknown, historyDir: string, profile = DEFAULT_PROFILE): Promise<void> {
    const text = await this.read(scriptId, scriptDir, manifest, file, profile)
    const target = inside(this.filesDir(scriptId, profile), file)
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
  async inject(scriptId: string, scriptDir: string, manifest: ScriptManifest, patches: readonly ConfigPatch[], backupDir: string, profile = DEFAULT_PROFILE): Promise<Injection> {
    await this.ensure(scriptId, scriptDir, manifest, Date.now(), profile)
    const { drift } = await this.status(scriptId, scriptDir, manifest, profile)
    const localDir = this.filesDir(scriptId, profile)
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

  async #meta(scriptId: string, profile: string): Promise<Meta | undefined> {
    try {
      return JSON.parse(await readFile(join(this.#base(scriptId, profile), 'profile.json'), 'utf8')) as Meta
    } catch {
      return undefined
    }
  }

  async #writeMeta(scriptId: string, profile: string, meta: Meta): Promise<void> {
    await mkdir(this.#base(scriptId, profile), { recursive: true })
    await writeFile(join(this.#base(scriptId, profile), 'profile.json'), `${JSON.stringify(meta, null, 2)}\n`)
  }

  async #writeList(scriptId: string, list: ProfileList): Promise<void> {
    await mkdir(join(this.#root, scriptId), { recursive: true })
    await writeFile(join(this.#root, scriptId, 'profiles.json'), `${JSON.stringify(list, null, 2)}\n`)
  }
}

function checkName(name: string, others: readonly ProfileEntry[]): string {
  const clean = name.trim()
  if (clean === '' || clean.length > 30) throw new Error('配置名要 1 到 30 个字')
  if (others.some(i => i.name === clean)) throw new Error(`已经有叫「${clean}」的配置了`)
  return clean
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
