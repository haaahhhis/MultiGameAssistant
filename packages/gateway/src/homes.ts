/**
 * Each agent's one conversation (docs/design/agent-roles.md §10): 助手's
 * with the person — here and in Feishu — and each role agent's, where
 * everything it is handed arrives as a message. Kept as agent id → session
 * id in `<dataDir>/agent-homes.json`; conversations from before are earlier
 * conversations, still listed under their agent.
 *
 * And the work agents hand each other (`HandOffs`): what was asked, of whom,
 * where it stands, and the reply, in `<dataDir>/handoffs.json`. A hand-off
 * still running when the app stopped has lost its turn: it is kept as failed.
 */
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { HandOff } from '@adg/protocol'
import { writeFileAtomic } from '@adg/protocol/node'

export class AgentHomes {
  readonly #file: string | undefined
  readonly #homes = new Map<string, string>()
  readonly loaded: Promise<void>

  constructor(file: string | undefined) {
    this.#file = file
    this.loaded = this.#load()
  }

  get(agentId: string): string | undefined {
    return this.#homes.get(agentId)
  }

  /** The agent whose conversation `sessionId` is. */
  agentOf(sessionId: string): string | undefined {
    for (const [agent, session] of this.#homes) if (session === sessionId) return agent
    return undefined
  }

  async set(agentId: string, sessionId: string): Promise<void> {
    await this.loaded
    this.#homes.set(agentId, sessionId)
    await this.#save()
  }

  async drop(agentId: string): Promise<void> {
    await this.loaded
    if (this.#homes.delete(agentId)) await this.#save()
  }

  async #save(): Promise<void> {
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    await writeFileAtomic(this.#file, `${JSON.stringify(Object.fromEntries(this.#homes), null, 2)}\n`)
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.#file, 'utf8')) as unknown
      if (saved === null || typeof saved !== 'object') return
      for (const [agent, session] of Object.entries(saved)) if (typeof session === 'string') this.#homes.set(agent, session)
    } catch {
      // none yet
    }
  }
}

const MAX_KEPT = 500

export class HandOffs {
  readonly #file: string | undefined
  readonly #items = new Map<string, HandOff>()
  readonly #changed: (item: HandOff) => void
  readonly loaded: Promise<void>

  constructor(file: string | undefined, changed: (item: HandOff) => void = () => {}) {
    this.#file = file
    this.#changed = changed
    this.loaded = this.#load()
  }

  /** Those from or to this conversation, oldest first. */
  of(sessionId: string): HandOff[] {
    return [...this.#items.values()].filter(h => h.fromSession === sessionId || h.toSession === sessionId)
  }

  get(id: string): HandOff | undefined {
    return this.#items.get(id)
  }

  async put(item: HandOff): Promise<void> {
    await this.loaded
    this.#items.delete(item.id)
    this.#items.set(item.id, item)
    while (this.#items.size > MAX_KEPT) this.#items.delete(this.#items.keys().next().value!)
    this.#changed(item)
    await this.#save()
  }

  async #save(): Promise<void> {
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    await writeFileAtomic(this.#file, `${JSON.stringify([...this.#items.values()])}\n`)
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.#file, 'utf8')) as unknown
      if (!Array.isArray(saved)) return
      for (const item of saved as HandOff[]) {
        if (typeof item?.id !== 'string') continue
        this.#items.set(item.id, item.state === 'running' ? { ...item, state: 'failed', reply: '软件关闭时它还没做完，这一轮中断了', endedAt: item.startedAt } : item)
      }
    } catch {
      // none yet
    }
  }
}
