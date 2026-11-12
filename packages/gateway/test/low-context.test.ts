import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isMessage, lowContextRange, parseLowContext, settingsReader, taskOver, type SurfaceEvent, type SurfaceView } from '../src/low-context.ts'

const HOUR = 60 * 60_000
const NOW = Date.parse('2026-11-13T12:00:00Z')

/** A surface: the system prompt, then each turn as a message, the harness's notes, a reply with a tool call, its result, a reply. */
function session(turns: readonly { at: number; summary?: boolean }[]): SurfaceView & { id: string; seqOf: (turn: number) => number } {
  const events: SurfaceEvent[] = [{ type: 'system/message', time: NOW - 100 * HOUR }]
  const starts: number[] = []
  for (const turn of turns) {
    starts.push(events.length)
    if (turn.summary === true) { events.push({ type: 'user/message', time: turn.at, data: { source: { kind: 'compact-checkpoint' } }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }); continue }
    events.push({ type: 'user/message', time: turn.at, data: { source: { kind: 'user' } }, surfaceOp: 'append' })
    events.push({ type: 'user/message', time: turn.at, data: { source: { kind: 'runtime-context', form: 'instructions' } }, surfaceOp: 'append' })
    events.push({ type: 'user/message', time: turn.at, data: { source: { kind: 'time-context', form: 'snapshot' } }, surfaceOp: 'append' })
    events.push({ type: 'assistant/message', time: turn.at + 1, surfaceOp: 'append' })
    events.push({ type: 'tool/result', time: turn.at + 2, surfaceOp: 'append' })
    events.push({ type: 'assistant/message', time: turn.at + 3, surfaceOp: 'append' })
  }
  // Seqs are not positions: the surface skips some (stream chunks, markers).
  const seqs = events.map((_, i) => i * 3 + 10)
  return {
    id: 's1',
    surface: { nodes: seqs },
    eventAt: seq => events[seqs.indexOf(seq)],
    seqOf: turn => seqs[starts[turn]!]!,
  }
}

test("a message is what someone said: not a summary, not the harness's notes on a turn", () => {
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'user' } }, surfaceOp: 'append' }), true)
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'user-rpc' } }, surfaceOp: 'append' }), true, 'from Feishu or QQ')
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'notice', form: 'notice' } }, surfaceOp: 'append' }), true, "the app's and other agents' messages count")
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'adg-time', form: 'snapshot' } }, surfaceOp: 'append' }), false)
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'runtime-context', form: 'instructions' } }, surfaceOp: 'append' }), false)
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'skill-catalog', form: 'catalog' } }, surfaceOp: 'append' }), false)
  assert.equal(isMessage({ type: 'user/message', time: 0, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } }), false)
  assert.equal(isMessage({ type: 'assistant/message', time: 0, surfaceOp: 'append' }), false)
})

test('the last 12 hours stay, however many messages; what is older goes, whole turns', () => {
  const busy = session(Array.from({ length: 40 }, (_, i) => ({ at: NOW - 11 * HOUR + i * 60_000 })))
  assert.equal(lowContextRange(busy, { now: NOW }), null, '40 messages, all within 12 hours: no sliding window')
  const s = session([{ at: NOW - 20 * HOUR }, { at: NOW - 13 * HOUR }, { at: NOW - 6 * HOUR }, { at: NOW - HOUR }])
  assert.deepEqual(lowContextRange(s, { now: NOW }), { start: s.surface.nodes[1], end: s.seqOf(2) - 3 }, 'up to just before the first message of the window')
})

test('a summary alone is not compacted again; with more that aged, it goes in with them', () => {
  assert.equal(lowContextRange(session([{ at: NOW - 20 * HOUR, summary: true }, { at: NOW - HOUR }]), { now: NOW }), null)
  const s = session([{ at: NOW - 20 * HOUR, summary: true }, { at: NOW - 13 * HOUR }, { at: NOW - HOUR }])
  assert.deepEqual(lowContextRange(s, { now: NOW }), { start: s.surface.nodes[1], end: s.seqOf(2) - 3 })
})

test('when every message is old the latest stays; one message or none is left alone', () => {
  const old = session([{ at: NOW - 50 * HOUR }, { at: NOW - 30 * HOUR }])
  assert.deepEqual(lowContextRange(old, { now: NOW }), { start: old.surface.nodes[1], end: old.seqOf(1) - 3 })
  assert.equal(lowContextRange(session([{ at: NOW - 50 * HOUR }]), { now: NOW }), null)
  assert.equal(lowContextRange(session([]), { now: NOW }), null)
})

test('it compacts only once the task is over: nothing queued, no sub-agent working, no hand-off waiting', () => {
  const agent = { session: session([]), inbox: { nextTurn: [], nextStep: [] } }
  assert.equal(taskOver(agent, { workPending: () => false }), true)
  assert.equal(taskOver(agent, undefined), true, 'no gateway to ask: the turn is all there is')
  assert.equal(taskOver({ ...agent, inbox: { nextTurn: ['又来一条'], nextStep: [] } }, undefined), false)
  assert.equal(taskOver(agent, { workPending: id => id === 's1' }), false)
})

test('the switch comes from compaction.json, off when it is missing or broken, and is read again when it changes', () => {
  assert.equal(parseLowContext(undefined), false)
  assert.equal(parseLowContext({ lowContext: true }), true)
  assert.equal(parseLowContext({ lowContext: 'yes' }), false)
  const file = join(mkdtempSync(join(tmpdir(), 'adg-low-context-')), 'compaction.json')
  const enabled = settingsReader(file)
  assert.equal(enabled(), false, 'no file yet')
  writeFileSync(file, JSON.stringify({ auto: true, threshold: 80, lowContext: true }))
  assert.equal(enabled(), true)
  writeFileSync(file, 'not json at all, and longer')
  assert.equal(enabled(), false)
})
