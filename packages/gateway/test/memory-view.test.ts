import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { MemoryStore, memoryPrompt } from '../src/memory.ts'
import { MAX_NOTE_CHARS, MEMORY_NOTE_SOURCE, MemoryViews, REPIN_CHARS, diffOf, memorySectionIn, noteOf, shownLines, type ViewEvent } from '../src/memory-view.ts'
import { recallFor } from '../src/recall.ts'

const H = 60 * 60_000
const T0 = Date.parse('2026-11-12T01:00:00Z')

/** A dsh session as far as the views read it, and what the agent loop does with a step's prompt and messages. */
class Conversation {
  readonly events: (ViewEvent & { seq: number })[] = []
  readonly nodes: number[] = []
  gen = 0
  /** The surface generation the last request was built on (dsh's requestSurfaceGeneration). */
  built = 0
  /** Prompts dsh sent: in the history (a copy appended) or at the head (rewritten). */
  copies = 0
  rewrites = 0
  readonly clock: { t: number }
  readonly session: { readonly id: string; readonly seq: number; readonly surface: { readonly nodes: readonly number[]; readonly contentGeneration: number }; eventAt(seq: number): ViewEvent | undefined }

  constructor(id: string, clock: { t: number }) {
    this.clock = clock
    const self = this
    this.session = {
      id,
      get seq() { return self.events.length },
      surface: { get nodes() { return self.nodes }, get contentGeneration() { return self.gen } },
      eventAt: seq => self.events[seq],
    }
  }

  get agent() {
    return { session: this.session, requestSurfaceGeneration: this.built }
  }

  append(type: string, data: unknown, surfaceOp?: unknown): number {
    const seq = this.events.length
    this.events.push({ seq, type, time: this.clock.t, data, ...(surfaceOp === undefined ? {} : { surfaceOp }) })
    return seq
  }

  /** One step: assembly (the section), pre-step (the note), then the prompt as dsh projects it, the note, a reply. */
  step(views: MemoryViews, owner = 'main', lead?: string): { prompt: string; note: string | undefined } {
    const prompt = `你是助手。\n\n${views.section(this.agent, owner, lead)}\n\n回复风格：简短。`
    const note = views.note(this.session) as { content: { text: string }[]; source: unknown } | undefined
    const systems = this.nodes.filter(seq => this.events[seq]!.type === 'system/message')
    const latest = systems.map(seq => promptOf(this.events[seq]!)).filter(text => text !== '').at(-1)
    if (systems.length === 0) {
      this.nodes.push(this.append('system/message', { message: message(prompt) }, 'append'))
    } else if (this.gen !== this.built) {
      // A new request series: the head is rewritten when it differs, later prompts emptied.
      for (const seq of systems.slice(1)) if (promptOf(this.events[seq]!) !== '') this.replace(seq, 'system/message', { message: { content: [] } })
      if (promptOf(this.events[systems[0]!]!) !== prompt) { this.replace(systems[0]!, 'system/message', { message: message(prompt) }); this.rewrites++ }
    } else if (latest !== prompt) {
      this.nodes.push(this.append('system/message', { message: message(prompt) }, 'append'))
      this.copies++
    }
    if (note !== undefined) this.nodes.push(this.append('user/message', note, 'append'))
    this.built = this.gen
    this.nodes.push(this.append('assistant/message', { message: message('好的') }, 'append'))
    return { prompt, note: note?.content[0]?.text }
  }

  /** A memory tool's call: its record, then the result. */
  call(): number {
    const seq = this.append('assistant/message', { message: message('（调用工具）') }, 'append')
    this.nodes.push(seq)
    this.nodes.push(this.append('tool/result', {}, 'append'))
    return seq
  }

  replace(seq: number, type: string, data: unknown): void {
    const at = this.nodes.indexOf(seq)
    this.nodes[at] = this.append(type, data, { op: 'replace', startSeq: seq, endSeq: seq })
    this.gen++
  }

