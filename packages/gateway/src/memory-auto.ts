/**
 * Automatic memory (memory@1's `auto`): the agents write memory as they work
 * (memory.ts), but in a long, busy turn they forget to. So once a
 * conversation has been quiet for a while, what was said since the last pass
 * is read back from the session log and a model picks out what is worth
 * keeping — your preferences and conventions as 资料, what was done or decided
 * as 日记 — against what is already kept, so it adds or corrects instead of
 * repeating.
 *
 * Only a stretch where you yourself said something is read: the app's own
 * runs (pipelines, interventions) would cost a model call each time and keep
 * nothing about you. The log is the saved conversation, not the agent's
 * context, so compaction loses nothing here. Entries it writes are marked
 * `by: auto`; passwords, codes and keys are refused as for any other.
 */
import { readFile } from 'node:fs/promises'
import { z } from 'zod'
import { SHARED_MEMORY, type MemoryAutoSettings, type MemoryEntry, type ModelSelection, type SessionEvent } from '@adg/protocol'
import { writeFileAtomic } from '@adg/protocol/node'
import type { MemoryStore } from './memory.ts'

/** Who writes what this pass keeps. */
export const AUTO_AUTHOR = 'auto'
/** Quiet this long after a turn before it is read. */
export const DEFAULT_IDLE_MS = 5 * 60_000
/** Most of a conversation read in one pass (newest kept), and of one message. */
const MAX_CHARS = 14_000
const MAX_MESSAGE_CHARS = 2_000
/** Most entries one pass writes. */
const MAX_OPS = 6
/** Sessions whose place is remembered. */
const MAX_CURSORS = 2_000

export const DEFAULT_AUTO_SETTINGS: MemoryAutoSettings = { auto: true, model: null }

/** One message of a conversation as the pass reads it. */
export interface Exchange {
  readonly seq: number
  readonly time: number
  /** `user`: you; `app`: the app or another agent writing in; `agent`: this conversation's agent. */
  readonly from: 'user' | 'app' | 'agent'
  readonly text: string
}

const textOf = (content: readonly { type: string; text?: string }[]) => content.map(p => (p.type === 'text' ? p.text ?? '' : '')).join('').trim()

/** What was said after `after` (a seq): words only, no tool calls, reasoning or pictures. */
export function exchangesOf(events: readonly SessionEvent[], after: number): Exchange[] {
  const out: Exchange[] = []
  for (const event of events) {
    if (event.seq <= after) continue
    if (event.type === 'user/message') {
      const text = textOf(event.content)
      if (text !== '') out.push({ seq: event.seq, time: event.time, from: event.origin.human ? 'user' : 'app', text })
    } else if (event.type === 'assistant/message') {
      const text = textOf(event.content)
      if (text !== '') out.push({ seq: event.seq, time: event.time, from: 'agent', text })
    }
  }
  return out
}

/** The newest messages that fit, each cut to its share. */
function fit(exchanges: readonly Exchange[]): Exchange[] {
  const kept: Exchange[] = []
  let total = 0
  for (let i = exchanges.length - 1; i >= 0; i--) {
    const e = exchanges[i]!
    const text = e.text.length > MAX_MESSAGE_CHARS ? `${e.text.slice(0, MAX_MESSAGE_CHARS)}…（后面省略）` : e.text
    if (total + text.length > MAX_CHARS && kept.length > 0) break
    kept.unshift({ ...e, text })
    total += text.length
  }
  return kept
}

function day(time: number | string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(time))
}

