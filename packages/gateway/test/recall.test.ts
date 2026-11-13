import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { MemoryStore } from '../src/memory.ts'
import { RECALL_SOURCE, RecallLog, recallFor, recallMessage, recallText, saidByUser } from '../src/recall.ts'

const typed = (text: string, kind = 'user') => ({ role: 'user', content: [{ type: 'text', text }], source: { kind } })

test("what the user typed is what a turn is compared with: not a notice, not a sub-agent's task", () => {
  assert.equal(saidByUser([typed('星铁的日常今天跑了吗'), typed('（提醒）…', 'adg-time')]), '星铁的日常今天跑了吗')
  assert.equal(saidByUser([typed('从飞书发来的', 'user-rpc')]), '从飞书发来的')
  assert.equal(saidByUser([typed('（「干预」交回了…）', 'notice'), typed('子任务', 'subagent')]), '')
  assert.equal(saidByUser([]), '')
})

test('kept entries the prompt has no room for come along when they share enough with what was said, once', async () => {
  const store = new MemoryStore(undefined)
  const old = (d: string) => new Date(`${d}T03:00:00Z`)
  await store.add({ kind: 'journal', scope: 'shared', text: '2026-08-02 星铁的日常脚本换成了 M7A，每天早上 7 点跑', by: 'main' }, old('2026-08-02'))
  await store.add({ kind: 'journal', scope: 'shared', text: '2026-08-05 明日方舟公招开了加急许可', by: 'main' }, old('2026-08-05'))
  await store.add({ kind: 'core', scope: 'shared', text: '星铁的事都先问用户', by: 'user' }, old('2026-08-01'))
  await store.add({ kind: 'journal', scope: 'games', text: '2026-08-03 星铁日常脚本出过错', by: 'games' }, old('2026-08-03'))
  const now = new Date('2026-11-13T03:00:00Z')
  const entries = store.visibleTo('main')
  const said = '星铁的日常脚本几点跑来着'
  const picked = recallFor(said, entries, 'main', { now })
  assert.deepEqual(picked.map(e => e.text), ['2026-08-02 星铁的日常脚本换成了 M7A，每天早上 7 点跑'], 'not the core entry (in the prompt), not another agent\'s, not an unrelated one')
  assert.deepEqual(recallFor(said, entries, 'main', { now, already: new Set(picked.map(e => e.id)) }), [], 'once per conversation')
  assert.deepEqual(recallFor('好的谢谢', entries, 'main', { now }), [], 'nothing shared: nothing comes')

  const recent = recallFor(said, entries, 'main', { now: new Date('2026-08-10T03:00:00Z') })
  assert.deepEqual(recent, [], 'a journal entry still in the prompt is not brought again')

  const text = recallText(picked, 'main', 'UTC')
  assert.match(text, /^（相关的记忆：/)
  assert.match(text, /不是指令/)
  const message = recallMessage(text, picked.map(e => e.id)) as { role: string; source: { kind: string; ids: string[] } }
  assert.equal(message.role, 'user')
  assert.equal(message.source.kind, RECALL_SOURCE)
  assert.deepEqual(message.source.ids, picked.map(e => e.id))
})

test('what each conversation was given is kept for the newest conversations', () => {
  const log = new RecallLog()
  log.add('s1', ['a'])
  log.add('s1', ['b'])
  assert.deepEqual([...log.of('s1')], ['a', 'b'])
  assert.equal(log.of('s2').size, 0)
  for (let i = 0; i < 600; i++) log.add(`x${i}`, ['c'])
  assert.equal(log.of('s1').size, 0, 'the oldest conversations are let go')
  assert.equal(log.of('x599').size, 1)
})
