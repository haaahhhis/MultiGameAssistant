/**
 * Skill isolation (技能隔离): a skill that belongs to a script or a game is
 * read only where that script or game is being worked on.
 *
 * - Every skill the app registers says what it belongs to (`SkillOwner`): a
 *   script pack's SKILL.md its scripts, a game pack's guide its game, a skill
 *   from the skills repository what its index says, a saved skill what the
 *   agent said when saving it. Nothing: a general skill, seen everywhere.
 * - Every session has a focus: the scripts and games it is about. The app sets
 *   it when it starts a session for one (an intervention, a game's reading, a
 *   pack analysis); the agent sets it with `skill_focus` before working on one
 *   (it replaces the last, so switching scripts switches skills); a user who
 *   invokes such a skill by name (`/maa-daily`) adds its owner.
 * - A session sees the general skills and those of its focus; a script's focus
 *   also shows the skills of the game it plays. Both the catalog the agent is
 *   shown and the `skill` tool go through this, so a hidden skill cannot be
 *   loaded either. Lists without a session (the 技能 page) show everything.
 *
 * dsh asks skill providers per agent and caches the answer per agent; every
 * focus or skill change invalidates it, and dsh's catalog then tells the agent
 * the new list.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@adg/protocol/node'

export interface SkillOwner {
  /** Script ids and script pack ids. */
  readonly scripts?: readonly string[]
  /** Game ids or names. */
  readonly games?: readonly string[]
}

export interface ScriptRelations {
  /** Other ids the script goes by: its pack's. */
  readonly aliases: readonly string[]
  /** Game ids or names it plays. */
  readonly games: readonly string[]
}

export interface Focus {
  readonly scripts: readonly string[]
  readonly games: readonly string[]
}

export interface ScopedSkillInput {
  readonly name: string
  readonly description: string
  readonly content: string
  readonly source: string
  readonly path?: string
  readonly resourceBase?: { kind: 'directory'; path: string }
  readonly owner?: SkillOwner
}

/** The part of dsh's skill provider contract used here. */
export interface SkillProvider {
  readonly name: string
  list(options: { scope?: unknown }): Promise<readonly unknown[]>
  get(candidate: { locator: unknown }): Promise<unknown>
}

const PROVIDER = 'adg'
/** dsh's rank for runtime-registered skills, which these replace. */
const RANK = 250
const MAX_SESSIONS = 1000
const INVOCABLE = { modelInvocable: true, userInvocable: true } as const

const norm = (value: string) => value.trim().toLowerCase()

export class SkillScope {
  readonly #skills = new Map<string, ScopedSkillInput>()
  readonly #focus = new Map<string, Focus>()
  readonly #file: string | undefined
  #invalidate: () => void = () => {}
  #relations: (scriptId: string) => ScriptRelations = () => ({ aliases: [], games: [] })
  #loaded: Promise<void>
  #saving = Promise.resolve()

  readonly log: { warn(message: string): void }

  constructor(dataDir: string | undefined, log: { warn(message: string): void }) {
    this.log = log
    this.#file = dataDir === undefined ? undefined : join(dataDir, 'skill-focus.json')
    this.#loaded = this.#load()
  }

