import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { SessionEvent } from '@adg/protocol'
import { AutoMemory, applyOps, exchangesOf, extractionPrompt, extractionSystem, parseOps } from '../src/memory-auto.ts'
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
  assert.match(prompt, /【用户】\(2026-11-12\) 以后叫我徐坤\n\n【agent】\(2026-11-12\) 好的/)
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
