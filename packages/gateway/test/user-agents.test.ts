import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { keeps, SessionRoles } from '../src/roles.ts'
import { roleOf, UserAgents } from '../src/user-agents.ts'

const DAILY = { name: '日常', duty: '每天检查脚本有没有跑完。\n没跑完的重跑。', tools: ['scripts', 'screen'], model: null }

test('an agent the person makes is kept, changed in place and deleted', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-agents-')), 'agents.json')
  const agents = new UserAgents(file)
  const made = await agents.save({ ...DAILY, tools: ['scripts', 'nope', 'screen'] }, ['助手', '游戏'])
  assert.match(made.id, /^u-/)
  assert.deepEqual(made.tools, ['screen', 'scripts'], 'known groups only, in their order')

  const changed = await agents.save({ ...DAILY, id: made.id, name: '日常巡检', model: { provider: 'p', model: 'm' } }, ['助手'])
  assert.equal(changed.id, made.id)
  const again = new UserAgents(file)
  await again.loaded
  assert.deepEqual(again.list(), [changed], 'kept across starts')

  assert.equal(await again.delete(made.id), true)
  assert.equal(await again.delete(made.id), false)
  assert.deepEqual(JSON.parse(readFileSync(file, 'utf8')), [])
})

test('a name already in the roster, or an empty duty, is refused', async () => {
  const agents = new UserAgents(undefined)
  await assert.rejects(agents.save({ ...DAILY, name: '游戏' }, ['助手', '游戏']), /已经有叫「游戏」/)
  const made = await agents.save(DAILY, [])
  await assert.rejects(agents.save(DAILY, []), /已经有叫「日常」/, 'not twice')
  await agents.save({ ...DAILY, id: made.id, duty: '只看日志' }, [])
  await assert.rejects(agents.save({ ...DAILY, name: 'x', duty: '  ' }, []), /职责/)
  await assert.rejects(agents.save({ ...DAILY, id: 'u-gone' }, []), /没有这个 agent/)
})

test('a broken agents.json loads what it can', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-agents-')), 'agents.json')
  writeFileSync(file, JSON.stringify([{ id: 'u-1', name: 'a', duty: 'b', model: { provider: 1 } }, { name: 'no id' }, null]))
  const agents = new UserAgents(file)
  await agents.loaded
  assert.deepEqual(agents.list(), [{ id: 'u-1', name: 'a', duty: 'b', tools: [], model: null }])
})

test("its role keeps the groups it was given and the app's basics, with its duty, and is marked as the person's", () => {
  const spec = roleOf({ ...DAILY, id: 'u-1' }, 2)
  assert.equal(spec.order, 102)
  assert.equal(spec.description, '每天检查脚本有没有跑完。', 'the first line of its duty')
  assert.match(spec.duty!, /^# 你的角色：日常\n\n每天检查/)
  for (const tool of ['script_run', 'pack_propose', 'screen_tap', 'window_list', 'system_info', 'skill_save']) assert.equal(keeps(spec.tools, tool), true, tool)
  for (const tool of ['game_add', 'pipeline_run', 'emulator_start', 'monitor_incidents', 'intervention_done']) assert.equal(keeps(spec.tools, tool), false, tool)
  const roles = new SessionRoles(undefined)
  roles.register(spec)
  assert.deepEqual(roles.list(), [{ id: 'u-1', name: '日常', description: '每天检查脚本有没有跑完。', order: 102, custom: true }])
})
