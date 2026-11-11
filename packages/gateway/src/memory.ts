/**
 * Long-term memory (memory@1, @adg/protocol memory.ts): notes about the user
 * that last across conversations, kept in `<dataDir>/memory.json`.
 *
 * Skills keep how to do a job; this keeps who the user is and what happened:
 * - profile (资料): lasting facts and preferences, all of them in the prompt;
 * - journal (日记): what was done or decided on a day, the recent ones in the
 *   prompt, older ones found with `memory_search`.
 * Each entry is shared (every agent reads it) or one agent's own. Agents
 * write them with `memory_save` / `memory_forget` as they work; the user sees
 * and changes them on 设置 → 记忆. Passwords, codes and keys are refused.
 */
import { readFile } from 'node:fs/promises'
import { randomBytes } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { MAX_MEMORY_TEXT, MemoryEntry, MemoryKind, SHARED_MEMORY } from '@adg/protocol'
import { writeFileAtomic } from '@adg/protocol/node'

/** Most profile entries in the prompt (newest first), and their total length. */
const PROMPT_PROFILE = 80
const PROMPT_PROFILE_CHARS = 8000
/** Journal entries in the prompt: the newest, from the last days only. */
const PROMPT_JOURNAL = 12
const PROMPT_JOURNAL_DAYS = 30
/** Kept at most; the oldest journal entries go first. */
const MAX_ENTRIES = 2000

/**
 * Looks like a password, a one-time code or a key: never kept, even when asked.
 * A word for one followed by a value, or a token of a known shape, or a long
 * random-looking string (a full commit hash, plain hex, is not one).
 */
