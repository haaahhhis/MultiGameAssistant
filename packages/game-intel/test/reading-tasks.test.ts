import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GameReading } from '@adg/protocol'
import type { Reply } from '@adg/notify'
import { ReadingTasks } from '../src/reading-tasks.ts'

test('screen waiters can be cancelled independently while a web probe runs; only the owning session receives its result', async () => {
  const states = new Map<string, GameReading>()
  const complete = Promise.withResolvers<void>()
  const webDone = Promise.withResolvers<void>()
  const aStarts = Promise.withResolvers<void>()
  const aResult = Promise.withResolvers<Reply>()
  const tasks = new ReadingTasks(async (key, value) => {
    states.set(key, value)
    if (key === 'A' && value.state === 'done') complete.resolve()
    if (key === 'C' && value.state === 'failed') webDone.resolve()
  }, Date.now, assert.fail)
  const a = { key: 'A', screen: true, open: async () => ({ id: 'worker-A', owner: 'games-home', run: async () => '' }), run: async () => { aStarts.resolve(); return aResult.promise } }
  await tasks.start(a)
  await aStarts.promise
  await assert.rejects(tasks.start(a), /已有同类探查/)
  const b = await tasks.start({ key: 'B', screen: true, open: async () => ({ id: 'worker-B', owner: 'games-home', run: async () => '' }), run: async () => assert.fail('cancelled waiter must not execute') })
  assert.equal(states.get('B')?.state, 'queued')
  await tasks.start({ key: 'C', screen: false, open: async () => ({ id: 'worker-C', owner: 'games-home', run: async () => '' }), run: async () => ({
    outcome: 'failed', ended: 'Request timed out.', blocks: [{ kind: 'text', text: '我会检查' }],
  }) })
  await webDone.promise
  assert.equal(states.get('C')?.summary, 'Request timed out.')
  assert.equal(await tasks.cancel(states.get('B')!.taskId!), true)
  assert.equal(states.get('B')?.state, 'cancelled')
  assert.equal(states.get('A')?.state, 'running')
  aResult.resolve({ outcome: 'completed', blocks: [{ kind: 'text', text: '已写入公告' }] })
  await complete.promise
  assert.equal(b, 'games-home')
  assert.equal(states.get('A')?.sessionId, b)
  assert.equal(states.get('A')?.taskId, 'worker-A')
  assert.equal(states.get('A')?.summary, '已写入公告')
})

test('reconciliation timeout retains the unfinished articles after other results were saved', async () => {
  const finished = Promise.withResolvers<GameReading>()
  const tasks = new ReadingTasks(async (_key, state) => { if (state.state === 'partial') finished.resolve(state) }, Date.now, assert.fail)
  await tasks.start({
    key: 'starrail#web', screen: false, scope: 'all', open: async () => ({ owner: 'games', id: 'first', run: async () => '' }),
    run: async (_work, _signal, checkpoint) => {
      await checkpoint(['https://example.org/news/2'], '已写入 15 项活动')
      throw new Error('Request timed out.')
    },
  })
  const partial = await finished.promise
  assert.equal(partial.sessionId, 'games')
  assert.deepEqual(partial.remainingUrls, ['https://example.org/news/2'])
  assert.match(partial.summary!, /15 项活动.*\nRequest timed out/)
  await tasks.stop()
})
