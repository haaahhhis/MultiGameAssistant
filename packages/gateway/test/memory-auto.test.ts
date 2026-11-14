import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SessionEvent } from '@adg/protocol'
import { AutoMemory, applyOps, ends, exchangesOf, extractionPrompt, extractionSystem, MAX_PASSES, parseOps } from '../src/memory-auto.ts'
import { MemoryStore } from '../src/memory.ts'

const user = (seq: number, text: string, human = true) => ({ type: 'user/message', seq, time: Date.parse('2026-11-12T03:00:00Z'), messageId: `u${seq}`, content: [{ type: 'text', text }], origin: { kind: human ? 'user' : 'notice', human } }) as unknown as SessionEvent
const agent = (seq: number, text: string) => ({ type: 'assistant/message', seq, time: Date.parse('2026-11-12T03:00:10Z'), turn: 1, step: 1, messageId: `a${seq}`, content: [{ type: 'reasoning', text: '想一想' }, { type: 'tool-call', callId: 'c', name: 'script_list', arguments: '{}' }, { type: 'text', text }] }) as unknown as SessionEvent

test('a conversation is read as words only, after where the last pass stopped', () => {
  const events = [user(1, '你好'), agent(2, '你好！'), user(3, '（提醒）现在是 10 点', false), user(4, '以后叫我徐坤'), agent(5, '好的，徐坤。')]
  const read = exchangesOf(events, 2)
  assert.deepEqual(read.map(e => [e.from, e.text]), [['app', '（提醒）现在是 10 点'], ['user', '以后叫我徐坤'], ['agent', '好的，徐坤。']])
  assert.doesNotMatch(JSON.stringify(read), /想一想|script_list/)
})

