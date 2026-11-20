import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { AgentModels } from '../src/agent-models.ts'

const FLASH = { provider: 'deepseek', model: 'deepseek-flash' }
const PRO = { provider: 'deepseek', model: 'deepseek-pro', reasoningEffort: 'high' }
const VISION = { provider: 'qwen', model: 'qwen-vl' }

test('nothing set: every agent follows the default, every sub-agent its agent', async () => {
  const models = new AgentModels(join(mkdtempSync(join(tmpdir(), 'adg-agent-models-')), 'agent-models.json'))
  await models.loaded
  assert.deepEqual(models.state(), { agents: {}, subAgents: null, subAgentsOf: {}, fallbacks: { agents: [], subAgents: [] } })
  assert.equal(models.of('intervene'), undefined)
  assert.equal(models.subOf('intervene'), undefined)
})

test("an agent's sub-agents take their own model, else every sub-agent's; kept across starts and cleared one layer at a time", async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-agent-models-')), 'agent-models.json')
  const models = new AgentModels(file)
  await models.set({ agentId: 'intervene' }, PRO)
  await models.set({ sub: true }, FLASH)
  await models.set({ agentId: 'intervene', sub: true }, VISION)
  const again = new AgentModels(file)
  await again.loaded
  assert.deepEqual(again.of('intervene'), PRO)
  assert.equal(again.of('games'), undefined, 'another agent still follows the default')
  assert.deepEqual(again.subOf('intervene'), VISION, "its own sub-agents' model first")
  assert.deepEqual(again.subOf('games'), FLASH, "then every sub-agent's")
  assert.deepEqual(again.subOf('main'), FLASH)
  await again.set({ agentId: 'intervene', sub: true }, null)
  assert.deepEqual(again.subOf('intervene'), FLASH, "cleared: back to every sub-agent's")
  await again.set({ sub: true }, null)
  assert.equal(again.subOf('intervene'), undefined, 'and then the same as its agent')
  await again.set({ agentId: 'intervene' }, null)
  const cleared = new AgentModels(file)
  await cleared.loaded
  assert.deepEqual(cleared.state(), { agents: {}, subAgents: null, subAgentsOf: {}, fallbacks: { agents: [], subAgents: [] } })
})

test("the old 「角色 agent 的模型」 carries over to the role agents it served; 助手 keeps the default", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-agent-models-'))
  writeFileSync(join(dir, 'role-model.json'), JSON.stringify({ provider: 'deepseek', model: 'deepseek-flash', reasoningEffort: 'low' }))
  const models = new AgentModels(join(dir, 'agent-models.json'), join(dir, 'role-model.json'))
  await models.loaded
  for (const id of ['intervene', 'games', 'scripts', 'pipelines']) assert.deepEqual(models.of(id), { ...FLASH, reasoningEffort: 'low' }, id)
  assert.equal(models.of('main'), undefined)
  assert.equal(models.subOf('intervene'), undefined, 'sub-agents follow their agent, as they did')
  // Once the new file is written, the old one no longer counts.
  await models.set({ agentId: 'games' }, null)
  const again = new AgentModels(join(dir, 'agent-models.json'), join(dir, 'role-model.json'))
  await again.loaded
  assert.equal(again.of('games'), undefined)
  assert.deepEqual(again.of('scripts'), { ...FLASH, reasoningEffort: 'low' })
})

test('a target must name an agent or be every sub-agent', async () => {
  const models = new AgentModels(undefined)
  await assert.rejects(models.set({}, FLASH))
})

test('the fallback lists: one for the agents, one for the sub-agents, each model once, kept across starts', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-agent-models-')), 'agent-models.json')
  const models = new AgentModels(file)
  await models.setFallbacks(false, [PRO, FLASH, { ...PRO, reasoningEffort: 'low' }])
  await models.setFallbacks(true, [VISION])
  await models.set({ agentId: 'intervene' }, FLASH)
  const again = new AgentModels(file)
  await again.loaded
  assert.deepEqual(again.fallbacksOf(false), [PRO, FLASH], 'the same model twice is kept once, the first')
  assert.deepEqual(again.fallbacksOf(true), [VISION])
  assert.deepEqual(again.of('intervene'), FLASH, 'the other settings stay')
  await again.setFallbacks(true, [])
  assert.deepEqual(again.state().fallbacks, { agents: [PRO, FLASH], subAgents: [] })
})

test('a file from before the fallback lists reads as none', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-agent-models-')), 'agent-models.json')
  writeFileSync(file, JSON.stringify({ agents: { games: PRO }, subAgents: null, subAgentsOf: {} }))
  const models = new AgentModels(file)
  await models.loaded
  assert.deepEqual(models.state().fallbacks, { agents: [], subAgents: [] })
  assert.deepEqual(models.of('games'), PRO)
})