/** The model's instructions: what is worth keeping, and the one JSON shape to answer in. */
export function extractionSystem(agentName: string, today: string): string {
  return [
    `你在为 MultiGameAssistant（多游戏助手，帮用户安装、调度和看护各游戏的日常脚本）整理长期记忆。下面是 agent「${agentName}」最近的一段对话和已经记下的记忆。找出值得长期记住、但还没记下的事。今天是 ${today}。`,
    '',
    '只输出一个 JSON 对象，不要别的文字：{"ops":[...]}；没有要记的就输出 {"ops":[]}。每个 op 是下面一种：',
    '- {"op":"add","kind":"profile","shared":true,"text":"…"}：资料，长期有效的事实和偏好',
    '- {"op":"add","kind":"journal","shared":true,"text":"…"}：日记，做过、定过的事',
    '- {"op":"replace","id":"已有记忆的 id","text":"…"}：已有的那条过时了或不准了，改成现在的说法',
    '',
    '规则：',
    '- 资料只来自【用户】亲口说的话：怎么称呼、偏好和习惯、电脑设备和环境、玩哪些游戏和哪个服、定下的规矩和分工、对 agent 的纠正和要求。agent 的猜测和【软件】的消息不算资料。',
    '- 日记记结果：装好或更新了什么、改了哪条流水线或定时、解决了什么问题、用户决定了什么或拒绝了什么、还有什么没做完。写具体日期，不写「今天」「明天」。不记闲聊、做到一半的过程、失败的尝试，也不记随时能在软件里查到的状态（脚本列表、运行记录、活动日历）。',
    '- 已有记忆里说过的不要再记；同一件事说法变了，用 replace 改那一条。',
    '- 一条只写一件事，一句话，不看这段对话也读得懂：写清楚是哪个游戏、哪个脚本、具体的名字和数字。',
    `- shared：所有 agent 都该知道的（称呼、偏好、设备、通用的约定、重要的事）为 true；只和「${agentName}」自己的工作有关的为 false。`,
    '- 绝对不记密码、验证码、密钥、token、cookie 和账号的登录信息。',
    `- 宁缺毋滥：拿不准就不记。最多 ${MAX_OPS} 条。`,
  ].join('\n')
}

/** What the model reads: what is kept, then the conversation. */
export function extractionPrompt(memories: readonly MemoryEntry[], exchanges: readonly Exchange[], agentId: string, timeZone?: string): string {
  const where = (e: MemoryEntry) => (e.scope === SHARED_MEMORY ? '共享' : e.scope === agentId ? '这个 agent 自己的' : e.scope)
  const kept = memories.length === 0
    ? '（还没有）'
    : memories.map(e => `- [${e.id}] (${e.kind === 'profile' ? '资料' : '日记'}，${where(e)}，${day(e.kind === 'journal' ? e.createdAt : e.updatedAt, timeZone)}) ${e.text}`).join('\n')
  const who = { user: '用户', app: '软件', agent: 'agent' } as const
  const talk = fit(exchanges).map(e => `【${who[e.from]}】(${day(e.time, timeZone)}) ${e.text}`).join('\n\n')
  return `# 已有的记忆\n${kept}\n\n# 最近的对话\n${talk}`
}

const Op = z.discriminatedUnion('op', [
  z.object({ op: z.literal('add'), kind: z.enum(['profile', 'journal']), shared: z.boolean().optional(), text: z.string().min(1) }),
  z.object({ op: z.literal('replace'), id: z.string().min(1), text: z.string().min(1) }),
])
export type MemoryOp = z.infer<typeof Op>

/** The ops in the model's answer; anything malformed is dropped, not guessed at. */
export function parseOps(answer: string): MemoryOp[] {
  const body = answer.replace(/^[\s\S]*?```(?:json)?\s*([\s\S]*?)```[\s\S]*$/, '$1')
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end < start) return []
  let value: unknown
  try { value = JSON.parse(body.slice(start, end + 1)) } catch { return [] }
  const ops = (value as { ops?: unknown } | null)?.ops
  if (!Array.isArray(ops)) return []
  return ops.flatMap(op => { const parsed = Op.safeParse(op); return parsed.success ? [parsed.data] : [] }).slice(0, MAX_OPS)
}

