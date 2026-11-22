import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { AdgGateway } from '@adg/gateway'
import type { HandOff } from '@adg/protocol'
import { sessionConversations } from '../src/conversations.ts'

test('each app instruction runs in a native child of the stable role home with its own focus', async () => {
  const calls: string[][] = []
  const gateway = {
    promptChild: async () => assert.fail('no follow-up expected'),
    stopSubAgent: () => {},
    home: async (role: string) => role + '-home',
    handOffs: { put: async () => {}, all: () => [] },
    runChild: async (owner: string, id: string, title: string, instruction: string) => {
      calls.push([owner, id, title, instruction])
      return '完成'
    },
  }
  const focused: string[] = []
  const conversations = sessionConversations({} as never, undefined, async id => focused.push(id), () => gateway)
  const a = await conversations.prepareTask('games', '查活动', { games: ['a'] })
  const b = await conversations.prepareTask('games', '查公告', { games: ['b'] })
  assert.deepEqual(focused, [a.id, b.id])
  assert.notEqual(a.id, b.id)
  await b.run('读官网', new AbortController().signal)
  assert.deepEqual(calls, [['games-home', b.id, '查公告', '读官网']])
})

test('a running role worker receives updates at its durable address and refuses failed deliveries without losing its task', { timeout: 5000 }, async () => {
  const work = Promise.withResolvers<string>()
  const started = Promise.withResolvers<string>()
  const attempted = Promise.withResolvers<void>()
  const admit = Promise.withResolvers<void>()
  const finish = Promise.withResolvers<void>()
  const records: HandOff[] = []
  const prompts: Parameters<AdgGateway['promptChild']>[0][] = []
  let worker: string
  let closed = 0
  const gateway = {
    home: async () => 'scripts-home',
    handOffs: { put: async (item: HandOff) => { records.push(item) }, all: () => records.slice(-1) },
    runChild: async (_owner: string, id: string) => { worker = id; started.resolve(id); return work.promise },
    stopSubAgent: () => assert.fail('the original work must continue'),
    promptChild: async (prompt: Parameters<AdgGateway['promptChild']>[0]) => {
      prompts.push(prompt)
      assert.equal(prompt.childSessionId, worker)
      assert.equal(prompt.delivery, 'steer')
      if (prompts.length === 1) throw new Error('child input closed')
      attempted.resolve()
      await admit.promise
      return { messageId: 'admitted' }
    },
  }
  const sessions = {
    list: async () => assert.fail('the hand-off already knows the durable parent'),
    prompt: async () => assert.fail('a worker requires native delivery'),
    async *follow({ address }: { address: unknown }) {
      assert.deepEqual(address, { kind: 'subagent', parentSessionId: 'scripts-home', childSessionId: worker, mode: 'unknown' })
      try {
        yield { type: 'snapshot' }
        await finish.promise
        const prompt = prompts.at(-1)!
        const frame = (seq: number, type: string, data: object) => ({ type: 'event', event: { type, seq, time: 0, data: { turn: 1, step: 1, ...data } } })
        yield frame(1, 'user/message', { id: 'u', source: { kind: 'user', rpcId: prompt.requestId }, content: prompt.content })
        yield frame(2, 'assistant/message', { message: { id: 'a', content: [{ type: 'text', text: '已按补充要求完成' }] } })
        yield frame(3, 'turn/end', { reason: { kind: 'completed' } })
      } finally { closed++ }
    },
  }
  const desk = sessionConversations(sessions as never, undefined, undefined, () => gateway).desk!
  const task = desk.handOff({
    to: { id: 'scripts', name: '脚本' }, by: '助手', title: '读日志', task: '分析报错', signal: new AbortController().signal,
    from: { sessionId: 'main-home', agent: 'main', callId: 'thread' },
  })
  await started.promise
  const update = (text: string) => desk.message({ thread: 'thread', fromSession: 'main-home', from: '助手', kind: 'update', text })
  await assert.rejects(update('第一次'), /child input closed/)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(records.at(-1)?.state, 'running')
  assert.equal(records.at(-1)?.messages, undefined)
  assert.equal(closed, 1)

  let acknowledged = false
  const sent = update('再查一次').then(receipt => { acknowledged = true; return receipt })
  await attempted.promise
  assert.equal(acknowledged, false)
  admit.resolve()
  assert.match(await sent, /已经告诉它了/)
  assert.deepEqual(records.at(-1)?.messages?.map(m => m.text), ['再查一次'])
  assert.equal(records.at(-1)?.state, 'running')
  work.resolve('初步结果')
  finish.resolve()
  await task
  assert.equal(records.at(-1)?.state, 'done')
  assert.equal(records.at(-1)?.reply, '已按补充要求完成')
  assert.equal(closed, 2)
})
