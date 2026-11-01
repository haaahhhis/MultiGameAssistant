/**
 * Sharing a dsh with the person's other work: the dsh plugin installed into a
 * profile of theirs (dsh desktop's own), where other chats run beside this
 * app's. Two pieces keep the app to its own:
 *
 * - `OwnSessions`: the sessions this app created (its chat, Feishu
 *   conversations, interventions), kept in `<dataDir>/own-sessions.json`.
 *   Approvals, questions, permission presets, the session list and its
 *   events only concern these.
 * - `AgentParts`: what the app gives its agents — tools, prompt sections,
 *   step hooks. Shared, they are registered by the agent preset's plugin
 *   (agent.ts) inside that preset, so only the app's sessions see them; a dsh
 *   of the app's own (the desktop app) registers them for every agent, as
 *   before.
 */
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import { writeFileAtomic } from '@adg/protocol/node'

/** The agent preset the app's sessions run when the dsh is shared (the plugin's patch declares it). */
export const AGENT_PRESET = 'mga'

const MAX_KEPT = 5000

export class OwnSessions {
  readonly #file: string | undefined
  readonly #ids = new Set<string>()
  readonly loaded: Promise<void>

  constructor(file: string | undefined) {
    this.#file = file
    this.loaded = this.#load()
  }

  has(sessionId: string): boolean {
    return this.#ids.has(sessionId)
  }

  async add(sessionId: string): Promise<void> {
    await this.loaded
    if (this.#ids.has(sessionId)) return
    this.#ids.add(sessionId)
    while (this.#ids.size > MAX_KEPT) this.#ids.delete(this.#ids.values().next().value!)
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    await writeFileAtomic(this.#file, `${JSON.stringify([...this.#ids])}\n`)
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.#file, 'utf8')) as unknown
      if (Array.isArray(saved)) for (const id of saved) if (typeof id === 'string') this.#ids.add(id)
    } catch {
      // none yet
    }
  }
}

/**
 * Registers something on an agent scope (or the whole host) and returns how
 * to take it back: `scope => scope.tools.register(tool)`.
 */
export type AgentPart = (scope: Context) => () => void

/** The parts waiting for the agent preset's scopes, and the scopes that hold them. */
export class AgentParts {
  readonly #parts = new Map<number, { readonly label: string; readonly part: AgentPart }>()
  readonly #scopes = new Map<Context, Map<number, () => void>>()
  #next = 0
  readonly #log: { warn(message: string): void }

  constructor(log: { warn(message: string): void }) {
    this.#log = log
  }

  /** @returns the disposer taking the part out of every scope. */
  add(label: string, part: AgentPart): () => void {
    const id = this.#next++
    this.#parts.set(id, { label, part })
    for (const [scope, held] of this.#scopes) this.#apply(scope, held, id, label, part)
    return () => {
      if (!this.#parts.delete(id)) return
      for (const held of this.#scopes.values()) {
        held.get(id)?.()
        held.delete(id)
      }
    }
  }

  /** Register every part on a scope, and later ones as they come. @returns the disposer. */
  attach(scope: Context): () => void {
    const held = new Map<number, () => void>()
    this.#scopes.set(scope, held)
    for (const [id, { label, part }] of this.#parts) this.#apply(scope, held, id, label, part)
    return () => {
      this.#scopes.delete(scope)
      for (const dispose of held.values()) dispose()
      held.clear()
    }
  }

  #apply(scope: Context, held: Map<number, () => void>, id: number, label: string, part: AgentPart): void {
    try {
      held.set(id, part(scope))
    } catch (error) {
      this.#log.warn(`${label} not registered for the app's agents: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
}
