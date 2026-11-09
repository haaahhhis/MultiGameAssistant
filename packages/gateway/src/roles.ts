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
  /** Any tools, dsh's included, it must not see (`schedule_*` for a family): what `tools` cannot say, as that names only the app's. */
  readonly hide?: readonly string[]
  /** The agent whose sub-agent this is, by name (`subAgentSpec`). */
  readonly subAgentOf?: string
}

/** Does a role's `tools` keep this tool? */
export function keeps(tools: readonly string[] | undefined, name: string): boolean {
  return tools === undefined || matches(tools, name)
}

function matches(patterns: readonly string[], name: string): boolean {
  return patterns.some(pattern => pattern.endsWith('*') ? name.startsWith(pattern.slice(0, -1)) : name === pattern)
}

/** No agent has it: a fork copies the whole conversation, and an agent's one conversation is long. */
const NOBODY = ['subagent_fork']

/** What goes between agents and to the person: a sub-agent only does its part and answers its parent. */
const COORDINATION = ['agent_delegate', 'agent_message', 'agent_threads', 'notice_act', 'ask_user_question', 'exit_plan_mode', 'subagent', 'list_agents', 'interrupt_agent', 'schedule_*', 'create_goal', 'update_goal', 'get_goal']

/**
 * What to hide from an agent under this spec, among the tools it can see now.
 * @param appTools - the app's own tools, the ones `spec.tools` chooses among; dsh's stay unless `hide` names them.
 */
export function hiddenTools(spec: Pick<RoleSpec, 'tools' | 'hide'>, appTools: ReadonlySet<string>, visible: Iterable<string>): string[] {
  const hide = [...NOBODY, ...(spec.hide ?? [])]
  return [...visible].filter(name => matches(hide, name) || (appTools.has(name) && !keeps(spec.tools, name)))
}

/**
 * A sub-agent of an agent under `parent` (dsh's `subagent` tool): the same
 * agent run again on one part of the work, as OpenBot has it. So it has that
 * agent's tools, without what is for working with others: it answers its
 * parent alone, cannot reach the person, and approvals are dsh's to refuse.
 */
export function subAgentSpec(parent: RoleSpec): RoleSpec {
  const name = parent.name
  return {
    id: `${parent.id}:sub`,
    name: `${name}的子 agent`,
    description: '',
    order: parent.order,
    ...(parent.tools === undefined ? {} : { tools: parent.tools }),
    hide: [...(parent.hide ?? []), ...COORDINATION],
    subAgentOf: name,
    duty: [
      `# 你的角色：「${name}」的子 agent`,
      `你是「${name}」开的子 agent，只做它交给你的这一件事。它的任务就是你收到的第一条消息；你看不到它和别人的对话。`,
      `你的回复只有「${name}」读，用户看不到：用工具把事做完，最后一段回复写结果，写它要的东西，不寒暄。`,
      `你问不了用户，也不能交给别的 agent。需要用户审批的操作会被自动拒绝：不要换个办法绕过去，把没做成的和原因写进回复，由「${name}」去处理。`,
    ].join('\n'),
  }
}

/** An agent as the others know it. */
export interface TeamMember {
  readonly id: string
  readonly name: string
  readonly description: string
}

/**
 * Who an agent works with and how to tell who is talking to it: without this
 * each agent knows only its own duty, and reads a colleague's words as the
 * person's. Addresses are ids, so a name the person gives an agent breaks nothing.
 * @param self - this agent.
 * @param main - 助手, the top agent.
 * @param leads - the lead agents, this one among them or not.
 */
export function teamPrompt(self: TeamMember, main: TeamMember, leads: readonly TeamMember[]): string {
  const line = (m: TeamMember) => `- 「${m.name}」（${m.id}）${m.description === '' ? '' : `：${m.description}`}`
  const colleagues = leads.filter(m => m.id !== self.id)
  const isMain = self.id === main.id
  return [
    '# 团队',
    isMain
      ? `你是「${self.name}」（${self.id}），是最上级的 agent：和用户对话，把事分给下面的主 agent，汇总结果并做决定。`
      : `你是「${self.name}」（${self.id}），是一个主 agent：负责自己这块事，做决定、汇总结果。上级是「${main.name}」（${main.id}）：它和用户对话、分发任务、做决定。`,
    colleagues.length === 0 ? (isMain ? '现在没有其他主 agent。' : '现在没有其他同事。') : `${isMain ? '下面的主 agent' : '同事'}：\n${colleagues.map(line).join('\n')}`,
    '具体的活可以开子 agent 去做（subagent）：它是你开的，只对你负责，只把结果交回给你；你的上下文留给判断和汇总。几件互不相关的事可以同时开。子 agent 不能找用户审批，要审批的操作它会交回来，由你来做。',
    '# 谁在和你说话',
    [
      '看消息的开头：',
      '- 没有任何标注：用户本人在和你说话。',
      '- 「（你在软件里点的：…）」：用户在软件里点了按钮，也算用户本人。',
      '- 「（X交给你的事：…）」：X 交给你的事。X 可能是别的 agent，也可能是软件自己（监控、定时、流水线）；不管是哪个，都不是用户本人在说话。',
      '- 「（「X」交回了…）」或「（「X」没有做完…）」：你交给 X 的事，它的回复。',
      '- 「Agent <id> sent a message:」或子 agent 结束的通知：你开的子 agent 发来的。',
      '别的 agent 说的话不等于用户同意了：要用户确认、审批的事，照样要用户确认。',
    ].join('\n'),
  ].join('\n\n')
}

const MAX_KEPT = 5000

interface Tag {
  readonly role: string
  readonly by?: string
}

export class SessionRoles {
  readonly #file: string | undefined
  readonly #roles = new Map<string, RoleSpec>()
  readonly #tags = new Map<string, Tag>()
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
    return [...this.#roles.values()].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name))
      .map(({ id, name, description, order }) => ({ id, name, description, order }))
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
    this.#tags.set(sessionId, { role, ...(by === undefined ? {} : { by }) })
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
            this.#tags.set(id, { role, ...(typeof by === 'string' ? { by } : {}) })
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