  /** @returns the provider to hand to dsh's `skills.registerProvider`, given its invalidation. */
  provider(invalidate: () => void): SkillProvider {
    this.#invalidate = invalidate
    return {
      name: PROVIDER,
      list: async options => {
        await this.#loaded
        const focus = this.focusOf(sessionOf(options.scope))
        return [...this.#skills.values()].filter(skill => focus === undefined || this.visible(skill.owner, focus)).map(candidate)
      },
      get: async ({ locator }) => definition(locator as ScopedSkillInput),
    }
  }

  /**
   * What else a script in a focus stands for: its pack's id (the pack's skill
   * names that), and the games it plays, whose skills it sees too.
   */
  resolveScripts(resolve: (scriptId: string) => ScriptRelations): void {
    this.#relations = resolve
    this.#invalidate()
  }

  /**
   * Add a skill; the first one of a name wins.
   * @returns the disposer, or a no-op when the name is taken.
   */
  register(skill: ScopedSkillInput): () => void {
    if (this.#skills.has(skill.name)) {
      this.log.warn(`skill "${skill.name}" ignored because it is already registered`)
      return () => {}
    }
    this.#skills.set(skill.name, skill)
    this.#invalidate()
    return () => {
      if (this.#skills.get(skill.name) !== skill) return
      this.#skills.delete(skill.name)
      this.#invalidate()
    }
  }

  ownerOf(name: string): SkillOwner | undefined {
    return this.#skills.get(name)?.owner
  }

  /** A session's focus; undefined: no session (everything shows). A session never focused shows the general skills only. */
  focusOf(sessionId: string | undefined): Focus | undefined {
    if (sessionId === undefined) return undefined
    return this.#focus.get(sessionId) ?? { scripts: [], games: [] }
  }

  /**
   * Set (`replace`) or widen a session's focus.
   * @returns the focus now.
   */
  async setFocus(sessionId: string, focus: Partial<Focus>, mode: 'replace' | 'add' = 'replace'): Promise<Focus> {
    await this.#loaded
    const before = mode === 'add' ? this.#focus.get(sessionId) : undefined
    const merged: Focus = {
      scripts: unique([...(before?.scripts ?? []), ...(focus.scripts ?? [])]),
      games: unique([...(before?.games ?? []), ...(focus.games ?? [])]),
    }
    this.#focus.delete(sessionId)
    this.#focus.set(sessionId, merged)
    while (this.#focus.size > MAX_SESSIONS) this.#focus.delete(this.#focus.keys().next().value!)
    this.#invalidate()
    this.#save()
    return merged
  }

  /** The skills a focus shows (general ones included). */
  skillsFor(focus: Focus): ScopedSkillInput[] {
    return [...this.#skills.values()].filter(skill => this.visible(skill.owner, focus))
  }

  visible(owner: SkillOwner | undefined, focus: Focus): boolean {
    const scripts = owner?.scripts ?? []
    const games = owner?.games ?? []
    if (scripts.length === 0 && games.length === 0) return true
    const related = focus.scripts.map(s => this.#relations(s))
    const focusScripts = new Set([...focus.scripts, ...related.flatMap(r => r.aliases)].map(norm))
    if (scripts.some(s => focusScripts.has(norm(s)))) return true
    const focusGames = new Set([...focus.games, ...related.flatMap(r => r.games)].map(norm))
    return games.some(g => focusGames.has(norm(g)))
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return
    try {
      const value = JSON.parse(await readFile(this.#file, 'utf8')) as { sessions?: Record<string, Partial<Focus>> }
      for (const [id, focus] of Object.entries(value.sessions ?? {})) {
        this.#focus.set(id, { scripts: strings(focus.scripts), games: strings(focus.games) })
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') this.log.warn(`skill focus not read: ${String(error)}`)
    }
  }

  #save(): void {
    const file = this.#file
    if (file === undefined) return
    this.#saving = this.#saving
      .then(() => writeFileAtomic(file, JSON.stringify({ sessions: Object.fromEntries(this.#focus) }, null, 1)))
      .catch(error => this.log.warn(`skill focus not saved: ${String(error)}`))
  }
}

/** The session an agent belongs to (dsh passes the viewing agent as the lookup's scope). */
function sessionOf(scope: unknown): string | undefined {
  const id = (scope as { session?: { id?: unknown } } | undefined)?.session?.id
  return typeof id === 'string' ? id : undefined
}

function candidate(skill: ScopedSkillInput) {
  return {
    name: skill.name,
    description: skill.description,
    invocation: INVOCABLE,
    source: skill.source,
    provider: PROVIDER,
    ...(skill.resourceBase === undefined ? {} : { resourceBase: skill.resourceBase }),
    ...(skill.path === undefined ? {} : { path: skill.path }),
    rank: RANK,
    locator: skill,
  }
}

function definition(skill: ScopedSkillInput) {
  return {
    name: skill.name,
    description: skill.description,
    invocation: INVOCABLE,
    source: skill.source,
    provider: PROVIDER,
    content: skill.content,
    ...(skill.resourceBase === undefined ? {} : { resourceBase: skill.resourceBase }),
    ...(skill.path === undefined ? {} : { path: skill.path }),
  }
}

function unique(values: readonly string[]): string[] {
  const seen = new Set<string>()
  return values.map(v => v.trim()).filter(v => v !== '' && !seen.has(norm(v)) && (seen.add(norm(v)), true))
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
}

/** Skill names a user invoked by name in these messages (`/name`, as dsh's skill tool reads them). */
export function invokedSkills(messages: readonly unknown[]): string[] {
  const names: string[] = []
  for (const message of messages) {
    const m = message as { source?: { kind?: string }; content?: readonly { type?: string; text?: string }[] }
    if (m.source?.kind !== 'user') continue
    for (const block of m.content ?? []) {
      if (block.type !== 'text' || typeof block.text !== 'string') continue
      for (const match of block.text.matchAll(/(^|\s)\/([a-z0-9]+(?:-[a-z0-9]+)*)(?=\s|$)/g)) {
        if (match[2] !== undefined && !names.includes(match[2])) names.push(match[2])
      }
    }
  }
  return names
}