export function looksSecret(text: string): boolean {
  if (/(密码|口令|验证码|动态码|password|passwd|passcode|pwd|token|api[\s_-]?key|secret|私钥|cookie)\s*(是|为|[:：=])\s*\S{4,}/i.test(text)) return true
  if (/\b(sk-[A-Za-z0-9_-]{16,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|AKIA[0-9A-Z]{16}|xox[abpr]-[A-Za-z0-9-]{10,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})/.test(text)) return true
  for (const blob of text.match(/[A-Za-z0-9+/_=-]{32,}/g) ?? []) {
    if (/^[0-9a-f]+$/i.test(blob)) continue
    if (/[a-z]/.test(blob) && /[A-Z]/.test(blob) && /[0-9]/.test(blob)) return true
  }
  return false
}

const SECRET_REFUSAL = '这条像是密码、验证码或密钥：这类东西不写进记忆（用户让记也不记）。把它去掉再记，或者告诉用户为什么不记。'

export interface MemoryWrite {
  readonly kind: MemoryKind
  /** `shared`, or the agent's id whose own it is. */
  readonly scope: string
  readonly text: string
  /** An agent id, or `user`. */
  readonly by: string
}

export class MemoryStore {
  readonly #file: string | undefined
  readonly #changed: (() => void) | undefined
  #items: MemoryEntry[] = []
  readonly loaded: Promise<void>

  constructor(file: string | undefined, changed?: () => void) {
    this.#file = file
    this.#changed = changed
    this.loaded = this.#load()
  }

  /** Every entry, newest first. */
  list(): MemoryEntry[] {
    return [...this.#items].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
  }

  /** What one agent reads: the shared entries and its own, newest first. */
  visibleTo(agentId: string): MemoryEntry[] {
    return this.list().filter(entry => entry.scope === SHARED_MEMORY || entry.scope === agentId)
  }

  get(id: string): MemoryEntry | undefined {
    return this.#items.find(entry => entry.id === id)
  }

  /** Write one; the same text already kept in the same place is touched, not written twice. */
  async add(write: MemoryWrite, now = new Date()): Promise<MemoryEntry> {
    await this.loaded
    const text = clean(write.text)
    const same = this.#items.find(entry => entry.kind === write.kind && entry.scope === write.scope && entry.text === text)
    if (same !== undefined) return this.update(same.id, { text }, write.by, now)
    const at = now.toISOString()
    const entry: MemoryEntry = { id: newId(now), kind: write.kind, scope: write.scope, text, createdAt: at, updatedAt: at, by: write.by }
    this.#items.push(entry)
    this.#trim()
    await this.#save()
    return entry
  }

  async update(id: string, change: { text: string; kind?: MemoryKind; scope?: string }, by: string, now = new Date()): Promise<MemoryEntry> {
    await this.loaded
    const index = this.#items.findIndex(entry => entry.id === id)
    if (index < 0) throw new Error(`没有这条记忆：${id}`)
    const entry: MemoryEntry = {
      ...this.#items[index]!,
      text: clean(change.text),
      ...(change.kind === undefined ? {} : { kind: change.kind }),
      ...(change.scope === undefined ? {} : { scope: change.scope }),
      updatedAt: now.toISOString(),
      by,
    }
    this.#items[index] = entry
    await this.#save()
    return entry
  }

  async remove(id: string): Promise<boolean> {
    await this.loaded
    const before = this.#items.length
    this.#items = this.#items.filter(entry => entry.id !== id)
    if (this.#items.length === before) return false
    await this.#save()
    return true
  }

  /**
   * Entries one agent reads that hold every word of the query (any case);
   * no words: the newest. Chinese has no spaces, so a word is a substring.
   */
  search(agentId: string, query: string, options: { kind?: MemoryKind; limit?: number } = {}): MemoryEntry[] {
    const words = query.toLowerCase().split(/\s+/).filter(word => word !== '')
    return this.visibleTo(agentId)
      .filter(entry => options.kind === undefined || entry.kind === options.kind)
      .filter(entry => words.every(word => entry.text.toLowerCase().includes(word)))
      .slice(0, options.limit ?? 30)
  }

  /** Over the limit: the oldest journal entries go, then the oldest of all. */
  #trim(): void {
    while (this.#items.length > MAX_ENTRIES) {
      const oldest = (list: MemoryEntry[]) => list.reduce((a, b) => (a.updatedAt <= b.updatedAt ? a : b))
      const journal = this.#items.filter(entry => entry.kind === 'journal')
      const drop = oldest(journal.length > 0 ? journal : this.#items)
      this.#items = this.#items.filter(entry => entry !== drop)
    }
  }

  async #load(): Promise<void> {
    if (this.#file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.#file, 'utf8')) as { items?: unknown }
      const items = Array.isArray(saved.items) ? saved.items : []
      this.#items = items.flatMap(item => { const parsed = MemoryEntry.safeParse(item); return parsed.success ? [parsed.data] : [] })
    } catch {
      // none yet
    }
  }

  async #save(): Promise<void> {
    if (this.#file !== undefined) await writeFileAtomic(this.#file, `${JSON.stringify({ version: 1, items: this.#items }, null, 1)}\n`)
    this.#changed?.()
  }
}

function clean(text: string): string {
  const trimmed = text.replace(/\s+/g, ' ').trim()
  if (trimmed === '') throw new Error('记忆不能是空的')
  if (trimmed.length > MAX_MEMORY_TEXT) throw new Error(`一条记忆最多 ${MAX_MEMORY_TEXT} 个字：只写一件事，拆成几条记`)
  if (looksSecret(trimmed)) throw new Error(SECRET_REFUSAL)
  return trimmed
}

function newId(now: Date): string {
  return `m${now.getTime().toString(36)}${randomBytes(2).toString('hex')}`
}

/** The day an entry was written, in the user's time zone. */
function day(iso: string, timeZone: string | undefined): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).format(new Date(iso))
}

/** How agents write memory: in every lead agent's prompt, entries or not, so it starts writing. */
const HOW_TO_WRITE = [
  '## 什么时候记、怎么记',
  '- 用户说起自己的事（怎么称呼、偏好和习惯、用的电脑和设备、玩哪些游戏和账号情况、定下的分工和规矩）、纠正你、或者说「记住…」时，马上用 memory_save 记成资料（kind=profile）。',
  '- 一件事做完或有了结论（装好或更新了脚本、改了流水线或定时、解决了一个问题、用户做了决定或拒绝了什么），这一轮结束前用 memory_save 记一条日记（kind=journal）：做了什么、结果怎样、还剩什么没做。不记过程和闲聊，也不记一眼就能从软件里查到的状态。',
  '- 一条只写一件事，写成以后不看这次对话也看得懂的一句话：哪个游戏、哪个脚本、具体的名字和数字照实写；「今天」「明天」「下周」换成具体日期。',
  '- 先看上面有没有同一件事：有就用 replaces 改那一条，不要重复记；过时了或记错了用 memory_forget 删掉。用户说「忘掉…」「别记…」就删。',
  '- 所有 agent 都该知道的（称呼、偏好、设备和习惯、大家都要守的约定）记成共享（shared=true）；只和你自己的工作有关的记成你自己的。',
  '- 不记密码、验证码、密钥、token、cookie，用户让记也不记，告诉用户为什么。',
  '- 记忆和技能是两回事：一件事一步步怎么做，存成技能（skill_save）；用户是谁、喜欢什么、约定了什么、做过什么，记进记忆。',
  '- 用户问你记得什么，照实说（按需用 memory_search 查全）；用户也可以在「设置 → 记忆」里看、改、删。',
].join('\n')

