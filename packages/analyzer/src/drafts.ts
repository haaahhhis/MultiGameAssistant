/**
 * Pack drafts: what the agent proposed, kept apart from packs in use until
 * the user accepts. Layout:
 * `<dataDir>/pack-drafts/<packId>/{adg.script.yaml, SKILL.md, draft.json}`.
 * Accepting moves the draft to `<dataDir>/packs/<packId>/`, keeping the
 * previous user pack under `<dataDir>/pack-history/`.
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

  /** Install the draft as the user's pack. @returns the pack directory. */
  async accept(packId: string, now = Date.now()): Promise<{ dir: string; meta: DraftMeta }> {
    const draft = await this.get(packId)
    parseManifest(draft.manifest) // still valid with the current schema
    const target = join(this.#packs, packId)
    const previous = await readdir(target).then(() => true, () => false)
    if (previous) {
      const aside = join(this.#history, packId, new Date(now).toISOString().replace(/[:.]/g, '-'))
      await mkdir(join(this.#history, packId), { recursive: true })
      await cp(target, aside, { recursive: true })
      await rm(target, { recursive: true, force: true })
    }
    await mkdir(this.#packs, { recursive: true })
    await rename(join(this.#root, packId), target)
    await rm(join(target, 'draft.json'), { force: true })
    return { dir: target, meta: draft }
  }

  async reject(packId: string): Promise<void> {
    await rm(join(this.#root, packId), { recursive: true, force: true })
  }
}
