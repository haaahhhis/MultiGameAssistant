import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildChat } from '../src/chat.ts'
import type { SessionEvent } from '@adg/protocol'

const start = (seq: number): SessionEvent => ({ type: 'compaction/start', seq, time: seq, compactionId: `k${seq}`, turn: null })
const end = (seq: number, error?: string): SessionEvent => ({ type: 'compaction/end', seq, time: seq, compactionId: `k${seq}`, turn: null, ...(error === undefined ? {} : { error }) })
const summary = (seq: number): SessionEvent => ({
  type: 'user/message', seq, time: seq, messageId: `m${seq}`, replacesHistory: true,
  origin: { kind: 'compaction', human: false }, content: [{ type: 'text', text: '摘要' }],
})
const kinds = (events: SessionEvent[]) => buildChat(events, null).map(i => i.kind)

test('a compaction shows once: its summary card, without a second line saying the same', () => {
  // The summary before the end (what dsh does), and after it.
  assert.deepEqual(kinds([start(1), summary(2), end(3)]), ['context'])
  assert.deepEqual(kinds([start(1), end(2), summary(3)]), ['context'])
  // Two in a row (low-context mode): one card each.
  assert.deepEqual(kinds([start(1), summary(2), end(3), start(4), summary(5), end(6)]), ['context', 'context'])
})

test('a compaction with no summary still says so, and a failed one shows its error', () => {
  assert.deepEqual(buildChat([start(1), end(2)], null).map(i => i.kind === 'notice' ? i.text : i.kind), ['对话太长，较早的内容已压缩成摘要'])
  const failed = buildChat([start(1), end(2, '模型没有回应')], null)
  assert.ok(failed.length === 1 && failed[0]!.kind === 'notice' && failed[0]!.tone === 'error')
  // A summary from an earlier compaction does not hide a later one's failure.
  assert.deepEqual(kinds([start(1), summary(2), end(3), start(4), end(5, 'x')]), ['context', 'notice'])
})