/**
 * The memory section of one agent's system prompt: all its profile entries,
 * the recent journal ones, and how to write more. A sub-agent reads the same,
 * without writing (its lead keeps the memory).
 * @param lead - the name of the agent a sub-agent works for; absent for a lead agent.
 */
export function memoryPrompt(entries: readonly MemoryEntry[], agentId: string, options: { now?: Date; timeZone?: string; lead?: string } = {}): string {
  const now = options.now ?? new Date()
  const where = (entry: MemoryEntry) => (entry.scope === SHARED_MEMORY ? '共享' : entry.scope === agentId ? '你自己的' : entry.scope)
  // A journal entry is dated by when it happened; a profile entry by when it was last true.
  const line = (entry: MemoryEntry) => `- [${entry.id}] (${day(entry.kind === 'journal' ? entry.createdAt : entry.updatedAt, options.timeZone)}，${where(entry)}) ${entry.text}`

  const profile: string[] = []
  let chars = 0
  const allProfile = entries.filter(entry => entry.kind === 'profile')
  for (const entry of allProfile) {
    const text = line(entry)
    if (profile.length >= PROMPT_PROFILE || chars + text.length > PROMPT_PROFILE_CHARS) break
    profile.push(text)
    chars += text.length
  }
  const since = now.getTime() - PROMPT_JOURNAL_DAYS * 86_400_000
  const allJournal = entries.filter(entry => entry.kind === 'journal')
  const journal = allJournal.filter(entry => Date.parse(entry.updatedAt) >= since).slice(0, PROMPT_JOURNAL)

  const parts = [
    '# 长期记忆',
    entries.length === 0
      ? '你还没有关于用户的记忆。下面写了什么时候该记。'
      : '下面是之前的对话里记下的关于用户的事（「共享」的所有 agent 都看得到，「你自己的」只有你看得到）。照着用，不用向用户复述；和用户现在说的不一样时以现在说的为准，并更新记忆。方括号里是这条的 id。',
  ]
  if (profile.length > 0) parts.push(['## 资料', ...profile, ...(allProfile.length > profile.length ? [`（还有 ${allProfile.length - profile.length} 条较早的资料，用 memory_search 查）`] : [])].join('\n'))
  if (journal.length > 0 || allJournal.length > 0) {
    parts.push(['## 近期日记', ...(journal.length === 0 ? ['（最近没有）'] : journal.map(line)), ...(allJournal.length > journal.length ? [`（更早的 ${allJournal.length - journal.length} 条日记不在这里，要用时用 memory_search 查）`] : [])].join('\n'))
  }
  parts.push(options.lead === undefined ? HOW_TO_WRITE : `这些只供参考：你是子 agent，不写记忆。发现值得记的（用户的偏好、做成的事），写进交给「${options.lead}」的回复里，由它去记。`)
  return parts.join('\n\n')
}

export interface MemoryToolDeps {
  readonly store: MemoryStore
  /** The agent working in a session (`main`, a role's id); undefined: not one of the app's. */
  readonly agentOf: (sessionId: string) => string | undefined
}

const SaveArgs = z.object({
  text: z.string(),
  kind: MemoryKind,
  shared: z.boolean().nullish(),
  replaces: z.string().nullish(),
})
const ForgetArgs = z.object({ id: z.string().min(1) })
const SearchArgs = z.object({ query: z.string().nullish(), kind: MemoryKind.nullish(), limit: z.number().int().min(1).max(100).nullish() })

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args ?? {})
  if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
  return parsed.data
}

const render = (_args: unknown, value: unknown): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }]

function caller(deps: MemoryToolDeps, exec: { agent?: { session: { id: string } } }): string {
  const agent = exec.agent === undefined ? undefined : deps.agentOf(exec.agent.session.id)
  if (agent === undefined) throw new Error('只有本软件的 agent 能用记忆')
  return agent
}

/** One the caller reads (shared or its own); others are not its to change. */
function own(deps: MemoryToolDeps, agent: string, id: string): MemoryEntry {
  const entry = deps.store.get(id)
  if (entry === undefined || (entry.scope !== SHARED_MEMORY && entry.scope !== agent)) throw new Error(`没有这条记忆：${id}（用 memory_search 查 id）`)
  return entry
}

