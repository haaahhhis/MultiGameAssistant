import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { SessionEvent } from '@adg/protocol'
import { buildTrajectory, recordsActiveIn, timelineBars } from '../src/index.ts'

const T0 = 1_700_000_000_000
const human = { kind: 'user', human: true }

/** One completed turn: prompt → model calls a tool → result → final answer. */
function completedTurn(): SessionEvent[] {
  return [
    { type: 'turn/start', seq: 0, time: T0, turn: 1 },
    { type: 'user/message', seq: 1, time: T0 + 1, messageId: 'm1', content: [{ type: 'text', text: 'list files' }], origin: human },
    { type: 'step/start', seq: 2, time: T0 + 10, turn: 1, step: 1 },
    { type: 'system/message', seq: 3, time: T0 + 11, turn: 1, step: 1, text: 'You are helpful.' },
    { type: 'request/header', seq: 4, time: T0 + 12, provider: 'deepseek', model: 'v4', toolNames: ['bash', 'read'], reason: 'initial' },
    {
      type: 'assistant/attempt', seq: 5, time: T0 + 300, turn: 1, step: 1,
      timing: { firstChunkAt: T0 + 200, firstTokenAt: T0 + 210, lastChunkAt: T0 + 290, tokenChunks: 3 },
      error: { message: 'stream reset', code: 'NETWORK' },
    },
    {
      type: 'assistant/message', seq: 6, time: T0 + 1000, turn: 1, step: 1, messageId: 'a1',
      content: [{ type: 'tool-call', callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' }],
      timing: { firstChunkAt: T0 + 500, firstTokenAt: T0 + 510, lastChunkAt: T0 + 1010, tokenChunks: 20 },
      usage: { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900 },
    },
    { type: 'tool/call', seq: 7, time: T0 + 1020, turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    { type: 'approval/asked', seq: 8, time: T0 + 1021, approvalId: 'p1', toolName: 'bash', callId: 'c1' },
    { type: 'approval/decided', seq: 9, time: T0 + 1500, approvalId: 'p1', outcome: 'allowed-once' },
    { type: 'tool/result', seq: 10, time: T0 + 1600, turn: 1, step: 1, callId: 'c1', isError: false, content: [{ type: 'text', text: 'a.txt\nb.txt' }] },
    { type: 'step/end', seq: 11, time: T0 + 1601, turn: 1, step: 1 },
    { type: 'step/start', seq: 12, time: T0 + 1610, turn: 1, step: 2 },
    {
      type: 'assistant/message', seq: 13, time: T0 + 2500, turn: 1, step: 2, messageId: 'a2',
      content: [{ type: 'text', text: 'Two files: a.txt and b.txt' }],
      timing: { firstChunkAt: T0 + 1900, firstTokenAt: T0 + 1910, lastChunkAt: T0 + 2410, tokenChunks: 10 },
      usage: { inputTokens: 20, outputTokens: 100 },
    },
    { type: 'step/end', seq: 14, time: T0 + 2501, turn: 1, step: 2 },
    { type: 'turn/end', seq: 15, time: T0 + 2502, turn: 1, reason: { kind: 'completed' } },
  ]
}

test('groups records by turn and step in log order', () => {
  const model = buildTrajectory(completedTurn())
  assert.equal(model.groups.length, 1)
  const [turn] = model.groups
  assert.ok(turn)
  assert.equal(turn.turn, 1)
  assert.equal(turn.end, T0 + 2502)
  assert.equal(turn.reason?.kind, 'completed')
  assert.deepEqual(turn.steps.map(s => s.step), [1, 2])
  assert.deepEqual(model.records.map(r => r.kind), ['user', 'system', 'attempt', 'assistant', 'tool', 'assistant'])
})

test('TTFT spans step start to the earliest token across retries', () => {
  const model = buildTrajectory(completedTurn())
  const assistants = model.records.filter(r => r.kind === 'assistant')
  const [first, second] = assistants
  assert.ok(first && second && first.kind === 'assistant' && second.kind === 'assistant')
  assert.equal(first.request.ttftMs, 200) // retry token at +210, step start at +10
  assert.equal(first.request.retries, 1)
  assert.equal(first.request.lastRetryError?.code, 'NETWORK')
  assert.equal(first.request.decodeMs, 500)
  assert.equal(first.request.tokensPerSecond, 100)
  assert.equal(first.request.model, 'v4')
  assert.equal(first.request.toolCount, 2)
  assert.equal(second.request.ttftMs, 300)
  assert.equal(second.request.index, 2)
})

test('tool records pair call and result and carry the approval outcome', () => {
  const model = buildTrajectory(completedTurn())
  const tool = model.records.find(r => r.kind === 'tool')
  assert.ok(tool && tool.kind === 'tool')
  assert.equal(tool.status, 'ok')
  assert.equal(tool.end, T0 + 1600)
  assert.deepEqual(tool.approval, { approvalId: 'p1', outcome: 'allowed-once' })
})

test('totals sum usage over requests', () => {
  const { totals } = buildTrajectory(completedTurn())
  assert.equal(totals.requests, 2)
  assert.equal(totals.inputTokens, 120)
  assert.equal(totals.outputTokens, 150)
  assert.equal(totals.cacheReadTokens, 900)
  assert.equal(totals.toolCalls, 1)
  assert.equal(totals.errors, 1)
})

test('a window starting mid-turn keeps TTFT unknown and marks the partial start', () => {
  const events = completedTurn().filter(e => e.seq >= 6)
  const model = buildTrajectory(events)
  const [group] = model.groups
  assert.ok(group)
  assert.equal(group.partialStart, true)
  const first = model.records.find(r => r.kind === 'assistant')
  assert.ok(first && first.kind === 'assistant')
  assert.equal(first.request.ttftMs, undefined)
})

test('a live attempt projects a running record with a start marker only', () => {
  const events = completedTurn().slice(0, 4) // turn open, step 1 started
  const model = buildTrajectory(events, {
    attemptId: 'x', turn: 1, step: 1, afterSeq: 3,
    deltas: [
      { type: 'delta', attemptId: 'x', time: T0 + 400, kind: 'reasoning', index: 0, text: 'think' },
      { type: 'delta', attemptId: 'x', time: T0 + 450, kind: 'text', index: 1, text: 'Hel' },
      { type: 'delta', attemptId: 'x', time: T0 + 460, kind: 'text', index: 1, text: 'lo' },
    ],
  })
  const live = model.records.at(-1)
  assert.ok(live && live.kind === 'assistant')
  assert.equal(live.live, true)
  assert.equal(live.status, 'running')
  assert.equal(live.end, null)
  assert.equal(live.request.ttftMs, 390)
  assert.deepEqual(live.content, [{ type: 'reasoning', text: 'think' }, { type: 'text', text: 'Hello' }])
  const bar = timelineBars(model).at(-1)
  assert.ok(bar)
  assert.equal(bar.instant, true)
  assert.equal(bar.end, bar.start)
})

test('an unanswered tool call becomes interrupted when its turn ends', () => {
  const events: SessionEvent[] = [
    ...completedTurn().slice(0, 3),
    { type: 'tool/call', seq: 3, time: T0 + 20, turn: 1, step: 1, callId: 'c9', name: 'bash', arguments: '{}' },
    { type: 'turn/end', seq: 4, time: T0 + 30, turn: 1, reason: { kind: 'aborted' } },
  ]
  const tool = buildTrajectory(events).records.find(r => r.kind === 'tool')
  assert.ok(tool)
  assert.equal(tool.status, 'interrupted')
  assert.equal(tool.end, T0 + 30)
})

test('between-turn compaction forms its own group', () => {
  const events: SessionEvent[] = [
    ...completedTurn(),
    { type: 'compaction/start', seq: 16, time: T0 + 3000, compactionId: 'k1', turn: null },
    { type: 'compaction/summary', seq: 17, time: T0 + 3500, compactionId: 'k1', shadowedTokenCount: 4000 },
    { type: 'compaction/end', seq: 18, time: T0 + 3600, compactionId: 'k1', turn: null },
  ]
  const model = buildTrajectory(events)
  assert.equal(model.groups.length, 2)
  assert.equal(model.groups[1]?.turn, null)
  const compaction = model.records.at(-1)
  assert.ok(compaction && compaction.kind === 'compaction')
  assert.equal(compaction.status, 'ok')
  assert.equal(compaction.shadowedTokenCount, 4000)
})

test('brushing keeps records active in the closed range', () => {
  const model = buildTrajectory(completedTurn())
  const active = recordsActiveIn(model, { start: T0 + 1100, end: T0 + 1200 })
  assert.deepEqual(active.map(r => r.kind), ['tool'])
})
