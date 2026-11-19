/**
 * The skills repository (技能库): script packs, game packs and skills for
 * particular games and scripts that MultiGameAssistant does not ship,
 * downloaded from a GitHub repository (default `MultiGameAssistant/skills`).
 *
 * - The repository is read as one zip (no git needed; through the download
 *   mirror), at most once a day unless asked. Its `index.json` lists the
 *   skills (`name`, `path`, `kind`, `games`, `scripts`, `default`); without
 *   one every `SKILL.md` in it is a skill. A skill's description is its
 *   frontmatter's.
 * - A folder with `adg.script.yaml` beside its SKILL.md is a script pack (its
 *   id is the name); one with `game.yaml` is a game pack. The script library
 *   and the game page read the downloaded ones from here, so deleting one
 *   deletes the pack: nothing of a game the user does not play has to stay.
 * - Nothing is downloaded by itself, but a script's pack the library had and
 *   lost (it used to ship with the app): which games are shown is the user's
 *   choice apart from this; the game page and a conversation about a game
 *   offer its packs (the `default` ones ticked).
 * - A downloaded skill lives in `<dataDir>/skill-hub/skills/<name>/` (the
 *   app's own data: not a skill folder other agents read) and follows the
 *   repository: an update replaces it with the repository's version whether
 *   or not it was changed here. What should last is saved as one of the
 *   user's own skills.
 * - Versions: a skill is its whole folder (SKILL.md and the scripts and
 *   references beside it), fingerprinted together; any changed file is a new
 *   version. The index may also give a `version` and one line of `changes`
 *   to show, and `requires` (`>=2.1.0`): the app versions it works with —
 *   on an older app it is not downloaded or updated. The version an update
 *   replaced is kept in `skill-hub/previous/<name>/` to go back to; going back
 *   holds that newer version until the repository has another.
 * - The user's own skills (`skill_save`, their folders) are not tracked here,
 *   and a skill named like one of them, or like a core skill, is not taken.
 */
