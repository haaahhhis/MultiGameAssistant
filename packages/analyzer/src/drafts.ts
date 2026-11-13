/**
 * Packs the agent writes. `save` validates one and puts it in use at once
 * (`pack_propose`: no waiting for the user), keeping the user pack it replaces
 * under `<dataDir>/pack-history/`. A draft is the same thing kept apart from
 * the packs in use until accepted: what `save` goes through, and what is left
 * from when the user accepted each one. Layout:
 * `<dataDir>/pack-drafts/<packId>/{adg.script.yaml, SKILL.md, draft.json}`;
 * accepting moves it to `<dataDir>/packs/<packId>/`.
 *
 * The history is what the user goes back to (`restore`, `discard`): each
 * version set aside is `<dataDir>/pack-history/<packId>/<when>/`, named by
 * the time it was replaced. Going back sets the pack in use aside the same
 * way, so going back can itself be undone.
 */
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MANIFEST_FILE, parseManifest, SKILL_FILE } from '@adg/pack-schema'

export interface DraftMeta {
  readonly packId: string
  readonly scriptId: string
  readonly proposedAt: number
  readonly sessionId?: string
  readonly summary: string
  /** The documents it was written from, and what each told (script-analysis: documentation first). */
  readonly docs?: readonly { source: string; used: string }[]
  /** Why there were none. */
  readonly noDocs?: string
}

export interface StoredDraft extends DraftMeta {
  readonly manifest: string
  readonly skill: string
}

/** A version of a user pack that was replaced. */
export interface PackVersion {
  /** Its folder in the history. */
  readonly id: string
  /** When it was replaced. */
  readonly at: number
  readonly manifest: string
}

/** A history folder's name: the time, with what a file name cannot hold replaced (2026-11-13T04-30-00-000Z). */
const WHEN = /^(\d{4}-\d{2}-\d{2}T\d{2})-(\d{2})-(\d{2})-(\d{3})Z$/

export class DraftStore {
  readonly #root: string
  readonly #packs: string
  readonly #history: string

  constructor(dataDir: string) {
    this.#root = join(dataDir, 'pack-drafts')
    this.#packs = join(dataDir, 'packs')
    this.#history = join(dataDir, 'pack-history')
  }