export interface Applied {
  readonly added: number
  readonly replaced: number
  /** Refused (a secret, too long) or not its to change. */
  readonly skipped: number
}

/** Write the ops as `auto`, into what this agent reads. */
export async function applyOps(store: MemoryStore, ops: readonly MemoryOp[], agentId: string): Promise<Applied> {
  let added = 0
  let replaced = 0
  let skipped = 0
  for (const op of ops) {
    try {
      if (op.op === 'add') {
        await store.add({ kind: op.kind, scope: op.shared === false ? agentId : SHARED_MEMORY, text: op.text, by: AUTO_AUTHOR })
        added++
      } else {
        const entry = store.get(op.id)
        if (entry === undefined || (entry.scope !== SHARED_MEMORY && entry.scope !== agentId)) { skipped++; continue }
        if (entry.text === op.text.replace(/\s+/g, ' ').trim()) continue
        await store.update(entry.id, { text: op.text }, AUTO_AUTHOR)
        replaced++
      }
    } catch {
      skipped++
    }
  }
  return { added, replaced, skipped }
}

export interface AutoMemoryDeps {
  readonly store: MemoryStore
  /** `<dataDir>/memory-auto.json`: the settings and how far each conversation was read. */
  readonly file: string | undefined
  /** The session's recent events (enough for a pass). */
  readonly read: (sessionId: string, signal: AbortSignal) => Promise<readonly SessionEvent[]>
  /** The lead agent working in a session of the app's; undefined: not read (sub-agents, other chats). */
  readonly agentOf: (sessionId: string) => { readonly id: string; readonly name: string } | undefined
  /** The model to use when none is set: the default one. */
  readonly defaultModel: () => ModelSelection | undefined
  /** One model call; resolves to its text. */
  readonly complete: (request: { selection: ModelSelection; system: string; prompt: string; signal: AbortSignal }) => Promise<string>
  readonly log: { info(message: string): void; warn(message: string): void }
  readonly idleMs?: number
  readonly timeZone?: string
  /** On whatever the switch says: low-context mode keeps it on, since compaction leaves only the summary. */
  readonly forced?: () => boolean
}

/** What one pass did, for the log and tests. */
export type PassOutcome =
  | { readonly kind: 'skipped'; readonly why: string }
  | ({ readonly kind: 'done' } & Applied)

export class AutoMemory {
  readonly #deps: AutoMemoryDeps
  readonly #timers = new Map<string, ReturnType<typeof setTimeout>>()
  #settings: MemoryAutoSettings = DEFAULT_AUTO_SETTINGS
  #cursors = new Map<string, number>()
  /** One pass at a time: each one calls a model. */
  #queue: Promise<unknown> = Promise.resolve()
  readonly #stop = new AbortController()
  readonly loaded: Promise<void>

  constructor(deps: AutoMemoryDeps) {
    this.#deps = deps
    this.loaded = this.#load()
  }

  get settings(): MemoryAutoSettings {
    return this.#settings
  }

  /** Kept on by low-context mode, whatever the switch says. */
  get forced(): boolean {
    return this.#deps.forced?.() === true
  }

  /** Does it read conversations now? */
  get on(): boolean {
    return this.#settings.auto || this.forced
  }

  async setSettings(settings: MemoryAutoSettings): Promise<MemoryAutoSettings> {
    await this.loaded
    this.#settings = settings
    if (!this.on) this.#clearTimers()
    await this.#save()
    return settings
  }