  /** Compaction: everything after the head up to (not counting) the last `keep` nodes becomes one summary. */
  compact(keep: number): void {
    const span = this.nodes.slice(1, this.nodes.length - keep)
    const summary = this.append('user/message', { role: 'user', content: [{ type: 'text', text: '<compacted-summary>…</compacted-summary>' }], source: { kind: 'compact-checkpoint' } }, { op: 'replace', startSeq: span[0], endSeq: span.at(-1) })
    this.nodes.splice(1, span.length, summary)
    this.gen++
  }
}

const message = (text: string) => ({ role: 'system', content: [{ type: 'text', text }] })
const promptOf = (event: ViewEvent) => {
  const content = (event.data as { message: { content: { text: string }[] } }).message.content
  return content.length === 0 ? '' : content[0]!.text
}

async function setUp() {
  const clock = { t: T0 }
  const store = new MemoryStore(undefined)
  await store.loaded
  const at = () => new Date(clock.t)
  const add = (text: string, kind: 'core' | 'profile' | 'journal' = 'profile', scope = 'shared', by = 'main') => store.add({ kind, scope, text, by }, at())
  const views = new MemoryViews(store, { timeZone: 'UTC', now: () => clock.t })
  return { clock, store, views, add, at }
}

test("a conversation's memory section stays as it began; what others change comes once, as a short note", async () => {
  const { clock, store, views, add, at } = await setUp()
  const name = await add('用户叫小王')
  const old = await add('用户的显卡是 RTX 2080 Ti')
  const chat = new Conversation('s1', clock)
  const first = chat.step(views)
  assert.match(first.prompt, /用户叫小王[\s\S]*RTX 2080 Ti/)
  assert.equal(first.note, undefined, 'a new conversation: nothing to tell')

  clock.t += H
  const added = await add('用户每天早上 7 点跑星铁日常', 'journal', 'shared', 'games')
  await store.update(old.id, { text: '用户的显卡是 RTX 4070' }, 'user', at())
  await store.remove(name.id, 'user', at())
  await add('游戏 agent 自己的事', 'profile', 'games', 'games')
  const second = chat.step(views)
  assert.equal(second.prompt, first.prompt, 'the prompt is word for word the same')
  assert.equal(chat.copies, 0, 'no copy of it in the history')
  const lines = second.note!.split('\n')
  assert.match(lines[0]!, /^（记忆更新：/)
  assert.match(lines[1]!, new RegExp(`^~ \\[${old.id}\\] 资料 \\(更新于 [^)]*，共享\\) 用户的显卡是 RTX 4070$`))
  assert.match(lines[2]!, new RegExp(`^\\+ \\[${added.id}\\] 日记 \\(记于 [^)]*，共享\\) 用户每天早上 7 点跑星铁日常$`))
  assert.match(lines[3]!, new RegExp(`^- \\[${name.id}\\] 已删除（原来是：用户叫小王）$`))
  assert.equal(lines.length, 4, "another agent's own entry is not this one's to see")
  assert.equal(chat.step(views).note, undefined, 'told once')

  // The agent's own write: its tool's result said it.
  const seq = chat.call()
  const mine = await add('用户喜欢先看结论')
  views.wrote('s1', mine.id, mine, seq)
  assert.equal(chat.step(views).note, undefined)
  assert.equal(chat.copies + chat.rewrites, 0)
})

test('a core entry added mid-conversation is told with what it is, and recall leaves what the conversation has alone', async () => {
  const { clock, store, views, add } = await setUp()
  await add('2026-08-02 星铁的日常脚本换成了 M7A', 'journal')
  const chat = new Conversation('s1', clock)
  chat.step(views)
  clock.t += H
  const core = await add('任何会花钱的操作都先问用户', 'core', 'shared', 'user')
  assert.match(chat.step(views).note!, new RegExp(`\\+ \\[${core.id}\\] 核心：任何会花钱的操作都先问用户`))
  const inView = views.inView('s1')!
  assert.ok(inView.has(core.id))
  const recent = await add('2026-11-12 星铁的日常脚本出错了一次', 'journal')
  assert.ok(!views.inView('s1')!.has(recent.id), 'not told yet')
  assert.deepEqual(recallFor('星铁的日常脚本怎么了', store.visibleTo('main'), 'main', { inView }).map(e => e.id), [recent.id], 'in the pinned prompt or told: not brought again')
})

