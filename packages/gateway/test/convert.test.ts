import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { SessionEvent } from '@adg/protocol'
import { convertEvent, convertLiveBaseline, convertLiveFrame, convertRecords, streamFacts } from '../src/convert.ts'

/** Compact stream in the upstream `AssistantStreamRecord` format. */
const stream = [
  { type: 'chunk', time: 1000, chunk: { type: 'block-start', index: 0, blockType: 'reasoning' } },
  { type: 'reasoning-chunks', time0: 1100, index: 0, dt: [10, 10], texts: ['', 'think', 'ing'] },
  { type: 'text-chunks', time0: 1200, index: 1, dt: [50], texts: ['Hi', '!'] },
  { type: 'chunk', time: 1300, chunk: { type: 'usage', usage: { inputTokens: 5, outputTokens: 7 } } },
  { type: 'chunk', time: 1301, chunk: { type: 'finish', reason: { kind: 'stop' } } },
]

test('stream facts: first chunk, first non-empty token, last chunk', () => {
  const { timing, failure } = streamFacts(stream)
  assert.deepEqual(timing, { firstChunkAt: 1000, firstTokenAt: 1110, lastChunkAt: 1301, tokenChunks: 4 })
  assert.equal(failure, undefined)
})

test('stream facts: finish error becomes the attempt failure', () => {
  const { failure } = streamFacts([
    { type: 'chunk', time: 5, chunk: { type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMIT' } } } },
  ])
  assert.deepEqual(failure, { message: 'rate limited', code: 'RATE_LIMIT' })
})

test('assistant/message keeps content, timing, usage and model source', () => {
  const event = convertEvent({
    type: 'assistant/message', seq: 9, time: 1400,
    data: {
      turn: 1, step: 2, stream,
      usage: { inputTokens: 5, outputTokens: 7, cacheReadTokens: 100 },
      message: {
        id: 'msg-1', role: 'assistant',
        source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-v4' },
        content: [
          { type: 'reasoning', text: 'thinking' },
          { type: 'text', text: 'Hi!' },
          { type: 'tool-call', id: 'call-1', name: 'bash', arguments: '{"command":"ls"}' },
        ],
      },
    },
  })
  assert.equal(event.type, 'assistant/message')
  assert.ok(SessionEvent.safeParse(event).success)
  if (event.type !== 'assistant/message') return
  assert.equal(event.model, 'deepseek-v4')
  assert.equal(event.usage?.cacheReadTokens, 100)
  assert.equal(event.timing.firstTokenAt, 1110)
  assert.deepEqual(event.content[2], { type: 'tool-call', callId: 'call-1', name: 'bash', arguments: '{"command":"ls"}' })
})

test('user/message distinguishes human prompts from injected context', () => {
  const human = convertEvent({
    type: 'user/message', seq: 1, time: 1, surfaceOp: 'append',
    data: { id: 'u1', role: 'user', content: [{ type: 'text', text: 'hello' }], source: { kind: 'user-rpc', rpcId: 'r-1' } },
  })
  const injected = convertEvent({
    type: 'user/message', seq: 2, time: 2, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 },
    data: { id: 'u2', role: 'user', content: [], source: { kind: 'file-change', form: 'notice', summary: '3 files changed' } },
  })
  assert.ok(human.type === 'user/message' && injected.type === 'user/message')
  assert.deepEqual(human.origin, { kind: 'user-rpc', human: true })
  assert.equal(human.requestId, 'r-1')
  assert.deepEqual(injected.origin, { kind: 'file-change', human: false, summary: '3 files changed' })
  assert.equal(injected.replacesHistory, true)
})

test('tool/result carries the error identity and reason', () => {
  const event = convertEvent({
    type: 'tool/result', seq: 4, time: 4,
    data: {
      turn: 1, step: 1,
      message: { id: 'm', role: 'tool', toolCallId: 'call-1', isError: true, content: [{ type: 'text', text: 'boom' }] },
      error: { name: 'ToolError', code: 'EXIT_1', reason: 'command failed' },
    },
  })
  assert.ok(event.type === 'tool/result')
  assert.equal(event.isError, true)
  assert.deepEqual(event.error, { message: 'command failed', code: 'EXIT_1' })
})

test('turn/end exposes the failure message', () => {
  const event = convertEvent({
    type: 'turn/end', seq: 5, time: 5,
    data: { turn: 3, reason: { kind: 'error', error: { message: 'provider down', code: 'UNKNOWN' } } },
  })
  assert.deepEqual(event, { type: 'turn/end', seq: 5, time: 5, turn: 3, reason: { kind: 'error', message: 'provider down' } })
})

test('unrecognized events pass through as unknown', () => {
  const event = convertEvent({ type: 'plugin:x/thing', seq: 7, time: 7, data: { a: 1 } })
  assert.deepEqual(event, { type: 'unknown', seq: 7, time: 7, upstreamType: 'plugin:x/thing', data: { a: 1 } })
})

test('history records keep only event entries', () => {
  const events = convertRecords([
    { type: 'event', event: { type: 'turn/start', seq: 0, time: 0, data: { turn: 1 } } },
    { type: 'something-else' },
  ])
  assert.deepEqual(events, [{ type: 'turn/start', seq: 0, time: 0, turn: 1 }])
})

test('live frames: chunk deltas convert, block markers are dropped', () => {
  assert.deepEqual(
    convertLiveFrame({ type: 'chunk', attemptId: 'a', revision: 1, index: 0, time: 10, chunk: { type: 'text-delta', index: 1, text: 'He' } }),
    { type: 'delta', attemptId: 'a', time: 10, kind: 'text', index: 1, text: 'He' },
  )
  assert.equal(convertLiveFrame({ type: 'chunk', attemptId: 'a', revision: 1, index: 1, time: 11, chunk: { type: 'block-end', index: 1 } }), null)
  assert.deepEqual(
    convertLiveFrame({ type: 'end', attemptId: 'a', revision: 1, index: 2, outcome: { kind: 'committed', eventType: 'assistant/message', seq: 40 } }),
    { type: 'end', attemptId: 'a', outcome: 'committed', seq: 40 },
  )
})

test('live baseline expands compact runs into ordered deltas', () => {
  const live = convertLiveBaseline({
    revision: 3,
    activeAttempt: {
      attemptId: 'a', startedAfterSeq: 12, turn: 2, step: 1, nextIndex: 3,
      stream: [{ type: 'text-chunks', time0: 100, index: 0, dt: [5, 5], texts: ['a', 'b', 'c'] }],
    },
  })
  assert.ok(live)
  assert.equal(live.afterSeq, 12)
  assert.deepEqual(live.deltas.map(d => [d.time, d.text]), [[100, 'a'], [105, 'b'], [110, 'c']])
})