import { createHash } from 'node:crypto'
import { cp, mkdir, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { satisfies } from '@adg/installer'
import { GAME_MANIFEST_FILE, MANIFEST_FILE, parseGameManifest, parseManifest } from '@adg/pack-schema'
import { join, relative, resolve, sep } from 'node:path'
import { writeFileAtomic } from '@adg/protocol/node'
import { z } from 'zod'

export const DEFAULT_HUB_REPO = { repo: 'MultiGameAssistant/skills', branch: 'main' } as const

/** The repository is read again after this long. */
const REFRESH_MS = 24 * 60 * 60_000
/** What a repository read keeps; one kept in an older form is read again (it has no packs in it). */
const READ_FORMAT = 2
const SKILL_FILE = 'SKILL.md'
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

/** Which pack a skill's folder is, by the file beside its SKILL.md. */
export async function packKind(dir: string): Promise<'script' | 'game' | undefined> {
  const has = (file: string) => stat(join(dir, file)).then(s => s.isFile(), () => false)
  if (await has(MANIFEST_FILE)) return 'script'
  if (await has(GAME_MANIFEST_FILE)) return 'game'
  return undefined
}

export interface HubRepo { readonly repo: string; readonly branch: string }

export interface HubSkill {
  readonly name: string
  readonly description: string
  readonly title?: string
  /** `game`: a game's guide; `script`: a script's; `general`. */
  readonly kind: 'game' | 'script' | 'general'
  /** A script pack (`adg.script.yaml`; its id is the name) or a game pack (`game.yaml`). */
  readonly pack?: 'script' | 'game'
  /** A game pack's game id, and its SRA public API ids. */
  readonly game?: string
  readonly sra?: readonly string[]
  /** Offered ticked among a game's packs. */
  readonly default?: boolean
  /** Game ids (game packs) and script / pack ids it is for. */
  readonly games: readonly string[]
  readonly scripts: readonly string[]
  readonly repo: string
  /** Its folder in the repository. */
  readonly path: string
  /** Fingerprint of its folder as published (every file in it). */
  readonly hash: string
  /** What the index calls this version (shown; `hash` decides what is new). */
  readonly version?: string
  /** One line on what changed in this version. */
  readonly changes?: string
  /** App versions it works with, e.g. `>=2.1.0`. */
  readonly requires?: string
}

export interface HubItem extends HubSkill {
  readonly installed?: {
    readonly at: number
    /** The repository has another version (not one gone back from). */
    readonly update: boolean
    /** The version downloaded here, as the index named it then. */
    readonly version?: string
    /** The version an update replaced, kept to go back to. */
    readonly previous?: { readonly version?: string; readonly at: number }
    /** Went back from the repository's current version: not offered again until another. */
    readonly held?: boolean
  }
  /** Why the repository's version cannot be taken here: this app is too old for it. */
  readonly incompatible?: string
  /** Why it cannot be downloaded: a core or the user's own skill has the name. */
  readonly blocked?: string
}

/** Games and scripts the user put a downloaded skill under, instead of the repository's. */
const Owner = z.object({ games: z.array(z.string()).optional(), scripts: z.array(z.string()).optional() })
const Previous = z.object({ hash: z.string(), version: z.string().optional(), at: z.number() })
const Installed = z.object({
  repo: z.string(), path: z.string(), hash: z.string(), at: z.number(), owner: Owner.optional(),
  /** `hash` is of the whole folder; records from before were of SKILL.md alone. */
  folder: z.literal(true).optional(),
  version: z.string().optional(),
  previous: Previous.optional(),
  /** The repository's hash that was gone back from. */
  held: z.string().optional(),
})
const State = z.object({
  repos: z.array(z.object({ repo: z.string(), branch: z.string() })).optional(),
  installed: z.record(z.string(), Installed).default({}),
  read: z.record(z.string(), z.object({ at: z.number(), format: z.number().optional(), skills: z.array(z.looseObject({ name: z.string(), repo: z.string(), path: z.string(), hash: z.string() })) })).default({}),
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
    version: z.string().max(40).optional(),
    changes: z.string().max(300).optional(),
    requires: z.string().max(60).optional(),
    default: z.boolean().optional(),
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
  readonly register: (name: string, skill: { description: string; content: string; path: string; dir: string; owner?: { games?: string[]; scripts?: string[] }; pack?: 'script' | 'game' } | undefined) => void
  /** This app's version, for a skill's `requires`; undefined (run from source): any. */
  readonly appVersion?: () => string | undefined
  /** A script pack or a game pack came, changed or went: the script library and the game page read them again. */
  readonly packsChanged?: (kinds: ReadonlySet<'script' | 'game'>) => void
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
      // Copies of what was downloaded, once kept for merging the user's changes: no longer used.
      await rm(join(this.#options.dir, 'base'), { recursive: true, force: true })
      // Records from before folders were fingerprinted: fingerprint what is here (an edited copy shows as having a new version).
      let migrated = false
      for (const [name, record] of Object.entries(this.#state.installed)) {
        if (record.folder === true) continue
        const here = await folderHash(join(this.skillsDir, name)).catch(() => undefined)
        if (here === undefined) continue
        record.hash = here
        record.folder = true
        migrated = true
      }
      // What was read before has the old fingerprints too: read the repositories again.
      if (migrated) {
        this.#state.read = {}
        await this.#save()
      }
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
      if (options.refresh === true || read === undefined || read.format !== READ_FORMAT || this.#now() - read.at >= REFRESH_MS) {
        try {
          const fresh = { at: this.#now(), format: READ_FORMAT, skills: (await this.#readRepo(repo, options.signal)) as unknown as State['read'][string]['skills'] }
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
      const pack = await packKind(join(this.skillsDir, name))
      items.push({ name, description: front?.description ?? '', kind: pack ?? 'general', games: [], scripts: [], repo: record.repo, path: record.path, hash: record.hash, installed: installedOf(record, false), ...(pack === undefined ? {} : { pack }) })
    }
    return { items, repos: this.repos(), errors, ...(fetchedAt === undefined ? {} : { fetchedAt }) }
  }

  // ── changing a downloaded one ──

  /** Write a downloaded skill's description and instructions (the rest of its frontmatter and folder stay). */
  async save(name: string, description: string, content: string): Promise<void> {
    this.#record(name)
    const file = join(this.skillsDir, name, SKILL_FILE)
    const before = await readFile(file, 'utf8').catch(() => '')
    const head = /^﻿?---\r?\n([\s\S]*?)\r?\n---/.exec(before)?.[1] ?? `name: ${name}`
    const lines = head.split(/\r?\n/).filter(line => !/^description:/.test(line))
    if (!lines.some(line => /^name:/.test(line))) lines.unshift(`name: ${name}`)
    const at = lines.findIndex(line => /^name:/.test(line)) + 1
    lines.splice(at, 0, `description: ${JSON.stringify(description.replace(/\s+/g, ' ').trim())}`)
    await writeFileAtomic(file, `---\n${lines.join('\n')}\n---\n\n${content.trim()}\n`)
    await this.#register(name)
    this.#options.log.info(`skill hub: ${name} changed on the 技能 page`)
  }

  /** A skill's SKILL.md as the repository has it (one not downloaded yet, to look at first). */
  async preview(name: string): Promise<string> {
    const skill = await this.#find(name, undefined)
    return readFile(this.#repoFile(skill), 'utf8')
  }

  /** Downloaded from the default repository (MultiGameAssistant/skills): its packs are trusted like the app's own. */
  isTrusted(name: string): boolean {
    return this.#state.installed[name]?.repo.toLowerCase() === DEFAULT_HUB_REPO.repo.toLowerCase()
  }

  /** Download a skill from the repository (the first that has it, or `repo`). */
  async install(name: string, repo?: string, signal?: AbortSignal): Promise<HubItem> {
    const skill = await this.#find(name, repo, signal)
    const blocked = (await this.#options.taken()).get(name)
    if (blocked !== undefined) throw new Error(`已有同名的${blocked}「${name}」，没有下载`)
    this.#checkCompatible(skill)
    await this.#put(skill)
    this.#options.log.info(`skill hub: downloaded ${name} from ${skill.repo}`)
    return this.#item(skill, await this.#options.taken())
  }

  /** Take the repository's newer version, in place of this one (changed here or not). */
  async update(name: string, signal?: AbortSignal): Promise<{ state: 'current' | 'updated'; item: HubItem }> {
    const record = this.#record(name)
    const skill = await this.#find(name, record.repo, signal)
    if (skill.hash === record.hash) return { state: 'current', item: await this.#item(skill, await this.#options.taken()) }
    this.#checkCompatible(skill)
    await this.#put(skill)
    return { state: 'updated', item: await this.#item(skill, await this.#options.taken()) }
  }

  /** Go back to the version the last update replaced; the newer one is not offered again until the repository has another. */
  async rollback(name: string): Promise<HubItem> {
    const record = this.#record(name)
    const kept = join(this.#previousDir, name)
    const previous = record.previous
    if (previous === undefined || !(await stat(kept).then(st => st.isDirectory(), () => false))) throw new Error(`「${name}」没有上一个版本可以回退`)
    const held = record.hash
    const packs = new Set([await packKind(join(this.skillsDir, name)), await packKind(kept)].filter(k => k !== undefined))
    await rm(join(this.skillsDir, name), { recursive: true, force: true })
    await rename(kept, join(this.skillsDir, name))
    if (packs.size > 0) this.#options.packsChanged?.(packs)
    const { previous: _previous, version: _version, ...rest } = record
    this.#state.installed[name] = { ...rest, hash: previous.hash, at: this.#now(), folder: true, held, ...(previous.version === undefined ? {} : { version: previous.version }) }
    await this.#save()
    await this.#register(name)
    this.#options.log.info(`skill hub: ${name} back to ${previous.version ?? previous.hash}`)
    const listed = (await this.list()).items.find(i => i.name === name)
    if (listed === undefined) throw new Error(`技能库里没有「${name}」`)
    return listed
  }

  async remove(name: string): Promise<void> {
    this.#record(name)
    const pack = await packKind(join(this.skillsDir, name))
    this.#options.register(name, undefined)
    await rm(join(this.#previousDir, name), { recursive: true, force: true })
    await rm(join(this.skillsDir, name), { recursive: true, force: true })
    delete this.#state.installed[name]
    await this.#save()
    if (pack !== undefined) this.#options.packsChanged?.(new Set([pack]))
    this.#options.log.info(`skill hub: deleted ${name}`)
  }

  /** Put a downloaded skill under other games and scripts (empty: general); `null`: back to the repository's. */
  async setOwner(name: string, owner: { games?: readonly string[] | undefined; scripts?: readonly string[] | undefined } | null): Promise<void> {
    const record = this.#record(name)
    if (owner === null) delete record.owner
    else record.owner = { games: [...new Set(owner.games ?? [])], scripts: [...new Set(owner.scripts ?? [])] }
    await this.#save()
    await this.#register(name)
  }

  /** Re-read a downloaded skill after its file changed (the agent or the user edited it). */
  async reload(name: string): Promise<void> {
    if (this.#state.installed[name] !== undefined) await this.#register(name)
  }

  isInstalled(name: string): boolean {
    return this.#state.installed[name] !== undefined
  }

  // ── internals ──

  get #previousDir(): string {
    return join(this.#options.dir, 'previous')
  }

  /** Why this app cannot take the skill's version; undefined: it can. */
  #incompatible(skill: HubSkill): string | undefined {
    const app = this.#options.appVersion?.()
    if (skill.requires === undefined || app === undefined || satisfies(app, skill.requires)) return undefined
    return `需要软件版本 ${skill.requires}（现在是 ${app}），先更新软件`
  }

  #checkCompatible(skill: HubSkill): void {
    const why = this.#incompatible(skill)
    if (why !== undefined) throw new Error(`「${skill.name}」${skill.version === undefined ? '' : ` ${skill.version}`}${why}`)
  }

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

  /** Copy the repository's version in as the downloaded skill. */
  async #put(skill: HubSkill): Promise<void> {
    const from = join(this.#options.dir, 'repos', repoKey({ repo: skill.repo, branch: '' }), ...skill.path.split('/'))
    const to = join(this.skillsDir, skill.name)
    const before = this.#state.installed[skill.name]
    // The version being replaced is kept to go back to (one, the last).
    let previous: z.infer<typeof Previous> | undefined
    if (before !== undefined && await stat(to).then(st => st.isDirectory(), () => false)) {
      await rm(join(this.#previousDir, skill.name), { recursive: true, force: true })
      await mkdir(this.#previousDir, { recursive: true })
      await rename(to, join(this.#previousDir, skill.name))
      previous = { hash: before.hash, at: before.at, ...(before.version === undefined ? {} : { version: before.version }) }
    }
    const packs = new Set([previous === undefined ? undefined : await packKind(join(this.#previousDir, skill.name)), await packKind(from)].filter(k => k !== undefined))
    await rm(to, { recursive: true, force: true })
    await mkdir(this.skillsDir, { recursive: true })
    await cp(from, to, { recursive: true })
    // Where the user put it stays across updates.
    const owner = before?.owner
    this.#state.installed[skill.name] = {
      repo: skill.repo, path: skill.path, hash: skill.hash, at: this.#now(), folder: true,
      ...(skill.version === undefined ? {} : { version: skill.version }),
      ...(owner === undefined ? {} : { owner }),
      ...(previous === undefined ? {} : { previous }),
    }
    await this.#save()
    await this.#register(skill.name)
    if (packs.size > 0) this.#options.packsChanged?.(packs)
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
    // What it belongs to: where the user put it, else the repository's index as last read (skill isolation: only those scripts' and games' sessions see it).
    const record = this.#state.installed[name]
    const listed = record?.owner ?? (record === undefined ? undefined : Object.values(this.#state.read).flatMap(r => r.skills).find(s => s.name === name && s.repo === record.repo) as { games?: unknown; scripts?: unknown } | undefined)
    const ids = (value: unknown) => (Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [])
    const games = ids(listed?.games)
    const scripts = ids(listed?.scripts)
    const owner = games.length + scripts.length === 0 ? undefined : { ...(games.length === 0 ? {} : { games }), ...(scripts.length === 0 ? {} : { scripts }) }
    const pack = await packKind(join(this.skillsDir, name))
    this.#options.register(name, { description: front.description, content: front.body, path, dir: join(this.skillsDir, name), ...(owner === undefined ? {} : { owner }), ...(pack === undefined ? {} : { pack }) })
  }

  async #item(found: HubSkill, taken: ReadonlyMap<string, string>): Promise<HubItem> {
    // Only what a HubSkill has (what was read and kept may carry more).
    const { name, description, title, kind, games, scripts, repo, path, hash, version, changes, requires, pack, game, sra } = found
    const skill: HubSkill = {
      name, description, kind, games, scripts, repo, path, hash,
      ...(title === undefined ? {} : { title }),
      ...(version === undefined ? {} : { version }),
      ...(changes === undefined ? {} : { changes }),
      ...(requires === undefined ? {} : { requires }),
      ...(pack === undefined ? {} : { pack }),
      ...(game === undefined ? {} : { game }),
      ...(sra === undefined ? {} : { sra }),
      ...(found.default === true ? { default: true } : {}),
    }
    const incompatible = this.#incompatible(skill)
    const record = this.#state.installed[skill.name]
    if (record === undefined) {
      const blocked = taken.get(skill.name)
      return { ...skill, ...(blocked === undefined ? {} : { blocked: `已有同名的${blocked}` }), ...(incompatible === undefined ? {} : { incompatible }) }
    }
    const newer = skill.repo === record.repo && skill.hash !== record.hash && skill.hash !== record.held
    return { ...skill, installed: installedOf(record, newer, skill.hash === record.held), ...(newer && incompatible !== undefined ? { incompatible } : {}) }
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
  const listed: { name?: string; path: string; title?: string | undefined; kind?: HubSkill['kind'] | undefined; games?: string[] | undefined; scripts?: string[] | undefined; version?: string | undefined; changes?: string | undefined; requires?: string | undefined; default?: boolean | undefined }[] = []
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
    const version = entry.version ?? front?.version
    const { changes, requires } = entry
    if (content === undefined || front === undefined) continue
    const name = entry.name ?? front.name
    if (name === undefined || !NAME.test(name) || skills.some(s => s.name === name)) continue
    if (front.name !== undefined && front.name !== name) continue
    const pack = await packOf(full, name)
    const games = entry.games ?? []
    skills.push({
      name,
      description: front.description,
      kind: entry.kind ?? (pack?.kind ?? (name.startsWith('game-') ? 'game' : 'general')),
      games: pack?.game !== undefined && !games.includes(pack.game) ? [pack.game, ...games] : games,
      scripts: entry.scripts ?? [],
      repo,
      path,
      hash: await folderHash(full),
      ...(entry.title === undefined ? {} : { title: entry.title }),
      ...(version === undefined ? {} : { version }),
      ...(changes === undefined ? {} : { changes }),
      ...(requires === undefined ? {} : { requires }),
      ...(entry.default === true ? { default: true } : {}),
      ...(pack === undefined ? {} : { pack: pack.kind, ...(pack.game === undefined ? {} : { game: pack.game, sra: pack.sra }) }),
    })
  }
  return skills
}

/**
 * The pack a repository folder is: a script pack whose id is its name, or a
 * game pack (its game id and SRA ids). A pack file that does not read is no
 * pack (the folder is still a skill).
 */
async function packOf(dir: string, name: string): Promise<{ kind: 'script' | 'game'; game?: string; sra?: string[] } | undefined> {
  const kind = await packKind(dir)
  try {
    if (kind === 'script') {
      const manifest = parseManifest(await readFile(join(dir, MANIFEST_FILE), 'utf8'), `${name}/${MANIFEST_FILE}`)
      return manifest.id === name ? { kind } : undefined
    }
    if (kind === 'game') {
      const manifest = parseGameManifest(await readFile(join(dir, GAME_MANIFEST_FILE), 'utf8'), `${name}/${GAME_MANIFEST_FILE}`)
      return { kind, game: manifest.id, sra: manifest.sources.map(s => s.sra?.game).filter((s): s is string => s !== undefined) }
    }
  } catch {
    return undefined
  }
  return undefined
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
export function frontmatter(text: string): { name?: string; version?: string; description: string; body: string } | undefined {
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
  const version = field('version')
  return { ...(name === undefined ? {} : { name }), ...(version === undefined ? {} : { version }), description, body: match[2]! }
}

/**
 * Fingerprint of a skill's folder: every file in it (by path, in order), text
 * the same whatever line endings git gave it.
 */
export async function folderHash(dir: string): Promise<string> {
  const files: string[] = []
  const walk = async (sub: string): Promise<void> => {
    for (const entry of await readdir(join(dir, sub), { withFileTypes: true })) {
      const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
      // Python's compiled cache appears beside scripts once they run: not part of the skill.
      if (entry.isDirectory()) { if (entry.name !== '__pycache__') await walk(rel) } else if (entry.isFile()) files.push(rel)
    }
  }
  await walk('')
  if (!files.includes(SKILL_FILE)) throw new Error(`${dir} 里没有 ${SKILL_FILE}`)
  const digest = createHash('sha256')
  for (const rel of files.sort()) {
    const bytes = await readFile(join(dir, ...rel.split('/')))
    digest.update(rel).update('\0').update(bytes.includes(0) ? bytes : bytes.toString('utf8').replace(/\r\n/g, '\n')).update('\0')
  }
  return digest.digest('hex').slice(0, 16)
}

/** How a downloaded skill stands, for a HubItem. */
function installedOf(record: State['installed'][string], update: boolean, held = false): NonNullable<HubItem['installed']> {
  return {
    at: record.at,
    update,
    ...(record.version === undefined ? {} : { version: record.version }),
    ...(record.previous === undefined ? {} : { previous: { at: record.previous.at, ...(record.previous.version === undefined ? {} : { version: record.previous.version }) } }),
    ...(held ? { held: true } : {}),
  }
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