test('a compaction that swallows notes gets what they said back in one note; an own write still in view is not told again', async () => {
  const { clock, store, views, add } = await setUp()
  const chat = new Conversation('s1', clock)
  chat.step(views)
  clock.t += H
  const early = await add('用户的 MAA 用官服账号')
  assert.match(chat.step(views).note!, /官服账号/)
  const earlyCall = chat.call()
  const earlyOwn = await add('用户的模拟器是 MuMu 12')
  views.wrote('s1', earlyOwn.id, earlyOwn, earlyCall)
  chat.step(views)
  for (let i = 0; i < 3; i++) chat.step(views)
  const lateCall = chat.call()
  const lateOwn = await add('用户的 ADB 端口是 16416')
  views.wrote('s1', lateOwn.id, lateOwn, lateCall)
  chat.step(views)

  // The early note and the early call are compacted away; the late call stays.
  chat.compact(4)
  const after = chat.step(views)
  assert.equal(chat.rewrites, 0, 'the head stays: the cache holds through the prompt and the tools')
  const lines = after.note!.split('\n').slice(1)
  assert.equal(lines.length, 2)
  assert.ok(lines.some(line => line.includes(early.id)), 'the swallowed note again')
  assert.ok(lines.some(line => line.includes(earlyOwn.id)), 'the swallowed tool result: told now')
  assert.ok(!after.note!.includes(lateOwn.id), 'still in view')
  assert.equal(chat.step(views).note, undefined)
  assert.equal(store.list().length, 3)
})

test('after a restart the section is read back from the prompt the conversation was sent, and its notes still count', async () => {
  const { clock, store, add, at } = await setUp()
  const kept = await add('用户叫小王')
  const chat = new Conversation('s1', clock)
  const before = new MemoryViews(store, { timeZone: 'UTC', now: () => clock.t })
  const first = chat.step(before)
  clock.t += H
  const noted = await add('用户的显卡是 RTX 4070')
  chat.step(before)

  // Restarted: a new process, the same conversation. In between, more changed.
  clock.t += 10 * H
  await store.update(kept.id, { text: '用户叫老王' }, 'user', at())
  const restarted = new MemoryViews(store, { timeZone: 'UTC', now: () => clock.t })
  chat.built = chat.gen
  const again = chat.step(restarted)
  assert.equal(again.prompt, first.prompt, 'the same prompt: nothing appended, nothing rewritten')
  assert.equal(chat.copies + chat.rewrites, 0)
  assert.match(again.note!, new RegExp(`~ \\[${kept.id}\\] 资料 [^\\n]*用户叫老王`))
  assert.ok(!again.note!.includes(noted.id), 'its note is still in the conversation')
})

test('a new conversation that day takes the same pin, so its prompt is one the cache has; the next day, or after much has changed, a new one', async () => {
  const { clock, views, add } = await setUp()
  await add('用户叫小王')
  const home = new Conversation('home', clock)
  const homePrompt = home.step(views).prompt
  clock.t += 2 * H
  const later = await add('用户的显卡是 RTX 4070')
  const other = new Conversation('other', clock)
  const first = other.step(views)
  assert.equal(first.prompt, homePrompt, 'the same system prompt as the conversation before it')
  assert.match(first.note!, new RegExp(`\\+ \\[${later.id}\\]`), 'and what changed since, as a note')

  clock.t += 24 * H
  const next = new Conversation('next', clock).step(views)
  assert.notEqual(next.prompt, homePrompt)
  assert.match(next.prompt, /RTX 4070/)
  assert.equal(next.note, undefined)

  for (let i = 0; i < 30; i++) await add(`第 ${i} 条新的资料：${'字'.repeat(60)}`)
  const busy = new Conversation('busy', clock).step(views)
  assert.match(busy.prompt, /第 29 条新的资料/, 'too much to tell: pinned anew')
  assert.equal(busy.note, undefined)
})