  /** A session started or stopped working: read it once it has been quiet for a while. */
  activity(sessionId: string, running: boolean): void {
    const timer = this.#timers.get(sessionId)
    if (timer !== undefined) clearTimeout(timer)
    this.#timers.delete(sessionId)
    if (running || !this.on || this.#stop.signal.aborted) return
    if (this.#deps.agentOf(sessionId) === undefined) return
    const next = setTimeout(() => {
      this.#timers.delete(sessionId)
      void this.run(sessionId).then(
        outcome => { if (outcome.kind === 'done' && outcome.added + outcome.replaced > 0) this.#deps.log.info(`memory from ${sessionId}: ${outcome.added} added, ${outcome.replaced} changed`) },
        error => this.#deps.log.warn(`memory from ${sessionId}: ${error instanceof Error ? error.message : String(error)}`),
      )
    }, this.#deps.idleMs ?? DEFAULT_IDLE_MS)
    next.unref?.()
    this.#timers.set(sessionId, next)
  }

  /** Read what is new in a session and keep what is worth it (queued behind any pass under way). */
  run(sessionId: string): Promise<PassOutcome> {
    const pass = this.#queue.then(() => this.#pass(sessionId))
    this.#queue = pass.catch(() => {})
    return pass
  }

  dispose(): void {
    this.#stop.abort()
    this.#clearTimers()
  }

  async #pass(sessionId: string): Promise<PassOutcome> {
    await this.loaded
    await this.#deps.store.loaded
    if (!this.on) return { kind: 'skipped', why: 'off' }
    const agent = this.#deps.agentOf(sessionId)
    if (agent === undefined) return { kind: 'skipped', why: 'not an agent of the app' }
    const signal = AbortSignal.any([this.#stop.signal, AbortSignal.timeout(120_000)])
    const events = await this.#deps.read(sessionId, signal)
    const after = this.#cursors.get(sessionId) ?? -1
    const exchanges = exchangesOf(events, after)
    const last = Math.max(after, ...events.map(e => e.seq))
    // Nothing from you, or no answer yet: nothing to learn about you (and the app's own runs cost nothing).
    if (!exchanges.some(e => e.from === 'user') || !exchanges.some(e => e.from === 'agent')) {
      await this.#moveTo(sessionId, last)
      return { kind: 'skipped', why: 'nothing said by the user' }
    }
    const selection = this.#settings.model ?? this.#deps.defaultModel()
    if (selection === undefined) return { kind: 'skipped', why: 'no model' }
    const memories = this.#deps.store.visibleTo(agent.id)
    const answer = await this.#deps.complete({
      selection,
      system: extractionSystem(agent.name, day(Date.now(), this.#deps.timeZone)),
      prompt: extractionPrompt(memories, exchanges, agent.id, this.#deps.timeZone),
      signal,
    })
    const applied = await applyOps(this.#deps.store, parseOps(answer), agent.id)
    await this.#moveTo(sessionId, last)
    return { kind: 'done', ...applied }
  }

  async #moveTo(sessionId: string, seq: number): Promise<void> {
    if (seq < 0 || this.#cursors.get(sessionId) === seq) return
    this.#cursors.delete(sessionId)
    this.#cursors.set(sessionId, seq)
    while (this.#cursors.size > MAX_CURSORS) this.#cursors.delete(this.#cursors.keys().next().value!)
    await this.#save()
  }

  #clearTimers(): void {
    for (const timer of this.#timers.values()) clearTimeout(timer)
    this.#timers.clear()
  }

  async #load(): Promise<void> {
    if (this.#deps.file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.#deps.file, 'utf8')) as { settings?: unknown; cursors?: unknown }
      const settings = z.object({ auto: z.boolean(), model: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }).nullable() }).safeParse(saved.settings)
      if (settings.success) this.#settings = settings.data
      if (typeof saved.cursors === 'object' && saved.cursors !== null) {
        for (const [id, seq] of Object.entries(saved.cursors)) if (typeof seq === 'number') this.#cursors.set(id, seq)
      }
    } catch {
      // none yet
    }
  }

  async #save(): Promise<void> {
    if (this.#deps.file === undefined) return
    await writeFileAtomic(this.#deps.file, `${JSON.stringify({ settings: this.#settings, cursors: Object.fromEntries(this.#cursors) })}\n`)
  }
}
