/**
 * Role agents: kinds of work the app hands to an agent of its own (handling
 * an incident, reading games, installing scripts). The plugin that does the
 * work registers its role; the sessions it opens carry the role, so the
 * session list shows them under it, apart from the person's own chats with
 * the main agent (docs/design/agent-roles.md).
 *
 * A session's role is kept in `<dataDir>/session-roles.json`, not in dsh's
 * session. Sessions from before roles have none: the title prefix their
 * plugin opened them with (`干预：…`) stands in for it.
 */
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Role } from '@adg/protocol'
import { writeFileAtomic } from '@adg/protocol/node'

export interface RoleSpec extends Role {
  /** Title prefixes (before `：`) of the sessions it opened before sessions carried their role. */
  readonly titles?: readonly string[]
}

const MAX_KEPT = 5000

export class SessionRoles {
  readonly #file: string | undefined
  readonly #roles = new Map<string, RoleSpec>()
  readonly #tags = new Map<string, string>()
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

  list(): Role[] {
    return [...this.#roles.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name)).map(({ id, name, description, order }) => ({ id, name, description, order }))
  }

  /**
   * The role a session belongs to: the one it was opened with, else the one
   * whose title prefix it has. Undefined: the main agent's, also when its role's
   * plugin is not loaded.
   */
  of(sessionId: string, title: string | null | undefined): string | undefined {
    const tagged = this.#tags.get(sessionId)
    if (tagged !== undefined) return this.#roles.has(tagged) ? tagged : undefined
    const prefix = /^([^：:]{1,12})[：:]/.exec(title ?? '')?.[1]
    if (prefix === undefined) return undefined
    for (const role of this.#roles.values()) if (role.titles?.includes(prefix) === true) return role.id
    return undefined
  }

  async tag(sessionId: string, role: string): Promise<void> {
    await this.loaded
    if (this.#tags.get(sessionId) === role) return
    this.#tags.delete(sessionId)
    this.#tags.set(sessionId, role)
    while (this.#tags.size > MAX_KEPT) this.#tags.delete(this.#tags.keys().next().value!)
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    await writeFileAtomic(this.#file, `${JSON.stringify(Object.fromEntries(this.#tags))}\n`)
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.#file, 'utf8')) as unknown
      if (saved !== null && typeof saved === 'object' && !Array.isArray(saved)) {
        for (const [id, role] of Object.entries(saved)) if (typeof role === 'string') this.#tags.set(id, role)
      }
    } catch {
      // none yet
    }
  }
}