test('the pin is renewed only when a compaction starts a new series anyway and the notes would be long', async () => {
  const { clock, views, add } = await setUp()
  await add('用户叫小王')
  const chat = new Conversation('s1', clock)
  const first = chat.step(views)
  clock.t += H
  let chars = 0
  for (let i = 0; chars <= REPIN_CHARS; i++) chars += (await add(`第 ${i} 条：${'字'.repeat(150)}`)).text.length + 40
  const busy = chat.step(views)
  assert.equal(busy.prompt, first.prompt, 'mid-series: a note, however long')
  assert.ok(busy.note!.length > MAX_NOTE_CHARS - 200 && busy.note!.length <= MAX_NOTE_CHARS + 60)
  assert.match(busy.note!, /（还有 \d+ 条变化没列出，要用时用 memory_search 查）$/)
  assert.equal(chat.step(views).note, undefined, 'the uncounted are not tried again')

  chat.compact(2)
  const renewed = chat.step(views)
  assert.notEqual(renewed.prompt, first.prompt)
  assert.match(renewed.prompt, /第 0 条/)
  assert.equal(renewed.note, undefined, 'all of it is in the new pin')
  assert.deepEqual([chat.copies, chat.rewrites], [0, 1], 'one head rewrite, with the compaction that broke the cache anyway')

  clock.t += H
  await add('用户的显卡是 RTX 4070')
  chat.compact(2)
  const small = chat.step(views)
  assert.equal(small.prompt, renewed.prompt, 'a short note is cheaper than a rewrite')
  assert.match(small.note!, /RTX 4070/)
})

test('a sub-agent reads its lead memory with its own ending, and a section is found in the prompt it was sent', async () => {
  const { clock, views, add } = await setUp()
  await add('用户叫小王')
  const sub = new Conversation('sub', clock)
  const prompt = sub.step(views, 'main', '助手').prompt
  const section = memorySectionIn(prompt, '助手')!
  assert.match(section, /^# 长期记忆\n\n[\s\S]*由它去记。$/)
  assert.equal(memorySectionIn(prompt, undefined), undefined, "a lead's ending is not there")
  assert.equal(memorySectionIn('# 长期记忆 之外的话', undefined), undefined)
  assert.equal(shownLines(section).size, 1)
})

test('nothing is pinned before the memory file is read', async () => {
  const store = new MemoryStore(undefined)
  const views = new MemoryViews(store)
  const chat = new Conversation('s1', { t: T0 })
  const early = views.section(chat.agent, 'main', undefined)
  assert.match(early, /还没有关于用户的记忆/)
  assert.equal(views.inView('s1'), undefined)
  await store.loaded
  await store.add({ kind: 'profile', scope: 'shared', text: '用户叫小王', by: 'main' })
  assert.match(views.section(chat.agent, 'main', undefined), /用户叫小王/)
})

test('what a diff and its note say', async () => {
  const { add } = await setUp()
  const kept = await add('用户叫小王')
  const known = shownLines(memoryPrompt([kept], 'main', { timeZone: 'UTC' }))
  assert.deepEqual(diffOf([kept], known, T0, 'main', 'UTC'), { added: [], changed: [], gone: [] })
  const gone = diffOf([], known, T0, 'main', 'UTC')
  assert.equal(gone.gone[0]?.id, kept.id)
  const { text, changes } = noteOf(gone, 'main', 'UTC')
  assert.match(text, /已删除（原来是：用户叫小王）/)
  assert.deepEqual(changes, [{ id: kept.id, line: null }])
  assert.equal(diffOf([kept], new Map(), T0 + 1, 'main', 'UTC').added.length, 0, 'never shown and not changed since the pin: left for memory_search')
  assert.equal(diffOf([kept], new Map(), T0, 'main', 'UTC').added.length, 1, 'the same millisecond: it may have come just after')
  assert.equal(MEMORY_NOTE_SOURCE, 'adg-memory')
})
