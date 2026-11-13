import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { hiddenTools, keeps, RoleModel, SessionRoles, subAgentSpec, teamPrompt } from '../src/roles.ts'

const INTERVENE = { id: 'intervene', name: '干预', description: '脚本出错、卡住时处理', order: 10, titles: ['干预'] }
const GAMES = { id: 'games', name: '游戏', description: '读游戏活动和资讯', order: 20, titles: ['游戏信息', '日报'] }

test('an agent keeps what its role names of the app tools; dsh tools stay, but nobody forks', () => {
  const spec = { tools: ['script_*', 'agent_delegate'] }
  const app = new Set(['script_run', 'screen_click', 'agent_delegate'])
  assert.deepEqual(hiddenTools(spec, app, ['script_run', 'screen_click', 'agent_delegate', 'read', 'subagent', 'subagent_fork']), ['screen_click', 'subagent_fork'])
})

test("the concrete work is not in an agent's one conversation; its sub-agents have it", () => {
  const scripts = { id: 'scripts', name: '脚本', description: '', order: 30, tools: ['script_*', 'screen_*', 'pipeline_*'], duty: '# 你的角色：脚本\n只管脚本' }
  const app = new Set(['script_run', 'script_install', 'script_list', 'screen_capture', 'screen_tap', 'pipeline_run', 'pipeline_status'])
  const visible = [...app, 'pwsh', 'write', 'edit', 'workflow', 'read', 'grep', 'web_search', 'subagent', 'agent_message']
  const hidden = hiddenTools(scripts, app, visible, true)
  for (const tool of ['pwsh', 'write', 'edit', 'workflow', 'screen_capture', 'screen_tap', 'script_run', 'script_install']) assert.ok(hidden.includes(tool), `${tool} is hands-on`)
  for (const tool of ['read', 'grep', 'web_search', 'script_list', 'pipeline_run', 'pipeline_status', 'subagent', 'agent_message']) assert.ok(!hidden.includes(tool), `${tool} stays`)
  assert.deepEqual(hiddenTools(scripts, app, visible), [], 'another of its sessions is a one-off')
  const child = subAgentSpec(scripts)
  for (const tool of ['pwsh', 'write', 'screen_tap', 'script_run']) assert.ok(!hiddenTools(child, app, visible).includes(tool), `its sub-agent has ${tool}`)
  assert.match(child.duty ?? '', /只管脚本/, 'it works to its parent\'s duty')
  assert.doesNotMatch(child.duty ?? '', /你的角色：脚本/, 'without being told it is its parent')
  assert.ok(hiddenTools(child, app, ['intervention_done']).includes('intervention_done'), 'concluding is its parent\'s')
})

test("a sub-agent has its parent's tools for the work, and none for working with others", () => {
  const scripts = { id: 'scripts', name: '脚本', description: '', order: 30, tools: ['script_*', 'agent_delegate', 'notice_act'] }
  const child = subAgentSpec(scripts)
  const app = new Set(['script_run', 'screen_click', 'agent_delegate', 'notice_act'])
  const hidden = hiddenTools(child, app, ['script_run', 'screen_click', 'agent_delegate', 'notice_act', 'read', 'send_message', 'subagent', 'subagent_fork', 'ask_user_question', 'schedule_create'])
  assert.deepEqual(hidden.toSorted(), ['agent_delegate', 'ask_user_question', 'notice_act', 'schedule_create', 'screen_click', 'subagent', 'subagent_fork'])
  assert.equal(child.subAgentOf, '脚本')
  assert.match(child.duty ?? '', /「脚本」的子 agent/)
  assert.doesNotMatch(child.duty ?? '', /助手/, 'it is not told it is the main agent')
})

test("a sub-agent of the agent pipelines belong to saves and times them too; other timers stay its lead's", () => {
  const pipelines = { id: 'pipelines', name: '编排', description: '', order: 40, tools: ['pipeline_save', 'pipeline_get', 'schedule_set', 'schedule_task_*'] }
  const app = new Set(['pipeline_save', 'pipeline_get', 'pipeline_draft', 'schedule_set', 'schedule_task_save', 'schedule_task_list'])
  const visible = [...app, 'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_list', 'read']
  assert.deepEqual(hiddenTools(pipelines, app, visible, true), ['pipeline_draft'], 'in its own conversation: everything of pipelines and timers but the draft tool')
  const hidden = hiddenTools(subAgentSpec(pipelines), app, visible)
  for (const tool of ['pipeline_save', 'pipeline_get', 'schedule_set', 'read']) assert.ok(!hidden.includes(tool), `its sub-agent has ${tool}`)
  for (const tool of ['pipeline_draft', 'schedule_task_save', 'schedule_task_list', 'schedule_create', 'schedule_update', 'schedule_delete', 'schedule_list']) assert.ok(hidden.includes(tool), `${tool} is not a sub-agent's`)
  // A lead without it (脚本) gives its sub-agents none of it.
  const scripts = subAgentSpec({ id: 'scripts', name: '脚本', description: '', order: 30, tools: ['script_*'] })
  for (const tool of ['pipeline_save', 'schedule_set']) assert.ok(hiddenTools(scripts, app, visible).includes(tool), `脚本's sub-agent has no ${tool}`)
  // 助手 does not see the save tool: it drafts, or hands the change to 编排.
  assert.ok(hiddenTools({ tools: ['pipeline_*'], hide: ['pipeline_save'] }, app, visible).includes('pipeline_save'))
})

test('an agent is told who it is, who else there is, and how to tell who is talking', () => {
  const main = { id: 'main', name: '助手', description: '和用户对话' }
  const scripts = { id: 'scripts', name: '脚本', description: '安装脚本' }
  const games = { id: 'games', name: '游戏', description: '读活动' }
  const lead = teamPrompt(scripts, main, [scripts, games])
  assert.match(lead, /你是「脚本」（scripts）/)
  assert.match(lead, /上级是「助手」（main）/)
  assert.match(lead, /同事：\n- 「游戏」（games）：读活动/)
  assert.doesNotMatch(lead, /- 「脚本」/, 'not its own colleague')
  assert.match(lead, /没有任何标注：用户本人/)
  assert.match(lead, /不等于用户同意/)
  const top = teamPrompt(main, main, [scripts, games])
  assert.match(top, /最上级/)
  assert.match(top, /下面的主 agent：\n- 「脚本」（scripts）：安装脚本\n- 「游戏」/)
  assert.match(teamPrompt(scripts, main, [scripts]), /现在没有其他同事/)
})

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

