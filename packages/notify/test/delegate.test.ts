import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { delegateTool, HANDED, MAX_OUT } from '../src/delegate.ts'
import type { Conversations, HandOffInput } from '../src/notify.ts'
import type { Reply } from '../src/reply.ts'

const AGENTS = [{ id: 'games', name: '游戏' }, { id: 'scripts', name: '脚本' }]

/** Conversations that record the work handed off; it finishes when `release` is called. */
function fakeConversations() {
  const handed: HandOffInput[] = []
  const pending: (() => void)[] = []
  const conversations = {
    handOff: (input: HandOffInput) => {
      handed.push(input)
      return new Promise<Reply>(resolve => pending.push(() => resolve({ blocks: [{ kind: 'text', text: '好了' }] })))
    },
  } as unknown as Conversations
  return { conversations, handed, release: () => { for (const done of pending.splice(0)) done() } }
}

const exec = (sessionId: string, callId: string) => ({ callId, agent: { session: { id: sessionId } }, signal: new AbortController().signal }) as never

test("work handed on goes to the agent as 助手's, returns at once, and tells 助手 to end its turn", async () => {
  const fake = fakeConversations()
  const relayed = (_reply: Reply) => {}
  const tool = delegateTool({ agents: () => AGENTS, conversations: () => fake.conversations, relayed: sessionId => (sessionId === 'main-1' ? relayed : undefined) })
  const value = await tool.execute({ agent: '游戏', task: '读明日方舟今天的活动\n只看国服', expecting: '今天结束的活动' }, exec('main-1', 'call-7'))
  assert.deepEqual(value, { agent: '游戏', id: 'call-7' }, 'before the work is done')
  const handed = fake.handed[0]!
  assert.deepEqual(handed.to, { id: 'games', name: '游戏' })
  assert.equal(handed.by, '助手')
  assert.equal(handed.title, '读明日方舟今天的活动')
  assert.equal(handed.task, '读明日方舟今天的活动\n只看国服')
  assert.equal(handed.expecting, '今天结束的活动')
  assert.deepEqual(handed.from, { sessionId: 'main-1', callId: 'call-7', asker: '助手' })
  assert.equal(handed.relay, true, 'its reply comes back as a message')
  assert.equal(handed.relayed, relayed, 'and to the chat person 助手 was answering')
  assert.deepEqual(tool.output!.render!({}, value as never), [{ type: 'text', text: HANDED('游戏') }])
  assert.match(HANDED('游戏'), /结束这一轮.*不要替它回答/)
  fake.release()
})

test('an agent that does not exist is refused, naming the ones that do', async () => {
  const fake = fakeConversations()
  const tool = delegateTool({ agents: () => AGENTS, conversations: () => fake.conversations })
  await assert.rejects(tool.execute({ agent: '编排', task: 'x' }, exec('m', 'c')), /没有叫「编排」的 agent。可以交给：游戏、脚本/)
  assert.equal(fake.handed.length, 0)
})

test(`one conversation has at most ${MAX_OUT} pieces of work out at once, counted until each comes back`, async () => {
  const fake = fakeConversations()
  const tool = delegateTool({ agents: () => AGENTS, conversations: () => fake.conversations })
  for (let i = 0; i < MAX_OUT; i++) await tool.execute({ agent: '游戏', task: `第 ${i} 件` }, exec('m', `c${i}`))
  await assert.rejects(tool.execute({ agent: '游戏', task: '再一件' }, exec('m', 'cx')), /已经有 3 件事/)
  await tool.execute({ agent: '游戏', task: '别的对话' }, exec('other', 'c'))
  fake.release()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(await tool.execute({ agent: '游戏', task: '回来以后' }, exec('m', 'cy')), { agent: '游戏', id: 'cy' })
})
