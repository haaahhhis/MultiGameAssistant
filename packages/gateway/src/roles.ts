/**
 * Role agents: kinds of work the app hands to an agent of its own (handling
 * an incident, reading games, installing scripts). The plugin that does the
 * work registers its role; the sessions it opens carry the role, so the
 * session list shows them under it, apart from the person's own chats with
 * the main agent (docs/design/agent-roles.md).
 *
 * A session's role, and who asked for its work (监控, 定时, 你, …), are kept
 * in `<dataDir>/session-roles.json`, not in dsh's session. Sessions from
 * before roles have none: the title prefix their plugin opened them with
 * (`干预：…`) stands in for the role.
 *
 * A role's agent is narrowed to its work (`tools`, `duty`): the gateway hides
 * the app's other tools from it and gives it its duty, on that agent alone
 * (index.ts `narrow`); dsh's own tools stay. The main agent keeps everything.
 */
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelSelection, Role } from '@adg/protocol'
import { writeFileAtomic } from '@adg/protocol/node'

export interface RoleSpec extends Role {
  /** Title prefixes (before `：`) of the sessions it opened before sessions carried their role. */
  readonly titles?: readonly string[]
  /**
   * The app's tools its agent keeps (`script_run`, or `screen_*` for a family);
   * the app's others are hidden from it. Absent: all of them.
   */
  readonly tools?: readonly string[]
  /** What its agent is for and where its work stops, as a section of its system prompt. */
  readonly duty?: string
}

/** Does a role's `tools` keep this tool? */
export function keeps(tools: readonly string[] | undefined, name: string): boolean {
  return tools === undefined || tools.some(pattern => pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern)
}

const MAX_KEPT = 5000

export class SessionRoles {
  readonly #file: string | undefined
  readonly #roles = new Map<string, RoleSpec>()
  readonly #tags = new Map<string, { readonly role: string; readonly by?: string }>()
  readonly #changed: () => void
  readonly loaded: Promise<void>

  /** @param changed - the role list changed (one registered or taken back). */
  constructor(file: string | undefined, changed: () => void = () => {}) {
    this.#file = file
    this.#changed = changed
    this.loaded = this.#load()
  }

  /** @returns how to take the role back. A second registration of the same id replaces the first. */
  register(spec: RoleSpec): () => void {
    this.#roles.set(spec.id, spec)
    this.#changed()
    return () => {
      if (this.#roles.get(spec.id) !== spec) return
      this.#roles.delete(spec.id)
      this.#changed()
    }
  }

  /** A registered role's whole spec. */
  spec(id: string): RoleSpec | undefined {
    return this.#roles.get(id)
  }

  /** The role a session was opened with (its tag), when that role is registered; no title fallback. */
  tagged(sessionId: string): string | undefined {
    const role = this.#tags.get(sessionId)?.role
    return role !== undefined && this.#roles.has(role) ? role : undefined
  }

  list(): Role[] {
    return [...this.#roles.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map(({ id, name, description, order }) => ({ id, name, description, order }))
  }

  /**
   * The role a session belongs to: the one it was opened with, else the one
   * whose title prefix it has. Undefined: the main agent's, also when its role's
   * plugin is not loaded.
   */
  of(sessionId: string, title: string | null | undefined): string | undefined {
    const tagged = this.#tags.get(sessionId)?.role
    if (tagged !== undefined) return this.#roles.has(tagged) ? tagged : undefined
    const prefix = /^([^：:]{1,12})[：:]/.exec(title ?? '')?.[1]
    if (prefix === undefined) return undefined
    for (const role of this.#roles.values()) if (role.titles?.includes(prefix) === true) return role.id
    return undefined
  }

  /** Who asked for the session's work, in words (监控, 定时, 你, 流水线「…」); undefined: not recorded. */
  requestedBy(sessionId: string): string | undefined {
    return this.#tags.get(sessionId)?.by
  }

  /** @param by - who asked for the work (`requestedBy`). */
  async tag(sessionId: string, role: string, by?: string): Promise<void> {
    await this.loaded
    const kept = this.#tags.get(sessionId)
    if (kept?.role === role && kept.by === by) return
    this.#tags.delete(sessionId)
    this.#tags.set(sessionId, by === undefined ? { role } : { role, by })
    while (this.#tags.size > MAX_KEPT) this.#tags.delete(this.#tags.keys().next().value!)
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    // A role alone is kept as its id, as before.
    const saved = Object.fromEntries([...this.#tags].map(([id, tag]) => [id, tag.by === undefined ? tag.role : tag]))
    await writeFileAtomic(this.#file, `${JSON.stringify(saved)}\n`)
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.#file, 'utf8')) as unknown
      if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [id, tag] of Object.entries(saved)) {
          if (typeof tag === 'string') this.#tags.set(id, { role: tag })
          else if (typeof (tag as { role?: unknown } | null)?.role === 'string') {
            const { role, by } = tag as { role: string; by?: unknown }
            this.#tags.set(id, typeof by === 'string' ? { role, by } : { role })
          }
        }
      }
    } catch {
      // none yet
    }
  }
}

/**
 * The model role agents' sessions use (设置 → 模型 「角色 agent 的模型」),
 * kept in `<dataDir>/role-model.json`: a cheaper model for the screenshots,
 * logs and clicks they do, while your own conversations keep the default.
 * None set: role sessions get the model they always did.
 */
export class RoleModel {
  readonly #file: string | undefined
  #selection: ModelSelection | undefined
  readonly loaded: Promise<void>

  constructor(file: string | undefined) {
    this.#file = file
    this.loaded = this.#load()
  }

  get(): ModelSelection | undefined {
    return this.#selection
  }

  async set(selection: ModelSelection | undefined): Promise<void> {
    await this.loaded
    this.#selection = selection === undefined ? undefined : { provider: selection.provider, model: selection.model, ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }) }
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    await writeFileAtomic(this.#file, `${JSON.stringify(this.#selection ?? null)}\n`)
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.#file, 'utf8')) as { provider?: unknown; model?: unknown; reasoningEffort?: unknown } | null
      if (typeof saved?.provider === 'string' && typeof saved.model === 'string') {
        this.#selection = { provider: saved.provider, model: saved.model, ...(typeof saved.reasoningEffort === 'string' ? { reasoningEffort: saved.reasoningEffort } : {}) }
      }
    } catch {
      // none chosen
    }
  }
}
