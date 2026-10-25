/**
 * The skills repository (技能库): skills for particular games and scripts
 * that MultiGameAssistant does not ship, downloaded when the user wants them
 * from a GitHub repository (default `MultiGameAssistant/skills`).
 *
 * - The repository is read as one zip (no git needed; through the download
 *   mirror), at most once a day unless asked. Its `index.json` lists the
 *   skills (`name`, `path`, `kind`, `games`, `scripts`); without one every
 *   `SKILL.md` in it is a skill. A skill's description is its frontmatter's.
 * - A downloaded skill lives in `<dataDir>/skill-hub/skills/<name>/` with a
 *   copy of what was downloaded (`base/`), so the user may change it: an
 *   update replaces it only when it is unchanged; changed, the user keeps
 *   theirs, takes the new one (theirs kept as a backup), or has the agent
 *   merge the two.
 * - The user's own skills (`skill_save`, their folders) are not tracked here,
 *   and a skill named like one of them, or like a core skill, is not taken.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@adg/protocol/node'
import { z } from 'zod'

export const DEFAULT_HUB_REPO = { repo: 'MultiGameAssistant/skills', branch: 'main' } as const

/** The repository is read again after this long. */
const REFRESH_MS = 24 * 60 * 60_000
const SKILL_FILE = 'SKILL.md'
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface HubRepo { readonly repo: string; readonly branch: string }

export interface HubSkill {
  readonly name: string
  readonly description: string
  readonly title?: string
  /** `game`: a game's guide; `script`: a script's; `general`. */
  readonly kind: 'game' | 'script' | 'general'
  /** Game ids (game packs) and script / pack ids it is for. */
  readonly games: readonly string[]
  readonly scripts: readonly string[]
  readonly repo: string
  /** Its folder in the repository. */
  readonly path: string
  /** Fingerprint of its SKILL.md as published. */
  readonly hash: string
}

export interface HubItem extends HubSkill {
  readonly installed?: {
    readonly at: number
    /** The user changed it since it was downloaded (or merged). */
    readonly modified: boolean
    /** The repository has another version (not one the user chose to skip). */
    readonly update: boolean
  }
  /** Why it cannot be downloaded: a core or the user's own skill has the name. */
  readonly blocked?: string
}

const Installed = z.object({ repo: z.string(), path: z.string(), hash: z.string(), at: z.number(), skipped: z.string().optional() })
const State = z.object({
  repos: z.array(z.object({ repo: z.string(), branch: z.string() })).optional(),
  installed: z.record(z.string(), Installed).default({}),
  read: z.record(z.string(), z.object({ at: z.number(), skills: z.array(z.looseObject({ name: z.string(), repo: z.string(), path: z.string(), hash: z.string() })) })).default({}),
})
type State = z.infer<typeof State>

const Index = z.object({
  skills: z.array(z.object({
    name: z.string().regex(NAME),
    path: z.string().min(1),
    title: z.string().optional(),
    kind: z.enum(['game', 'script', 'general']).optional(),
    games: z.array(z.string()).optional(),
    scripts: z.array(z.string()).optional(),
  })),
})

export interface SkillHubOptions {
  /** `<dataDir>/skill-hub`. */
  readonly dir: string
  /** Download `url` to `dest` (through the download mirror). */
  readonly download: (url: string, dest: string, signal?: AbortSignal) => Promise<void>
  /** Unpack a zip into `dest` (a single top folder lifted). */
  readonly extract: (archive: string, dest: string, signal?: AbortSignal) => Promise<void>
  /** Names of skills that are not this hub's (core, packs, the user's): not to be taken. */
  readonly taken: () => Promise<ReadonlyMap<string, string>>
  /** Register (or re-register) a downloaded skill with the agents; undefined unregisters. */
  readonly register: (name: string, skill: { description: string; content: string; path: string; dir: string } | undefined) => void
  readonly now?: () => number
  readonly log: { info(message: string): void; warn(message: string): void }
}

export class SkillHub {
  readonly #options: SkillHubOptions
  readonly #now: () => number
  #state: State = { installed: {}, read: {} }
  #loading: Promise<void> | undefined

