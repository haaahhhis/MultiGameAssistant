import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { SessionEvent } from '@adg/protocol'
import { around, historyTools, line, matches, saidIn, snippet } from '../src/history.ts'

const T = Date.parse('2026-11-12T03:00:00Z')
const user = (seq: number, text: string, kind = 'user', extra: object = {}) => ({ type: 'user/message', seq, time: T + seq * 60_000, messageId: `u${seq}`, content: [{ type: 'text', text }], origin: { kind, human: kind === 'user' }, ...extra }) as unknown as SessionEvent
const agent = (seq: number, text: string) => ({ type: 'assistant/message', seq, time: T + seq * 60_000, turn: 1, step: 1, messageId: `a${seq}`, content: [{ type: 'reasoning', text: '想一想' }, { type: 'text', text }] }) as unknown as SessionEvent

const here = [user(1, '给明日方舟 B 服的 MAA 加个早上 8 点的定时'), agent(2, '好的，已经加好了。'), user(3, '现在是 10 点', 'time-context'), user(4, '之前的对话摘要：用户要 8 点跑 MAA', 'compaction', { replacesHistory: true }), user(5, '把公招也开上'), agent(6, '公招已打开。')]
const older = [user(1, '我的显卡是 RTX 4070'), agent(2, '记住了。')]

test('what was said: messages, replies and summaries, without reasoning or the harness\'s notes', () => {
  const said = saidIn(here)
  assert.deepEqual(said.map(s => [s.seq, s.from]), [[1, 'user'], [2, 'agent'], [4, 'app'], [5, 'user'], [6, 'agent']])
  assert.equal(said[2]!.summary, true)
  assert.doesNotMatch(JSON.stringify(said), /想一想|10 点/)
  assert.match(line(said[0]!, 'Asia/Shanghai'), /^#1 2026-11-12 11:01 用户：给明日方舟/)
  assert.match(line(said[2]!, 'UTC'), /（压缩摘要）/)
  assert.match(line({ ...said[0]!, text: 'x'.repeat(30) }, 'UTC', 10), /…（后面省略 20 字）$/)
  assert.deepEqual(around(said, 4, 1, 1).map(s => s.seq), [2, 4, 5])
  assert.deepEqual(around(said, 99, 1, 1).map(s => s.seq), [5, 6], 'past the end: the last ones')
  assert.equal(matches('MAA 早上 8 点', ['maa', '8']), true)
  assert.equal(matches('MAA 早上 8 点', ['maa', '9']), false)
  assert.match(snippet(`${'前'.repeat(200)}关键${'后'.repeat(200)}`, ['关键']), /^…前+关键后+…$/)
})

test('the tools search and read the agent\'s own conversations, this one first, and nobody else\'s', async () => {
  const sessions: Record<string, readonly SessionEvent[]> = { s1: here, s0: older, other: [user(1, 'MAA 的秘密')] }
  const [search, read] = historyTools({
    agentOf: id => (id === 's1' || id === 's0' ? 'main' : id === 'other' ? 'games' : undefined),
    sessions: async agent => (agent === 'main' ? [{ id: 's0', title: '上周的对话', updatedAt: 1 }, { id: 's1', title: '这周', updatedAt: 2 }] : [{ id: 'other', title: null }]),
    read: async id => sessions[id] ?? [],
    timeZone: 'UTC',
  })
  const exec = (session: string) => ({ agent: { session: { id: session } }, signal: new AbortController().signal }) as never
  const found = await search!.execute({ query: 'MAA 8' }, exec('s1')) as unknown as { items: { session_id: string; seq: number; title: string | null }[] }
  assert.deepEqual(found.items.map(i => [i.session_id, i.seq]), [['s1', 4], ['s1', 1]], 'newest first; the other agent\'s MAA is not found')
  assert.equal(found.items[0]!.title, '（这个对话）')
  const gpu = await search!.execute({ query: '显卡' }, exec('s1')) as unknown as { items: { session_id: string }[] }
  assert.deepEqual(gpu.items.map(i => i.session_id), ['s0'], 'its earlier conversation too')
  const none = await search!.execute({ query: '不存在的词' }, exec('s1')) as unknown as { items: unknown[]; note: string }
  assert.equal(none.items.length, 0)
  await assert.rejects(Promise.resolve(search!.execute({ query: 'MAA', session_id: 'other' }, exec('s1'))), /只能查你自己的对话/)
  await assert.rejects(Promise.resolve(search!.execute({ query: 'MAA' }, exec('stranger'))), /只有本软件的 agent/)

  const text = await read!.execute({ seq: 4, before: 1, after: 1 }, exec('s1')) as unknown as string
  assert.match(text, /^对话 （这个对话），#2–#5：/)
  assert.match(text, /#4 2026-11-12 03:04 （压缩摘要）：之前的对话摘要/)
  const other = await read!.execute({ seq: 1, session_id: 's0' }, exec('s1')) as unknown as string
  assert.match(other, /RTX 4070/)
  await assert.rejects(Promise.resolve(read!.execute({ seq: 1, session_id: 'other' }, exec('s1'))), /只能读你自己的对话/)
})
