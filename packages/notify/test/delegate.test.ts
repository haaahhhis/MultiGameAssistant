import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { delegatedMessage, delegateTool, MAX_OUT } from '../src/delegate.ts'
import type { Conversations } from '../src/notify.ts'
import type { Reply } from '../src/reply.ts'

const AGENTS = [{ id: 'games', name: '游戏' }, { id: 'scripts', name: '脚本' }]

/** Conversations that record what they were asked and answer with `answer` (or wait for `hold`). */
function fakeConversations(answer: (text: string) => Reply, hold?: Promise<void>) {
  const created: { title: string; options: unknown }[] = []
  const sent: { sessionId: string; text: string }[] = []
  const conversations: Conversations = {
    ask: async () => { throw new Error('not used') },
    converse: async (sessionId, text) => {
      sent.push({ sessionId, text })
      await hold
      return answer(text)
    },
    create: async (title, options) => { created.push({ title, options }); return `w${created.length}` },
    exists: async () => true,
  }
  return { conversations, created, sent }
}

const exec = (sessionId: string, callId: string) => ({ callId, agent: { session: { id: sessionId } }, signal: new AbortController().signal }) as never

test("work handed to an agent gets its own session under it, marked as 助手's call, and the agent's reply comes back", async () => {
  const fake = fakeConversations(() => ({ blocks: [{ kind: 'steps', steps: [] }, { kind: 'text', text: '今天结束的活动：无' }] } as never))
  const tool = delegateTool({ agents: () => AGENTS, conversations: () => fake.conversations })
  const value = await tool.execute({ agent: '游戏', task: '读明日方舟今天的活动\n只看国服', expecting: '今天结束的活动' }, exec('main-1', 'call-7'))
  assert.deepEqual(value, { agent: '游戏', sessionId: 'w1', reply: '今天结束的活动：无' })
  assert.deepEqual(fake.created, [{ title: '读明日方舟今天的活动', options: { role: 'games', by: '助手', from: { sessionId: 'main-1', callId: 'call-7' } } }])
  assert.equal(fake.sent[0]!.text, delegatedMessage('读明日方舟今天的活动\n只看国服', '今天结束的活动'))
  assert.match(fake.sent[0]!.text, /^（助手交给你的事：[^）]*）\n\n读明日方舟/)
  assert.deepEqual(tool.output!.render!({}, value as never), [{ type: 'text', text: '今天结束的活动：无' }], '助手 reads the reply alone')
})

test('work that did not finish, or left no reply, fails out loud', async () => {
  const stopped = delegateTool({ agents: () => AGENTS, conversations: () => fakeConversations(() => ({ blocks: [{ kind: 'text', text: '装到一半' }], ended: '被用户停止' })).conversations })
  await assert.rejects(stopped.execute({ agent: 'scripts', task: '装 MAA' }, exec('m', 'c')), /「脚本」没有做完（被用户停止）。它最后说：装到一半/)
  const silent = delegateTool({ agents: () => AGENTS, conversations: () => fakeConversations(() => ({ blocks: [] })).conversations })
  await assert.rejects(silent.execute({ agent: '脚本', task: '装 MAA' }, exec('m', 'c')), /没有留下回复/)
})

test('an agent that does not exist is refused, naming the ones that do', async () => {
  const fake = fakeConversations(() => ({ blocks: [] }))
  const tool = delegateTool({ agents: () => AGENTS, conversations: () => fake.conversations })
  await assert.rejects(tool.execute({ agent: '编排', task: 'x' }, exec('m', 'c')), /没有叫「编排」的 agent。可以交给：游戏、脚本/)
  assert.equal(fake.created.length, 0)
})

test(`one conversation has at most ${MAX_OUT} pieces of work out at once`, async () => {
  let release!: () => void
  const fake = fakeConversations(() => ({ blocks: [{ kind: 'text', text: '好了' }] }), new Promise(r => { release = r }))
  const tool = delegateTool({ agents: () => AGENTS, conversations: () => fake.conversations })
  const out = Array.from({ length: MAX_OUT }, (_, i) => tool.execute({ agent: '游戏', task: `第 ${i} 件` }, exec('m', `c${i}`)))
  await new Promise(r => setImmediate(r))
  await assert.rejects(tool.execute({ agent: '游戏', task: '再一件' }, exec('m', 'cx')), /已经有 3 件事/)
  const other = tool.execute({ agent: '游戏', task: '别的对话' }, exec('other', 'c'))
  release()
  await Promise.all([...out, other])
  assert.deepEqual(await tool.execute({ agent: '游戏', task: '回来以后' }, exec('m', 'cy')), { agent: '游戏', sessionId: `w${MAX_OUT + 2}`, reply: '好了' })
})
