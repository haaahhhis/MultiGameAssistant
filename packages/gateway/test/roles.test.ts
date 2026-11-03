import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { keeps, RoleModel, SessionRoles } from '../src/roles.ts'

const INTERVENE = { id: 'intervene', name: '干预', description: '脚本出错、卡住时处理', order: 10, titles: ['干预'] }
const GAMES = { id: 'games', name: '游戏', description: '读游戏活动和资讯', order: 20, titles: ['游戏信息', '日报'] }

test('roles are listed in order, without their title prefixes, and leave with their plugin', () => {
  let changes = 0
  const roles = new SessionRoles(undefined, () => changes++)
  const dropGames = roles.register(GAMES)
  const dropIntervene = roles.register(INTERVENE)
  assert.deepEqual(roles.list(), [
    { id: 'intervene', name: '干预', description: '脚本出错、卡住时处理', order: 10 },
    { id: 'games', name: '游戏', description: '读游戏活动和资讯', order: 20 },
  ])
  dropGames()
  assert.deepEqual(roles.list().map(r => r.id), ['intervene'])
  assert.equal(changes, 3, 'each registration and removal is announced')
  const replaced = roles.register({ ...INTERVENE, name: '异常' })
  dropIntervene()
  assert.equal(roles.list()[0]!.name, '异常', 'a stale removal does not take a newer registration away')
  replaced()
  assert.deepEqual(roles.list(), [])
})

test("a session's role is the one it was opened with, kept across starts", async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-roles-')), 'session-roles.json')
  const roles = new SessionRoles(file)
  roles.register(INTERVENE)
  roles.register(GAMES)
  await roles.tag('s1', 'games')
  assert.equal(roles.of('s1', '随便起的名字'), 'games', 'the tag wins over the title')
  assert.equal(roles.of('s2', null), undefined, 'untagged and untitled: the main agent')
  const again = new SessionRoles(file)
  again.register(GAMES)
  await again.loaded
  assert.equal(again.of('s1', null), 'games', 'read back after a restart')
})

test('who asked for a session is kept with its role, and older files still read', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-roles-')), 'session-roles.json')
  writeFileSync(file, JSON.stringify({ old: 'games' }))
  const roles = new SessionRoles(file)
  roles.register(INTERVENE)
  roles.register(GAMES)
  await roles.tag('s1', 'intervene', '监控')
  assert.equal(roles.of('old', null), 'games', 'a role saved alone, as before')
  assert.equal(roles.requestedBy('old'), undefined)
  assert.equal(roles.requestedBy('s1'), '监控')
  const again = new SessionRoles(file)
  again.register(INTERVENE)
  await again.loaded
  assert.equal(again.of('s1', null), 'intervene')
  assert.equal(again.requestedBy('s1'), '监控', 'read back after a restart')
})

test("a role keeps the tools it names, a family by its prefix, and all of them when it names none", () => {
  const tools = ['screen_*', 'script_run', 'intervention_done']
  assert.equal(keeps(tools, 'screen_tap'), true)
  assert.equal(keeps(tools, 'script_run'), true)
  assert.equal(keeps(tools, 'script_run_log'), false, 'a name without * is exact')
  assert.equal(keeps(tools, 'pipeline_run'), false)
  assert.equal(keeps(undefined, 'pipeline_run'), true)
})

test("only a session's tag names its agent's role (narrowing), not its title", async () => {
  const roles = new SessionRoles(undefined)
  roles.register({ ...INTERVENE, tools: ['screen_*'], duty: '处理事故' })
  await roles.tag('s1', 'intervene')
  assert.equal(roles.tagged('s1'), 'intervene')
  assert.equal(roles.tagged('s2'), undefined)
  assert.equal(roles.of('s2', '干预：x'), 'intervene', 'listed under it by its title')
  assert.equal(roles.spec('intervene')?.duty, '处理事故')
  assert.deepEqual(Object.keys(roles.list()[0]!).sort(), ['description', 'id', 'name', 'order'], 'the protocol gets no tools or duty')
})

test('sessions from before roles fall under the role whose title prefix they have', () => {
  const roles = new SessionRoles(undefined)
  roles.register(INTERVENE)
  roles.register(GAMES)
  assert.equal(roles.of('a', '干预：MAA · 日常：出错'), 'intervene')
  assert.equal(roles.of('b', '日报：11月3日'), 'games')
  assert.equal(roles.of('c', '飞书：张三'), undefined, 'a chat channel is the main agent')
  assert.equal(roles.of('d', '帮我看看干预：怎么回事'), undefined, 'only a prefix counts')
  assert.equal(roles.of('e', '今天跑什么'), undefined)
})

test("a role whose plugin is not loaded gives its sessions back to the main agent", async () => {
  const roles = new SessionRoles(undefined)
  const drop = roles.register(INTERVENE)
  await roles.tag('s1', 'intervene')
  assert.equal(roles.of('s1', '干预：x'), 'intervene')
  drop()
  assert.equal(roles.of('s1', '干预：x'), undefined)
})

test('the role agents model is kept across starts, and cleared', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-role-model-')), 'role-model.json')
  const model = new RoleModel(file)
  await model.loaded
  assert.equal(model.get(), undefined, 'none chosen at first')
  await model.set({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'low' })
  const again = new RoleModel(file)
  await again.loaded
  assert.deepEqual(again.get(), { provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'low' })
  await again.set(undefined)
  const cleared = new RoleModel(file)
  await cleared.loaded
  assert.equal(cleared.get(), undefined)
})

test("the main agent's call that handed a session its work is kept with its tag", async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-roles-')), 'session-roles.json')
  const roles = new SessionRoles(file)
  await roles.tag('w1', 'games', '助手', { sessionId: 'main-1', callId: 'call-7' })
  await roles.tag('w2', 'games')
  const again = new SessionRoles(file)
  await again.loaded
  assert.deepEqual(again.delegatedFrom('w1'), { sessionId: 'main-1', callId: 'call-7' })
  assert.equal(again.requestedBy('w1'), '助手')
  assert.equal(again.delegatedFrom('w2'), undefined)
})
