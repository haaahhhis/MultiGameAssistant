/**
 * Agents the person makes (新建 agent, docs/design/agent-roles.md §9.2),
 * kept in `<dataDir>/agents.json`. Each becomes a role (roles.ts) like the
 * ones plugins register: its sessions are listed under it, and its agent is
 * narrowed to the tool groups it was given and told its duty. dsh's own
 * tools (files, commands, the web) stay with every agent.
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { MAX_AGENT_DUTY, MAX_AGENT_NAME, type AgentToolGroup, type UserAgent } from '@adg/protocol'
import { writeFileAtomic } from '@adg/protocol/node'
import type { RoleSpec } from './roles.ts'

/** The app's tools an agent can be given, a family at a time (`screen_*` as in RoleSpec.tools). */
export const TOOL_GROUPS: readonly (AgentToolGroup & { readonly tools: readonly string[] })[] = [
  { id: 'screen', name: '截图和点击', description: '看屏幕、点击、输入、切换窗口', tools: ['screen_*', 'window_*'] },
  { id: 'emulators', name: '模拟器', description: '查看、启动、关闭和配置模拟器', tools: ['emulator_*'] },
  { id: 'games', name: '游戏', description: '游戏库：读游戏、看活动、启动和关闭游戏', tools: ['game_*'] },
  { id: 'scripts', name: '脚本', description: '运行、安装、配置脚本，看运行记录和日志', tools: ['script_*', 'pack_*', 'skill_hub_*'] },
  { id: 'pipelines', name: '编排和定时', description: '查看和运行流水线，设定时任务', tools: ['pipeline_*', 'schedule_*'] },
  { id: 'monitor', name: '监控', description: '查看监控发现的异常', tools: ['monitor_*'] },
]

/** Every agent the person makes keeps these: what the machine is, and its skills. */
const ALWAYS = ['system_info', 'skill_focus', 'skill_save']

/** After the plugins' roles in the roster. */
const FIRST_ORDER = 100

/** The role an agent the person made stands as. */
export function roleOf(agent: UserAgent, order: number): RoleSpec {
  const line = agent.duty.split('\n').find(l => l.trim() !== '')?.trim() ?? ''
  return {
    id: agent.id,
    name: agent.name,
    description: line.length > 40 ? `${line.slice(0, 39)}…` : line,
    order: FIRST_ORDER + order,
    custom: true,
    tools: [...ALWAYS, ...TOOL_GROUPS.filter(g => agent.tools.includes(g.id)).flatMap(g => g.tools)],
    duty: `# 你的角色：${agent.name}\n\n${agent.duty}`,
  }
}

export class UserAgents {
  readonly #file: string | undefined
  #items: UserAgent[] = []
  readonly loaded: Promise<void>

  constructor(file: string | undefined) {
    this.#file = file
    this.loaded = this.#load()
  }

  list(): readonly UserAgent[] {
    return this.#items
  }

  get(id: string): UserAgent | undefined {
    return this.#items.find(a => a.id === id)
  }

  /**
   * Make one (no `id`) or change one.
   * @param taken - names in the roster already (the plugins' roles, 助手); the agent's own name is allowed.
   * @throws when the name is taken or empty, or the duty is empty or too long.
   */
  async save(input: Omit<UserAgent, 'id'> & { id?: string | undefined }, taken: readonly string[]): Promise<UserAgent> {
    await this.loaded
    const kept = input.id === undefined ? undefined : this.get(input.id)
    if (input.id !== undefined && kept === undefined) throw new Error('没有这个 agent，可能已经删掉了')
    const name = input.name.trim()
    const duty = input.duty.trim()
    if (name === '' || name.length > MAX_AGENT_NAME) throw new Error(`名字要 1–${MAX_AGENT_NAME} 个字`)
    if (duty === '' || duty.length > MAX_AGENT_DUTY) throw new Error(`职责要 1–${MAX_AGENT_DUTY} 个字`)
    const clash = name !== kept?.name && (taken.includes(name) || this.#items.some(a => a.id !== kept?.id && a.name === name))
    if (clash) throw new Error(`已经有叫「${name}」的 agent 了`)
    const agent: UserAgent = {
      id: kept?.id ?? `u-${randomUUID().slice(0, 8)}`,
      name,
      duty,
      tools: TOOL_GROUPS.map(g => g.id).filter(id => input.tools.includes(id)),
      model: input.model === null ? null : { provider: input.model.provider, model: input.model.model, ...(input.model.reasoningEffort === undefined ? {} : { reasoningEffort: input.model.reasoningEffort }) },
    }
    this.#items = kept === undefined ? [...this.#items, agent] : this.#items.map(a => (a.id === agent.id ? agent : a))
    await this.#save()
    return agent
  }

  /** @returns whether there was one. */
  async delete(id: string): Promise<boolean> {
    await this.loaded
    if (this.get(id) === undefined) return false
    this.#items = this.#items.filter(a => a.id !== id)
    await this.#save()
    return true
  }

  async #save(): Promise<void> {
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    await writeFileAtomic(this.#file, `${JSON.stringify(this.#items, null, 2)}\n`)
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.#file, 'utf8')) as unknown
      if (!Array.isArray(saved)) return
      for (const item of saved as Partial<UserAgent>[]) {
        if (typeof item?.id !== 'string' || typeof item.name !== 'string' || typeof item.duty !== 'string') continue
        const model = item.model as Partial<UserAgent['model']> | null | undefined
        this.#items.push({
          id: item.id,
          name: item.name,
          duty: item.duty,
          tools: Array.isArray(item.tools) ? item.tools.filter((t): t is string => typeof t === 'string') : [],
          model: typeof model?.provider === 'string' && typeof model.model === 'string' ? { provider: model.provider, model: model.model, ...(typeof model.reasoningEffort === 'string' ? { reasoningEffort: model.reasoningEffort } : {}) } : null,
        })
      }
    } catch {
      // none made yet
    }
  }
}
