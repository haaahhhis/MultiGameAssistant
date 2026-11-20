/**
 * Which model each agent works with (设置 → 模型), kept in
 * `<dataDir>/agent-models.json`. Nothing has to be set: each layer follows
 * the one above it until it is given a model of its own.
 *
 * - An agent's own conversations: its model, else the default model. 助手's
 *   is the default model itself, so it has no entry here.
 * - Its sub-agents (dsh's `subagent`, who do the concrete work): its
 *   sub-agents' model, else the one for every sub-agent, else whatever the
 *   agent that opened them is using at the time (dsh's own rule).
 *
 * 备用模型 (`fallbacks`): two lists, one for every agent's own conversations
 * and one for every sub-agent, tried in order when a model fails in a way
 * another would not (model-fallback.ts).
 *
 * Before this, one model served every role agent (`role-model.json`, 「角色
 * agent 的模型」): it carries over to the role agents there were then.
 */
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import type { ModelFallbacks, ModelSelection } from '@adg/protocol'
import { writeFileAtomic } from '@adg/protocol/node'

export interface AgentModelsState {
  /** Each agent's own model, by agent id. */
  readonly agents: Readonly<Record<string, ModelSelection>>
  /** Every agent's sub-agents. */
  readonly subAgents: ModelSelection | null
  /** One agent's sub-agents, by agent id: before `subAgents`. */
  readonly subAgentsOf: Readonly<Record<string, ModelSelection>>
  /** The fallback lists: every agent's own conversations, every sub-agent. */
  readonly fallbacks: ModelFallbacks
}

/** Whose model is set: an agent's own (`agentId`), its sub-agents' (`agentId` and `sub`), or every sub-agent's (`sub` alone). */
export interface AgentModelTarget {
  readonly agentId?: string | undefined
  readonly sub?: boolean | undefined
}

/** The role agents `role-model.json` served. */
const LEGACY_ROLES = ['intervene', 'games', 'scripts', 'pipelines']

const EMPTY: AgentModelsState = { agents: {}, subAgents: null, subAgentsOf: {}, fallbacks: { agents: [], subAgents: [] } }

export class AgentModels {
  readonly #file: string | undefined
  readonly #legacyFile: string | undefined
  #state: AgentModelsState = EMPTY
  readonly loaded: Promise<void>

  /** @param legacyFile - `role-model.json`, read when `file` was never written. */
  constructor(file: string | undefined, legacyFile?: string) {
    this.#file = file
    this.#legacyFile = legacyFile
    this.loaded = this.#load()
  }

  state(): AgentModelsState {
    return this.#state
  }

  /** The model set for an agent's own conversations; undefined: the default model. */
  of(agentId: string): ModelSelection | undefined {
    return this.#state.agents[agentId]
  }

  /** The model set for an agent's sub-agents (theirs, else every sub-agent's); undefined: the same as the agent. */
  subOf(agentId: string): ModelSelection | undefined {
    return this.#state.subAgentsOf[agentId] ?? this.#state.subAgents ?? undefined
  }

  /** The fallback list for the agents' own conversations (`sub` false) or for sub-agents. */
  fallbacksOf(sub: boolean): readonly ModelSelection[] {
    return sub ? this.#state.fallbacks.subAgents : this.#state.fallbacks.agents
  }

  /** Replace one fallback list; a model listed twice is kept once (the first). */
  async setFallbacks(sub: boolean, models: readonly ModelSelection[]): Promise<void> {
    await this.loaded
    const list = distinct(models.map(clean))
    this.#state = { ...this.#state, fallbacks: { ...this.#state.fallbacks, [sub ? 'subAgents' : 'agents']: list } }
    await this.#save()
  }

  /** @param selection - null: follow the layer above again. */
  async set(target: AgentModelTarget, selection: ModelSelection | null): Promise<void> {
    await this.loaded
    if (target.agentId === undefined && target.sub !== true) throw new Error('要说明是哪个 agent 的模型')
    const value = selection === null ? undefined : clean(selection)
    const without = (record: Readonly<Record<string, ModelSelection>>, key: string) => Object.fromEntries(Object.entries(record).filter(([k]) => k !== key))
    const put = (record: Readonly<Record<string, ModelSelection>>, key: string) => value === undefined ? without(record, key) : { ...record, [key]: value }
    const state = this.#state
    this.#state = target.sub !== true
      ? { ...state, agents: put(state.agents, target.agentId!) }
      : target.agentId === undefined
        ? { ...state, subAgents: value ?? null }
        : { ...state, subAgentsOf: put(state.subAgentsOf, target.agentId) }
    await this.#save()
  }

  async #save(): Promise<void> {
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    await writeFileAtomic(this.#file, `${JSON.stringify(this.#state)}\n`)
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return
    const saved = await readJson(this.#file)
    if (saved !== undefined) {
      const record = (value: unknown) => Object.fromEntries(Object.entries(isObject(value) ? value : {}).flatMap(([id, s]) => {
        const selection = selectionOf(s)
        return selection === undefined ? [] : [[id, selection]]
      }))
      const list = (value: unknown) => distinct(Array.isArray(value) ? value.flatMap(s => selectionOf(s) ?? []) : [])
      const state = isObject(saved) ? saved : {}
      const fallbacks = isObject(state['fallbacks']) ? state['fallbacks'] : {}
      this.#state = {
        agents: record(state['agents']), subAgents: selectionOf(state['subAgents']) ?? null, subAgentsOf: record(state['subAgentsOf']),
        fallbacks: { agents: list(fallbacks['agents']), subAgents: list(fallbacks['subAgents']) },
      }
      return
    }
    const legacy = this.#legacyFile === undefined ? undefined : selectionOf(await readJson(this.#legacyFile))
    if (legacy !== undefined) this.#state = { ...EMPTY, agents: Object.fromEntries(LEGACY_ROLES.map(id => [id, legacy])) }
  }
}

async function readJson(file: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as unknown
  } catch {
    return undefined
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function selectionOf(value: unknown): ModelSelection | undefined {
  if (!isObject(value) || typeof value['provider'] !== 'string' || typeof value['model'] !== 'string') return undefined
  return clean(value as ModelSelection)
}

function clean(selection: ModelSelection): ModelSelection {
  return { provider: selection.provider, model: selection.model, ...(typeof selection.reasoningEffort === 'string' ? { reasoningEffort: selection.reasoningEffort } : {}) }
}

/** Each model once (by service and model; the first one's thinking level), in order. */
function distinct(list: readonly ModelSelection[]): ModelSelection[] {
  const seen = new Set<string>()
  return list.filter(s => {
    const key = `${s.provider}/${s.model}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}