  constructor(options: SkillHubOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
  }

  get skillsDir(): string {
    return join(this.#options.dir, 'skills')
  }

  /** Read the state and register the downloaded skills. */
  start(): Promise<void> {
    this.#loading ??= (async () => {
      try {
        this.#state = State.parse(JSON.parse(await readFile(join(this.#options.dir, 'state.json'), 'utf8')))
      } catch { /* none yet */ }
      for (const name of Object.keys(this.#state.installed)) await this.#register(name)
    })()
    return this.#loading
  }

  repos(): HubRepo[] {
    return this.#state.repos ?? [DEFAULT_HUB_REPO]
  }

  async setRepos(repos: readonly HubRepo[]): Promise<HubRepo[]> {
    await this.start()
    const seen = new Set<string>()
    this.#state.repos = repos.filter(r => { const key = r.repo.toLowerCase(); if (seen.has(key)) return false; seen.add(key); return true }).map(r => ({ repo: r.repo, branch: r.branch }))
    await this.#save()
    return this.repos()
  }

  /**
   * What the repositories have, and how each stands here. `refresh` reads
   * them now; otherwise what was read today (a repository that cannot be
   * read gives what was read before, and says so in `errors`).
   */
  async list(options: { refresh?: boolean; signal?: AbortSignal } = {}): Promise<{ items: HubItem[]; repos: HubRepo[]; errors: string[]; fetchedAt?: number }> {
    await this.start()
    const errors: string[] = []
    const skills: HubSkill[] = []
    let fetchedAt: number | undefined
    for (const repo of this.repos()) {
      const key = repoKey(repo)
      let read = this.#state.read[key]
      if (options.refresh === true || read === undefined || this.#now() - read.at >= REFRESH_MS) {
        try {
          const fresh = { at: this.#now(), skills: (await this.#readRepo(repo, options.signal)) as unknown as State['read'][string]['skills'] }
          this.#state.read[key] = fresh
          read = fresh
          await this.#save()
        } catch (error) {
          if (options.signal?.aborted === true) throw error
          errors.push(`${repo.repo}：${errorText(error)}`)
          this.#options.log.warn(`skill hub ${repo.repo}: ${errorText(error)}`)
        }
      }
      if (read === undefined) continue
      fetchedAt = Math.min(fetchedAt ?? Infinity, read.at)
      for (const skill of read.skills as unknown as HubSkill[]) if (!skills.some(s => s.name === skill.name)) skills.push(skill)
    }
    const taken = await this.#options.taken()
    const items: HubItem[] = []
    for (const skill of skills) items.push(await this.#item(skill, taken))
    // Downloaded skills whose repository no longer lists them still show (and can be removed).
    for (const [name, record] of Object.entries(this.#state.installed)) {
      if (items.some(i => i.name === name)) continue
      const content = await readFile(join(this.skillsDir, name, SKILL_FILE), 'utf8').catch(() => '')
      const front = frontmatter(content)
      items.push({ name, description: front?.description ?? '', kind: 'general', games: [], scripts: [], repo: record.repo, path: record.path, hash: record.hash, installed: { at: record.at, modified: hash(content) !== record.hash, update: false } })
    }
    return { items, repos: this.repos(), errors, ...(fetchedAt === undefined ? {} : { fetchedAt }) }
  }

  /** Download a skill from the repository (the first that has it, or `repo`). */
  async install(name: string, repo?: string, signal?: AbortSignal): Promise<HubItem> {
    const skill = await this.#find(name, repo, signal)
    const blocked = (await this.#options.taken()).get(name)
    if (blocked !== undefined) throw new Error(`已有同名的${blocked}「${name}」，没有下载`)
    await this.#put(skill)
    this.#options.log.info(`skill hub: downloaded ${name} from ${skill.repo}`)
    return this.#item(skill, await this.#options.taken())
  }

  /**
   * Take the repository's newer version. Unchanged here: replaced. Changed:
   * `conflict`, unless `resolve` says what to do — `keep` the user's (and
   * stop offering this version), or `replace` it (the user's kept in
   * `backup/`).
   */
  async update(name: string, resolve?: 'keep' | 'replace', signal?: AbortSignal): Promise<{ state: 'current' | 'updated' | 'kept' | 'conflict'; item: HubItem; backup?: string }> {
    const record = this.#record(name)
    const skill = await this.#find(name, record.repo, signal)
    const taken = await this.#options.taken()
    if (skill.hash === record.hash) return { state: 'current', item: await this.#item(skill, taken) }
    const file = join(this.skillsDir, name, SKILL_FILE)
    const mine = await readFile(file, 'utf8').catch(() => undefined)
    const modified = mine !== undefined && hash(mine) !== record.hash
    if (modified && resolve === undefined) return { state: 'conflict', item: await this.#item(skill, taken) }
    if (modified && resolve === 'keep') {
      this.#state.installed[name] = { ...record, skipped: skill.hash }
      await this.#save()
      return { state: 'kept', item: await this.#item(skill, taken) }
    }
    let backup: string | undefined
    if (modified) {
      backup = join(this.#options.dir, 'backup', `${name}-${this.#now()}.md`)
      await mkdir(join(this.#options.dir, 'backup'), { recursive: true })
      await writeFile(backup, mine!)
    }
    await this.#put(skill)
    return { state: 'updated', item: await this.#item(skill, taken), ...(backup === undefined ? {} : { backup }) }
  }

  /**
   * The three versions for merging a changed skill with the repository's
   * newer one: what was downloaded (`base`), the user's, the new one.
   */
  async mergeInputs(name: string, signal?: AbortSignal): Promise<{ base: string; mine: string; theirs: string; file: string; skill: HubSkill }> {
    const record = this.#record(name)
    const skill = await this.#find(name, record.repo, signal)
    const file = join(this.skillsDir, name, SKILL_FILE)
    const [base, mine, theirs] = await Promise.all([
      readFile(join(this.#options.dir, 'base', name, SKILL_FILE), 'utf8').catch(() => ''),
      readFile(file, 'utf8'),
      readFile(this.#repoFile(skill), 'utf8'),
    ])
    return { base, mine, theirs, file, skill }
  }

  /** After a merge was written into the user's file: the new version counts as taken (the file stays the user's). */
  async merged(name: string, skill: HubSkill): Promise<void> {
    const record = this.#record(name)
    await mkdir(join(this.#options.dir, 'base', name), { recursive: true })
    await cp(this.#repoFile(skill), join(this.#options.dir, 'base', name, SKILL_FILE))
    this.#state.installed[name] = { repo: record.repo, path: record.path, hash: skill.hash, at: this.#now() }
    await this.#save()
    await this.#register(name)
  }

  /** The user's version and the repository's, for showing what differs. */
  async diff(name: string, signal?: AbortSignal): Promise<{ mine: string; theirs: string }> {
    const { mine, theirs } = await this.mergeInputs(name, signal)
    return { mine, theirs }
  }

  async remove(name: string): Promise<void> {
    this.#record(name)
    this.#options.register(name, undefined)
    await rm(join(this.skillsDir, name), { recursive: true, force: true })
    await rm(join(this.#options.dir, 'base', name), { recursive: true, force: true })
    delete this.#state.installed[name]
    await this.#save()
  }

  /** Re-read a downloaded skill after its file changed (the agent or the user edited it). */
  async reload(name: string): Promise<void> {
    if (this.#state.installed[name] !== undefined) await this.#register(name)
  }

  isInstalled(name: string): boolean {
    return this.#state.installed[name] !== undefined
  }

  // ── internals ──

  #record(name: string) {
    const record = this.#state.installed[name]
    if (record === undefined) throw new Error(`没有从技能库下载过「${name}」`)
    return record
  }

  async #find(name: string, repo: string | undefined, signal?: AbortSignal): Promise<HubSkill> {
    let { items } = await this.list(signal === undefined ? {} : { signal })
    let found = items.find(i => i.name === name && (repo === undefined || i.repo.toLowerCase() === repo.toLowerCase()) && !isOrphan(i, this.#state))
    if (found === undefined) {
      // Not in what was read today: read again.
      ;({ items } = await this.list({ refresh: true, ...(signal === undefined ? {} : { signal }) }))
      found = items.find(i => i.name === name && (repo === undefined || i.repo.toLowerCase() === repo.toLowerCase()) && !isOrphan(i, this.#state))
    }
    if (found === undefined) throw new Error(`技能库里没有「${name}」`)
    if (!(await stat(this.#repoFile(found)).then(s => s.isFile(), () => false))) {
      // The copy of the repository is gone (cleaned up): read it again.
      await this.list({ refresh: true, ...(signal === undefined ? {} : { signal }) })
    }
    const { installed: _installed, blocked: _blocked, ...skill } = found
    return skill
  }

  #repoFile(skill: HubSkill): string {
    return join(this.#options.dir, 'repos', repoKey({ repo: skill.repo, branch: '' }), ...skill.path.split('/'), SKILL_FILE)
  }

  /** Copy the repository's version in as the downloaded skill (and as the base for later merges). */
  async #put(skill: HubSkill): Promise<void> {
    const from = join(this.#options.dir, 'repos', repoKey({ repo: skill.repo, branch: '' }), ...skill.path.split('/'))
    const to = join(this.skillsDir, skill.name)
    await rm(to, { recursive: true, force: true })
    await mkdir(this.skillsDir, { recursive: true })
    await cp(from, to, { recursive: true })
    await rm(join(this.#options.dir, 'base', skill.name), { recursive: true, force: true })
    await mkdir(join(this.#options.dir, 'base', skill.name), { recursive: true })
    await cp(join(from, SKILL_FILE), join(this.#options.dir, 'base', skill.name, SKILL_FILE))
    this.#state.installed[skill.name] = { repo: skill.repo, path: skill.path, hash: skill.hash, at: this.#now() }
    await this.#save()
    await this.#register(skill.name)
  }

  async #register(name: string): Promise<void> {
    const path = join(this.skillsDir, name, SKILL_FILE)
    const content = await readFile(path, 'utf8').catch(() => undefined)
    const front = content === undefined ? undefined : frontmatter(content)
    if (content === undefined || front === undefined) {
      this.#options.log.warn(`skill hub: ${name} has no usable SKILL.md; not registered`)
      this.#options.register(name, undefined)
      return
    }
    this.#options.register(name, { description: front.description, content: front.body, path, dir: join(this.skillsDir, name) })
  }

  async #item(skill: HubSkill, taken: ReadonlyMap<string, string>): Promise<HubItem> {
    const record = this.#state.installed[skill.name]
    if (record === undefined) {
      const blocked = taken.get(skill.name)
      return { ...skill, ...(blocked === undefined ? {} : { blocked: `已有同名的${blocked}` }) }
    }
    const content = await readFile(join(this.skillsDir, skill.name, SKILL_FILE), 'utf8').catch(() => '')
    return {
      ...skill,
      installed: { at: record.at, modified: hash(content) !== record.hash, update: skill.repo === record.repo && skill.hash !== record.hash && skill.hash !== record.skipped },
    }
  }

  /** Download the repository and list its skills; the copy replaces the one before. */
  async #readRepo(repo: HubRepo, signal?: AbortSignal): Promise<HubSkill[]> {
    const key = repoKey(repo)
    const work = join(this.#options.dir, 'downloads')
    await mkdir(work, { recursive: true })
    const archive = join(work, `${key}.zip`)
    const unpacked = join(work, `${key}-${this.#now()}`)
    await this.#options.download(`https://codeload.github.com/${repo.repo}/zip/refs/heads/${encodeURIComponent(repo.branch)}`, archive, signal)
    try {
      await this.#options.extract(archive, unpacked, signal)
      const skills = await readSkills(unpacked, repo.repo)
      const target = join(this.#options.dir, 'repos', key)
      await rm(target, { recursive: true, force: true })
      await mkdir(join(this.#options.dir, 'repos'), { recursive: true })
      await rename(unpacked, target)
      return skills
    } finally {
      await rm(archive, { force: true })
      await rm(unpacked, { recursive: true, force: true })
    }
  }

  #save(): Promise<void> {
    return mkdir(this.#options.dir, { recursive: true }).then(() => writeFileAtomic(join(this.#options.dir, 'state.json'), `${JSON.stringify(this.#state, null, 1)}\n`))
  }
}

/** The skills in an unpacked repository: as its `index.json` lists them, else every SKILL.md. */
export async function readSkills(root: string, repo: string): Promise<HubSkill[]> {
  const indexText = await readFile(join(root, 'index.json'), 'utf8').catch(() => undefined)
  const listed: { name?: string; path: string; title?: string | undefined; kind?: HubSkill['kind'] | undefined; games?: string[] | undefined; scripts?: string[] | undefined }[] = []
  if (indexText !== undefined) {
    const parsed = Index.safeParse(JSON.parse(indexText.replace(/^﻿/, '')))
    if (!parsed.success) throw new Error(`index.json 格式不对：${parsed.error.issues.map(i => `${i.path.join('.')} ${i.message}`).join('; ')}`)
    listed.push(...parsed.data.skills)
  } else {
    for (const path of await findSkillFolders(root, '', 3)) listed.push({ path })
  }
  const skills: HubSkill[] = []
  for (const entry of listed) {
    const path = entry.path.replace(/\\/g, '/').replace(/^\.?\/+|\/+$/g, '')
    const full = resolve(root, ...path.split('/'))
    const rel = relative(resolve(root), full)
    if (path === '' || rel.startsWith('..') || rel.split(sep).includes('..')) continue
    const content = await readFile(join(full, SKILL_FILE), 'utf8').catch(() => undefined)
    const front = content === undefined ? undefined : frontmatter(content)
    if (content === undefined || front === undefined) continue
    const name = entry.name ?? front.name
    if (name === undefined || !NAME.test(name) || skills.some(s => s.name === name)) continue
    if (front.name !== undefined && front.name !== name) continue
    skills.push({
      name,
      description: front.description,
      kind: entry.kind ?? (name.startsWith('game-') ? 'game' : 'general'),
      games: entry.games ?? [],
      scripts: entry.scripts ?? [],
      repo,
      path,
      hash: hash(content),
      ...(entry.title === undefined ? {} : { title: entry.title }),
    })
  }
  return skills
}

async function findSkillFolders(root: string, sub: string, depth: number): Promise<string[]> {
  const out: string[] = []
  const entries = await readdir(join(root, sub), { withFileTypes: true }).catch(() => [])
  if (sub !== '' && entries.some(e => e.isFile() && e.name === SKILL_FILE)) out.push(sub)
  if (depth === 0) return out
  for (const entry of entries) {
    if (entry.isDirectory() && !entry.name.startsWith('.')) out.push(...await findSkillFolders(root, sub === '' ? entry.name : `${sub}/${entry.name}`, depth - 1))
  }
  return out
}

/** `name` and `description` from a SKILL.md's frontmatter, and the text after it. */
export function frontmatter(text: string): { name?: string; description: string; body: string } | undefined {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  const field = (key: string) => {
    const raw = new RegExp(`^${key}:\\s*(.+)$`, 'm').exec(match[1]!)?.[1]?.trim()
    if (raw === undefined) return undefined
    if (raw.startsWith('"')) { try { return JSON.parse(raw) as string } catch { return raw } }
    return raw.replace(/^'(.*)'$/, '$1')
  }
  const description = field('description')
  if (description === undefined || description === '') return undefined
  const name = field('name')
  return { ...(name === undefined ? {} : { name }), description, body: match[2]! }
}

/** Fingerprint of a skill file, the same whatever line endings git gave it. */
function hash(text: string): string {
  return createHash('sha256').update(text.replace(/\r\n/g, '\n')).digest('hex').slice(0, 16)
}

function repoKey(repo: HubRepo): string {
  return repo.repo.toLowerCase().replace(/[^a-z0-9._-]+/g, '__')
}

function isOrphan(item: HubItem, state: State): boolean {
  return item.installed !== undefined && !Object.values(state.read).some(r => r.skills.some(s => s.name === item.name))
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
