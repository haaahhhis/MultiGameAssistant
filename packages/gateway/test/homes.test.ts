import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { HandOff } from '@adg/protocol'
import { AgentHomes, HandOffs } from '../src/homes.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'adg-homes-'))

test("each agent's one conversation is remembered, and a deleted agent's is let go", async () => {
  const file = join(dir(), 'agent-homes.json')
  const homes = new AgentHomes(file)
  await homes.set('main', 's-main')
  await homes.set('games', 's-games')
  const again = new AgentHomes(file)
  await again.loaded
  assert.equal(again.get('main'), 's-main')
  assert.equal(again.agentOf('s-games'), 'games')
  assert.equal(again.agentOf('s-other'), undefined)
  await again.drop('games')
  const after = new AgentHomes(file)
  await after.loaded
  assert.equal(after.get('games'), undefined)
  assert.equal(after.get('main'), 's-main')
})

const item = (over: Partial<HandOff>): HandOff => ({
  id: 'h1', fromSession: 's-main', callId: 'call-1', by: '助手', to: 'games', toSession: 's-games',
  title: '读活动', task: '读明日方舟今天的活动', state: 'running', startedAt: 1, ...over,
})

test('hand-offs are listed for both conversations, told as they change, and kept', async () => {
  const file = join(dir(), 'handoffs.json')
  const told: HandOff[] = []
  const handOffs = new HandOffs(file, h => told.push(h))
  await handOffs.put(item({}))
  await handOffs.put(item({ id: 'h2', fromSession: 's-other', toSession: 's-scripts', to: 'scripts' }))
  await handOffs.put(item({ state: 'done', reply: '没有快结束的', endedAt: 5 }))
  assert.deepEqual(told.map(h => `${h.id}:${h.state}`), ['h1:running', 'h2:running', 'h1:done'])
  assert.deepEqual(handOffs.of('s-main').map(h => h.id), ['h1'])
  assert.deepEqual(handOffs.of('s-games').map(h => h.id), ['h1'], 'the agent that did it sees it too')
  const again = new HandOffs(file)
  await again.loaded
  assert.equal(again.get('h1')?.reply, '没有快结束的')
})

test('a hand-off still running when the app stopped is kept as failed: its turn is lost', async () => {
  const file = join(dir(), 'handoffs.json')
  writeFileSync(file, JSON.stringify([item({})]))
  const handOffs = new HandOffs(file)
  await handOffs.loaded
  assert.equal(handOffs.get('h1')?.state, 'failed')
  assert.match(handOffs.get('h1')?.reply ?? '', /软件关闭时/)
})