const brief = (entry: MemoryEntry) => ({ id: entry.id, kind: entry.kind, shared: entry.scope === SHARED_MEMORY, date: entry.updatedAt.slice(0, 10), text: entry.text })

export function memoryTools(deps: MemoryToolDeps): ToolDefinition[] {
  const save: ToolDefinition = {
    name: 'memory_save',
    description: [
      '把关于用户的一件事记进长期记忆，以后的新对话里也记得。',
      'kind=profile（资料）：长期有效的事实和偏好——怎么称呼、喜欢怎样、设备和环境、约定的分工和规矩；kind=journal（日记）：哪天做了什么、定了什么、解决了什么、还剩什么。',
      '一条只写一件事，一句话写清楚，日期写具体的。shared=true 所有 agent 都能看到（偏好、称呼、大家都要守的约定），否则只有你自己看到。',
      '已经记过同一件事就用 replaces 填那条的 id 改它，不要再加一条。怎么做一件事的步骤不记在这里，那是技能（skill_save）。不记密码、验证码、密钥。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        text: { type: 'string', description: `这条记忆，一句话（最多 ${MAX_MEMORY_TEXT} 字）。` },
        kind: { type: 'string', enum: ['profile', 'journal'], description: 'profile：资料（长期事实、偏好、约定）；journal：日记（做过、定过的事）。' },
        shared: { type: 'boolean', description: '所有 agent 都能看到（可选，默认只有你自己）。' },
        replaces: { type: 'string', description: '要改的那条记忆的 id（可选）。' },
      },
      required: ['text', 'kind'],
      additionalProperties: false,
    },
    output: { schema: {}, render },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const agent = caller(deps, exec)
      const { text, kind, shared, replaces } = parse(SaveArgs, args)
      if (replaces != null && replaces !== '') {
        const old = own(deps, agent, replaces)
        const scope = shared == null ? old.scope : shared ? SHARED_MEMORY : agent
        const entry = await deps.store.update(old.id, { text, kind, scope }, agent)
        return { saved: brief(entry), replaced: old.text } as never
      }
      const entry = await deps.store.add({ kind, scope: shared === true ? SHARED_MEMORY : agent, text, by: agent })
      return { saved: brief(entry), note: '已记下，以后的对话里都记得' } as never
    },
    presentCall: args => {
      const a = (args ?? {}) as { text?: unknown; kind?: unknown }
      return { card: 'generic', title: `${a.kind === 'journal' ? '记日记' : '记住'}：${String(a.text ?? '').slice(0, 60)}`, kind: 'other' }
    },
  }
  const forget: ToolDefinition = {
    name: 'memory_forget',
    description: '从长期记忆里删掉一条（过时了、记错了、用户说「忘掉」）。id 在系统提示的记忆里或用 memory_search 查。',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '记忆的 id。' } }, required: ['id'], additionalProperties: false },
    output: { schema: {}, render },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const agent = caller(deps, exec)
      const entry = own(deps, agent, parse(ForgetArgs, args).id)
      await deps.store.remove(entry.id)
      return { forgot: brief(entry) } as never
    },
    presentCall: () => ({ card: 'generic', title: '忘掉一条记忆', kind: 'other' }),
  }
  const search: ToolDefinition = {
    name: 'memory_search',
    description: '查长期记忆（共享的和你自己的），包括系统提示里没放下的较早日记。query 写几个关键词（空格分开，全部包含才算）；不写就列出最新的。用户问「之前…」「上次…」「我说过…」时先查这里。',
    parameters: {
      type: 'object',
      properties: {
        query: { type: 'string', description: '关键词，空格分开（可选）。' },
        kind: { type: 'string', enum: ['profile', 'journal'], description: '只查资料或只查日记（可选）。' },
        limit: { type: 'number', description: '最多几条（默认 30）。' },
      },
      additionalProperties: false,
    },
    output: { schema: {}, render },
    timeoutMs: 10_000,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const agent = caller(deps, exec)
      const { query, kind, limit } = parse(SearchArgs, args)
      await deps.store.loaded
      const found = deps.store.search(agent, query ?? '', { ...(kind == null ? {} : { kind }), ...(limit == null ? {} : { limit }) })
      return { items: found.map(brief), ...(found.length === 0 ? { note: '没有找到。换个说法再查，或者就是没记过。' } : {}) } as never
    },
    presentCall: args => ({ card: 'generic', title: `查记忆：${String((args as { query?: unknown } | undefined)?.query ?? '最新的')}`, kind: 'other' }),
  }
  return [save, forget, search]
}