test('the model is shown what is kept and the conversation, and told the rules', async () => {
  const store = new MemoryStore(undefined)
  await store.add({ kind: 'profile', scope: 'shared', text: '用户玩明日方舟 B 服', by: 'main' })
  const system = extractionSystem('助手', '2026-11-12')
  assert.match(system, /今天是 2026-11-12/)
  assert.match(system, /资料只来自【用户】亲口说的话/)
  assert.match(system, /不记密码、验证码/)
  const prompt = extractionPrompt(store.visibleTo('main'), exchangesOf([user(1, '以后叫我徐坤'), agent(2, '好的')], -1), 'main', 'Asia/Shanghai')
  assert.match(prompt, /# 已有的记忆\n- \[m\w+\] \(资料，共享，\d{4}-\d\d-\d\d\) 用户玩明日方舟 B 服/)
  assert.match(prompt, /【用户】#1 \(2026-11-12\) 以后叫我徐坤\n\n【agent】#2 \(2026-11-12\) 好的/, 'each message with its number, for "from"')
})

test("the model's answer is read leniently, and what it writes stays in the agent's reach", async () => {
  assert.deepEqual(parseOps('没有要记的'), [])
  assert.deepEqual(parseOps('```json\n{"ops":[]}\n```'), [])
  const ops = parseOps('好的：\n```json\n{"ops":[{"op":"add","kind":"profile","shared":true,"text":"称呼用户为徐坤"},{"op":"add","kind":"nonsense","text":"x"},{"op":"add","kind":"journal","shared":false,"text":"2026-11-12 给 MAA 加了早上 8 点的定时"}]}\n```')
  assert.equal(ops.length, 2, 'the malformed one is dropped')

  const store = new MemoryStore(undefined)
  const games = await store.add({ kind: 'profile', scope: 'games', text: '游戏自己的', by: 'games' })
  const old = await store.add({ kind: 'profile', scope: 'shared', text: '用户的显卡是 RTX 2080 Ti', by: 'main' })
  const applied = await applyOps(store, [
    ...ops,
    { op: 'replace', id: old.id, text: '用户的显卡是 RTX 4070' },
    { op: 'replace', id: games.id, text: '不是它的' },
    { op: 'add', kind: 'profile', shared: true, text: '账号密码是 abc12345' },
  ], 'main')
  assert.deepEqual(applied, { added: 2, replaced: 1, skipped: 2 })
  assert.equal(store.get(old.id)?.text, '用户的显卡是 RTX 4070')
  assert.equal(store.get(old.id)?.by, 'auto')
  assert.equal(store.get(games.id)?.text, '游戏自己的')
  const journal = store.list().find(e => e.kind === 'journal')
  assert.equal(journal?.scope, 'main', "shared=false: the agent's own")
  assert.equal(journal?.by, 'auto')
})

test('a pass reads only what is new, only when the user said something, and remembers where it stopped', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-memory-auto-'))
  const store = new MemoryStore(undefined)
  let events: SessionEvent[] = [user(1, '（「干预」交回了：已重启 MAA）', false), agent(2, '好的，我告诉用户。')]
  const prompts: string[] = []
  const make = () => new AutoMemory({
    store,
    file: join(dir, 'memory-auto.json'),
    read: async () => events,
    agentOf: id => (id === 's1' ? { id: 'main', name: '助手' } : undefined),
    defaultModel: () => ({ provider: 'p', model: 'm' }),
    complete: async ({ prompt, selection }) => {
      assert.deepEqual(selection, { provider: 'p', model: 'm' })
      prompts.push(prompt)
      return '{"ops":[{"op":"add","kind":"profile","shared":true,"text":"称呼用户为徐坤"}]}'
    },
    log: { info: () => {}, warn: () => {} },
  })
  const auto = make()

  assert.deepEqual(await auto.run('s1'), { kind: 'skipped', why: 'nothing said by the user' })
  assert.equal(prompts.length, 0, "the app's own messages cost no model call")
  assert.deepEqual(await auto.run('other'), { kind: 'skipped', why: 'not an agent of the app' })

  events = [...events, user(3, '以后叫我徐坤'), agent(4, '好的，徐坤。')]
  assert.deepEqual(await auto.run('s1'), { kind: 'done', added: 1, replaced: 0, skipped: 0 })
  assert.doesNotMatch(prompts[0]!, /已重启 MAA/, 'read before: not read again')
  assert.match(prompts[0]!, /以后叫我徐坤/)
  assert.equal(store.list()[0]?.text, '称呼用户为徐坤')

  // Started again: it remembers where it stopped, and nothing is new.
  const again = make()
  assert.deepEqual(await again.run('s1'), { kind: 'skipped', why: 'nothing said by the user' })
  assert.equal(prompts.length, 1)

  await again.setSettings({ auto: false, model: null })
  events = [...events, user(5, '我只玩国服'), agent(6, '记住了')]
  assert.deepEqual(await again.run('s1'), { kind: 'skipped', why: 'off' })
  assert.equal(make().settings.auto, true, 'not loaded yet: the default')
  const reloaded = make()
  await reloaded.loaded
  assert.equal(reloaded.settings.auto, false, 'the switch is kept')
  auto.dispose(); again.dispose(); reloaded.dispose()
})

test('a quiet conversation is read once, after the wait; working again puts the wait off', async () => {
  const store = new MemoryStore(undefined)
  let calls = 0
  const auto = new AutoMemory({
    store, file: undefined,
    read: async () => [user(1, '以后叫我徐坤'), agent(2, '好的')],
    agentOf: () => ({ id: 'main', name: '助手' }),
    defaultModel: () => ({ provider: 'p', model: 'm' }),
    complete: async () => { calls++; return '{"ops":[]}' },
    log: { info: () => {}, warn: () => {} },
    idleMs: 30,
  })
  await auto.loaded
  auto.activity('s1', false)
  await new Promise(r => setTimeout(r, 10))
  auto.activity('s1', true)
  await new Promise(r => setTimeout(r, 50))
  assert.equal(calls, 0, 'it started working again before the wait was over')
  auto.activity('s1', false)
  await new Promise(r => setTimeout(r, 80))
  assert.equal(calls, 1)
  auto.dispose()
})

test('a long stretch is read oldest first, in passes; the place moves only past what the model was shown', async () => {
  const store = new MemoryStore(undefined)
  // The user's first words, then a long busy stretch: far past what one pass reads.
  const events: SessionEvent[] = [user(1, '以后叫我徐坤，日报只要告诉我失败的'), agent(2, '好的。')]
  for (let seq = 3; seq < 40; seq += 2) events.push(user(seq, `第 ${seq} 步，继续`), agent(seq + 1, `${'做完了一步。'.repeat(300)}（第 ${seq} 步）`))
  const asked: { after: number; maxMessages: number }[] = []
  const prompts: string[] = []
  const auto = new AutoMemory({
    store, file: undefined,
    read: async (_id, since) => { asked.push(since); return events },
    agentOf: () => ({ id: 'main', name: '助手' }),
    defaultModel: () => ({ provider: 'p', model: 'm' }),
    complete: async ({ prompt }) => { prompts.push(prompt); return prompts.length === 1 ? '{"ops":[{"op":"add","kind":"profile","shared":true,"text":"称呼用户为徐坤","from":1},{"op":"add","kind":"journal","text":"2026-11-12 做完了前几步","from":999}]}' : '{"ops":[]}' },
    log: { info: () => {}, warn: () => {} },
  })
  const outcome = await auto.run('s1')
  assert.deepEqual(outcome, { kind: 'done', added: 2, replaced: 0, skipped: 0 })
  assert.ok(prompts.length > 1, 'more than one pass')
  assert.match(prompts[0]!, /以后叫我徐坤/, 'the first pass reads the first words, not the newest')
  assert.doesNotMatch(prompts[0]!, /第 39 步/)
  assert.match(prompts.at(-1)!, /第 39 步/, 'and the last pass reaches the end')
  assert.match(prompts[1]!, /之前的几条（上次已经读过/, 'a stretch that goes on is read with what came just before it')
  assert.deepEqual(asked[0], { after: -1, maxMessages: 400 }, 'a conversation not read before: its newest messages')
  assert.ok(asked.slice(1).every((since, i) => since.after > (i === 0 ? -1 : asked[i]!.after) && since.maxMessages === 4000), 'each pass goes on from where the last stopped')
  assert.equal(store.list().find(e => e.kind === 'profile')?.source?.seq, 1, 'the entry says where it was learned: the message the model named')
  const journal = store.list().find(e => e.kind === 'journal')!
  assert.ok(journal.source!.seq > 1 && journal.source!.seq % 2 === 1, "a message it was not shown: the user's latest words it read")
  auto.dispose()
})

test('the passes of one quiet moment stop at a limit, and the place is kept for the next', async () => {
  const events: SessionEvent[] = []
  for (let seq = 1; seq < 200; seq += 2) events.push(user(seq, `第 ${seq} 条：${'话'.repeat(1900)}`), agent(seq + 1, '好'))
  let calls = 0
  const auto = new AutoMemory({
    store: new MemoryStore(undefined), file: undefined,
    read: async () => events,
    agentOf: () => ({ id: 'main', name: '助手' }),
    defaultModel: () => ({ provider: 'p', model: 'm' }),
    complete: async () => { calls++; return '{"ops":[]}' },
    log: { info: () => {}, warn: () => {} },
  })
  await auto.run('s1')
  assert.equal(calls, MAX_PASSES)
  await auto.run('s1')
  assert.equal(calls, 2 * MAX_PASSES, 'the next quiet moment goes on, it does not start again')
  auto.dispose()
})

test("an answer not given yet keeps the user's words for the next pass; the app's own stretch costs nothing", async () => {
  let events: SessionEvent[] = [user(1, '我只玩国服')]
  const prompts: string[] = []
  const auto = new AutoMemory({
    store: new MemoryStore(undefined), file: undefined,
    read: async () => events,
    agentOf: () => ({ id: 'main', name: '助手' }),
    defaultModel: () => ({ provider: 'p', model: 'm' }),
    complete: async ({ prompt }) => { prompts.push(prompt); return '{"ops":[]}' },
    log: { info: () => {}, warn: () => {} },
  })
  assert.deepEqual(await auto.run('s1'), { kind: 'skipped', why: 'no answer yet' })
  events = [...events, agent(2, '好的，只看国服。')]
  await auto.run('s1')
  assert.match(prompts[0]!, /我只玩国服/, 'read with its answer, not passed over')
  // A long run of the app's own notices, then the user: the notices are passed over without a call.
  events = [...events]
  for (let seq = 3; seq < 30; seq += 2) events.push(user(seq, `（流水线报告）${'正常'.repeat(900)}`, false), agent(seq + 1, '收到。'))
  events.push(user(31, '明天开始换成 B 服'), agent(32, '好的'))
  await auto.run('s1')
  assert.equal(prompts.length, 2, 'one call, for the stretch the user spoke in')
  assert.match(prompts[1]!, /换成 B 服/)
  auto.dispose()
})

test('automatic memory never adds or changes a core entry, and says where what it keeps came from', async () => {
  const store = new MemoryStore(undefined)
  const core = await store.add({ kind: 'core', scope: 'main', text: '任何改动都先问用户', by: 'user' })
  assert.equal(core.scope, 'shared', 'a core entry is always shared')
  const source = { agent: 'main', sessionId: 's1', seq: 7 }
  const applied = await applyOps(store, [{ op: 'replace', id: core.id, text: '改动不用问' }, { op: 'add', kind: 'profile', text: '用户用 MuMu 模拟器' }], 'main', source)
  assert.deepEqual(applied, { added: 1, replaced: 0, skipped: 1 })
  assert.equal(store.get(core.id)?.text, '任何改动都先问用户')
  assert.deepEqual(store.list().find(e => e.kind === 'profile')?.source, source)
  assert.deepEqual(parseOps('{"ops":[{"op":"add","kind":"core","text":"x"}]}'), [], 'it cannot write one')
  assert.match(extractionPrompt(store.visibleTo('main'), [], 'main'), /\(核心，共享，/)
})

test('a long message keeps its start and its end; the harness\'s notes are no one\'s words', () => {
  const long = `开头的请求${'中'.repeat(3000)}结尾的结论`
  const cut = ends(long, 2000)
  assert.ok(cut.length < 2100)
  assert.match(cut, /^开头的请求/)
  assert.match(cut, /结尾的结论$/)
  const note = (seq: number, kind: string, extra: object = {}) => ({ ...user(seq, '…', false), origin: { kind, human: false }, ...extra })
  const notes = [
    note(1, 'adg-recall'), note(2, 'adg-time'), note(3, 'runtime-context'), note(4, 'skill-catalog'), note(5, 'time-context'),
    note(6, 'compact-checkpoint', { replacesHistory: true }),
  ] as unknown as SessionEvent[]
  assert.deepEqual(exchangesOf(notes, -1), [], 'nor is a summary, which restates what was read before it')
  assert.equal(exchangesOf([note(7, 'notice')] as unknown as SessionEvent[], -1).length, 1, 'a notice the app sent is read')
})

test('low-context mode keeps it on, whatever the switch says', async () => {
  const store = new MemoryStore(undefined)
  let lowContext = true
  let calls = 0
  const auto = new AutoMemory({
    store, file: undefined,
    read: async () => [user(1, '以后叫我徐坤'), agent(2, '好的')],
    agentOf: () => ({ id: 'main', name: '助手' }),
    defaultModel: () => ({ provider: 'p', model: 'm' }),
    complete: async () => { calls++; return '{"ops":[]}' },
    log: { info: () => {}, warn: () => {} },
    forced: () => lowContext,
  })
  await auto.setSettings({ auto: false, model: null })
  assert.equal(auto.forced, true)
  assert.equal(auto.on, true)
  assert.deepEqual(await auto.run('s1'), { kind: 'done', added: 0, replaced: 0, skipped: 0 })
  assert.equal(calls, 1)
  lowContext = false
  assert.equal(auto.on, false)
  assert.deepEqual(await auto.run('s1'), { kind: 'skipped', why: 'off' })
  auto.dispose()
})
