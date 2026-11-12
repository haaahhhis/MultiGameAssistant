import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { looksSecret, MemoryStore, memoryPrompt, memoryTools } from '../src/memory.ts'
import { hiddenTools, subAgentSpec } from '../src/roles.ts'

const day = (d: string) => new Date(`${d}T03:00:00Z`)

test('entries are kept in memory.json, shared or one agent own, and the same text is not kept twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-memory-'))
  let changed = 0
  const store = new MemoryStore(join(dir, 'memory.json'), () => { changed++ })
  const name = await store.add({ kind: 'profile', scope: 'shared', text: '  称呼用户为\n徐坤 ', by: 'main' }, day('2026-11-01'))
  assert.equal(name.text, '称呼用户为 徐坤')
  await store.add({ kind: 'profile', scope: 'intervene', text: 'MAA 卡住时先看 adb 连接', by: 'intervene' })
  const again = await store.add({ kind: 'profile', scope: 'shared', text: '称呼用户为 徐坤', by: 'games' }, day('2026-11-05'))
  assert.equal(again.id, name.id, 'touched, not written twice')
  assert.equal(store.list().length, 2)
  assert.equal(changed, 3)

  assert.deepEqual(store.visibleTo('main').map(e => e.text), ['称呼用户为 徐坤'])
  assert.equal(store.visibleTo('intervene').length, 2)

  const reread = new MemoryStore(join(dir, 'memory.json'))
  await reread.loaded
  assert.equal(reread.list().length, 2)
  assert.equal(JSON.parse(readFileSync(join(dir, 'memory.json'), 'utf8')).version, 1)

  assert.equal(await store.remove(name.id), true)
  assert.equal(await store.remove(name.id), false)
})

test('passwords, codes and keys are never kept; commit hashes and ordinary words are', async () => {
  assert.equal(looksSecret('邮箱密码是 hunter2abc'), true)
  assert.equal(looksSecret('验证码：834201'), true)
  assert.equal(looksSecret('key sk-abcdefghijklmnopqrstuv'), true)
  assert.equal(looksSecret('token: ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345'), true)
  assert.equal(looksSecret('Ab3dEf7hIj9kLm1nOp5qRs2tUv4wXy6zAb8c'), true)
  assert.equal(looksSecret('合并到 main，merge commit e4b5f9dfa1c2b3d4e5f60718293a4b5c6d7e8f90'), false)
  assert.equal(looksSecret('用户不想让密码保存在软件里'), false)
  const store = new MemoryStore(undefined)
  await assert.rejects(store.add({ kind: 'profile', scope: 'shared', text: 'B 服账号密码是 abc12345', by: 'main' }), /不写进记忆/)
  await assert.rejects(store.add({ kind: 'profile', scope: 'shared', text: 'x'.repeat(601), by: 'main' }), /最多 600/)
})

test('the prompt carries every profile entry and the recent journal, and says how to write more', async () => {
  const store = new MemoryStore(undefined)
  const now = day('2026-11-12')
  assert.match(memoryPrompt([], 'main', { now }), /还没有关于用户的记忆[\s\S]*memory_save/)
  await store.add({ kind: 'profile', scope: 'shared', text: '用户喜欢先看结论', by: 'main' }, day('2026-11-01'))
  await store.add({ kind: 'profile', scope: 'main', text: '日报发到飞书群', by: 'main' }, day('2026-11-02'))
  await store.add({ kind: 'journal', scope: 'shared', text: '2026-09-01 装好了 MAA', by: 'scripts' }, day('2026-09-01'))
  await store.add({ kind: 'journal', scope: 'shared', text: '2026-11-10 把星铁日常排进了早上 8 点的流水线', by: 'main' }, day('2026-11-10'))
  await store.add({ kind: 'journal', scope: 'games', text: '游戏自己的日记', by: 'games' }, day('2026-11-10'))

  const text = memoryPrompt(store.visibleTo('main'), 'main', { now, timeZone: 'Asia/Shanghai' })
  assert.match(text, /^# 长期记忆/)
  assert.match(text, /## 资料\n- \[m\w+\] \(更新于 2026-11-02 \d\d:\d\d，你自己的\) 日报发到飞书群\n- \[m\w+\] \(更新于 2026-11-01 \d\d:\d\d，共享\) 用户喜欢先看结论/)
  assert.match(text, /## 近期日记\n- \[m\w+\] \(记于 2026-11-10 \d\d:\d\d，共享\) 2026-11-10 把星铁日常/)
  assert.doesNotMatch(text, /装好了 MAA/, 'older than 30 days: found with memory_search')
  assert.match(text, /更早的 1 条日记/)
  assert.doesNotMatch(text, /游戏自己的日记/, "another agent's own")
  assert.match(text, /不记密码、验证码/)
  assert.match(text, /技能（skill_save）/)

  const sub = memoryPrompt(store.visibleTo('main'), 'main', { now, lead: '助手' })
  assert.match(sub, /你是子 agent，不写记忆/)
  assert.doesNotMatch(sub, /什么时候记、怎么记/)
})

test('the tools write as the calling agent, change only what it reads, and find old entries', async () => {
  const store = new MemoryStore(undefined)
  const agents: Record<string, string> = { s1: 'main', s2: 'games' }
  const [save, forget, search] = memoryTools({ store, agentOf: id => agents[id] })
  const as = (session: string) => ({ agent: { session: { id: session } } }) as never
  const run = (tool: typeof save, args: unknown, session: string) => tool!.execute(args as never, as(session)) as unknown as Promise<Record<string, any>>

  const shared = await run(save, { text: '用户的电脑是 RTX 2080 Ti', kind: 'profile', shared: true }, 's1')
  assert.equal(shared['saved'].shared, true)
  const mine = await run(save, { text: '用户只玩 B 服', kind: 'profile' }, 's2')
  assert.equal(store.get(mine['saved'].id)?.scope, 'games')

  await assert.rejects(run(forget, { id: mine['saved'].id }, 's1'), /没有这条记忆/, "not main's to forget")
  await assert.rejects(run(save, { text: 'x', kind: 'profile' }, 'other'), /只有本软件的 agent/)

  const replaced = await run(save, { text: '用户的电脑是 RTX 4070', kind: 'profile', replaces: shared['saved'].id }, 's2')
  assert.equal(replaced['replaced'], '用户的电脑是 RTX 2080 Ti')
  assert.equal(store.get(shared['saved'].id)?.scope, 'shared', 'stays shared')

  assert.deepEqual((await run(search!, { query: 'rtx 4070' }, 's1'))['items'].map((e: { text: string }) => e.text), ['用户的电脑是 RTX 4070'])
  assert.equal((await run(search!, { query: 'B 服' }, 's1'))['items'].length, 0, "games' own")
  assert.equal((await run(search!, {}, 's2'))['items'].length, 2)

  await run(forget, { id: mine['saved'].id }, 's2')
  assert.equal(store.list().length, 1)
})

test('every agent keeps the memory tools; a sub-agent only reads', () => {
  const app = new Set(['memory_save', 'memory_forget', 'memory_search', 'script_run'])
  const role = { id: 'games', name: '游戏', description: '', order: 1, tools: ['game_list'] }
  assert.deepEqual(hiddenTools(role, app, app), ['script_run'])
  assert.deepEqual(hiddenTools(subAgentSpec(role), app, app).sort(), ['memory_forget', 'memory_save', 'script_run'])
})