  /**
   * Validate and store a draft (replacing an earlier draft for the same pack).
   * @throws PackError naming every problem, so the agent can fix and retry.
   */
  async propose(meta: DraftMeta, manifest: string, skill: string): Promise<{ tasks: { id: string; title: string }[] }> {
    const parsed = parseManifest(manifest, `草稿 ${meta.packId}/${MANIFEST_FILE}`)
    if (parsed.id !== meta.packId) throw new Error(`脚本包的 id（${parsed.id}）必须等于 pack_id（${meta.packId}）`)
    if (!/^---\s*\n[\s\S]*?\bname:\s*\S+[\s\S]*?\bdescription:\s*\S[\s\S]*?\n---/.test(skill)) {
      throw new Error('SKILL.md 需要以 YAML frontmatter 开头，至少包含 name 和 description')
    }
    const dir = join(this.#root, meta.packId)
    await rm(dir, { recursive: true, force: true })
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, MANIFEST_FILE), manifest.endsWith('\n') ? manifest : `${manifest}\n`)
    await writeFile(join(dir, SKILL_FILE), skill.endsWith('\n') ? skill : `${skill}\n`)
    await writeFile(join(dir, 'draft.json'), `${JSON.stringify(meta, null, 2)}\n`)
    return { tasks: parsed.tasks.map(t => ({ id: t.id, title: t.title })) }
  }

  /**
   * Validate a pack and put it in use: the user's pack from now on, with no draft left waiting.
   * @returns `replaced`: a user pack of this id was there before (now in the history).
   * @throws PackError naming every problem; the pack in use is then untouched.
   */
  async save(meta: DraftMeta, manifest: string, skill: string, now = Date.now()): Promise<{ dir: string; tasks: { id: string; title: string }[]; replaced: boolean }> {
    const { tasks } = await this.propose(meta, manifest, skill)
    const { dir, replaced } = await this.accept(meta.packId, now)
    return { dir, tasks, replaced }
  }

  async list(): Promise<StoredDraft[]> {
    const out: StoredDraft[] = []
    for (const id of await readdir(this.#root).catch(() => [] as string[])) {
      const draft = await this.get(id).catch(() => undefined)
      if (draft !== undefined) out.push(draft)
    }
    return out.sort((a, b) => b.proposedAt - a.proposedAt)
  }

  async get(packId: string): Promise<StoredDraft> {
    const dir = join(this.#root, packId)
    const meta = JSON.parse(await readFile(join(dir, 'draft.json'), 'utf8')) as DraftMeta
    return { ...meta, manifest: await readFile(join(dir, MANIFEST_FILE), 'utf8'), skill: await readFile(join(dir, SKILL_FILE), 'utf8').catch(() => '') }
  }

  /** Install the draft as the user's pack. @returns the pack directory, and whether a user pack was there before. */
  async accept(packId: string, now = Date.now()): Promise<{ dir: string; meta: DraftMeta; replaced: boolean }> {
    const draft = await this.get(packId)
    parseManifest(draft.manifest) // still valid with the current schema
    const target = join(this.#packs, packId)
    const previous = await this.#aside(packId, now)
    await mkdir(this.#packs, { recursive: true })
    await rename(join(this.#root, packId), target)
    await rm(join(target, 'draft.json'), { force: true })
    return { dir: target, meta: draft, replaced: previous }
  }

  /** Move the user pack in use, if there is one, into the history. @returns whether there was one. */
  async #aside(packId: string, now: number): Promise<boolean> {
    const target = join(this.#packs, packId)
    if (!(await readdir(target).then(() => true, () => false))) return false
    const aside = join(this.#history, packId, new Date(now).toISOString().replace(/[:.]/g, '-'))
    await mkdir(join(this.#history, packId), { recursive: true })
    await cp(target, aside, { recursive: true })
    await rm(target, { recursive: true, force: true })
    return true
  }

  /** The versions of a user pack that were replaced, the last replaced first. */
  async history(packId: string): Promise<PackVersion[]> {
    const out: PackVersion[] = []
    for (const id of await readdir(join(this.#history, packId)).catch(() => [] as string[])) {
      const when = WHEN.exec(id)
      const manifest = when === null ? undefined : await readFile(join(this.#history, packId, id, MANIFEST_FILE), 'utf8').catch(() => undefined)
      if (when !== null && manifest !== undefined) out.push({ id, at: Date.parse(`${when[1]}:${when[2]}:${when[3]}.${when[4]}Z`), manifest })
    }
    return out.sort((a, b) => b.at - a.at)
  }

  /**
   * Put a replaced version back in use. The pack in use now goes into the
   * history in its place, so this can be undone the same way.
   * @throws Error when there is no such version, or it no longer fits the schema (nothing is changed then).
   */
  async restore(packId: string, versionId: string, now = Date.now()): Promise<{ dir: string }> {
    const from = join(this.#history, packId, versionId)
    const manifest = WHEN.test(versionId) ? await readFile(join(from, MANIFEST_FILE), 'utf8').catch(() => undefined) : undefined
    if (manifest === undefined) throw new Error(`历史里没有脚本包 ${packId} 的这个版本：${versionId}`)
    parseManifest(manifest, `历史版本 ${packId}/${MANIFEST_FILE}`)
    const target = join(this.#packs, packId)
    await this.#aside(packId, now)
    await mkdir(this.#packs, { recursive: true })
    await rename(from, target)
    return { dir: target }
  }

  /**
   * Stop using the user pack: it goes into the history, and the built-in pack
   * of the same id (when there is one) is the pack again.
   * @throws Error when there is no user pack of this id.
   */
  async discard(packId: string, now = Date.now()): Promise<void> {
    if (!(await this.#aside(packId, now))) throw new Error(`没有自己写的脚本包 ${packId}`)
  }

  async reject(packId: string): Promise<void> {
    await rm(join(this.#root, packId), { recursive: true, force: true })
  }
}
