import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { isMessage, lowContextRange, parseLowContext, settingsReader, type SurfaceEvent, type SurfaceView } from '../src/low-context.ts'

const HOUR = 60 * 60_000
const NOW = Date.parse('2026-11-13T12:00:00Z')

/** A surface: the system prompt, then each turn as a message, a reply with a tool call, its result, a reply. */
function session(turns: readonly { at: number; summary?: boolean }[]): SurfaceView & { seqOf: (turn: number) => number } {
  const events: SurfaceEvent[] = [{ type: 'system/message', time: NOW - 100 * HOUR }]
  const starts: number[] = []
  for (const turn of turns) {
    starts.push(events.length)
    if (turn.summary === true) { events.push({ type: 'user/message', time: turn.at, data: { source: { kind: 'compaction' } }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }); continue }
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
    surface: { nodes: seqs },
    eventAt: seq => events[seqs.indexOf(seq)],
    seqOf: turn => seqs[starts[turn]!]!,
  }
}

const recent = (n: number) => Array.from({ length: n }, (_, i) => ({ at: NOW - (n - i) * 60_000 }))

test("a message is what someone said: not a summary, not the harness's note on a step", () => {
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'user' } }, surfaceOp: 'append' }), true)
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'notice', form: 'notice' } }, surfaceOp: 'append' }), true, "the app's and other agents' messages count")
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'user-rpc' } }, surfaceOp: 'append' }), true, 'from Feishu or QQ')
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'adg-time', form: 'snapshot' } }, surfaceOp: 'append' }), false)
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'runtime-context', form: 'instructions' } }, surfaceOp: 'append' }), false)
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'skill-catalog', form: 'catalog' } }, surfaceOp: 'append' }), false)
  assert.equal(isMessage({ type: 'user/message', time: 0, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } }), false)
  assert.equal(isMessage({ type: 'assistant/message', time: 0, surfaceOp: 'append' }), false)
})

test('a short conversation is left alone; past the slack it is compacted down to the latest messages, whole turns', () => {
  assert.equal(lowContextRange(session(recent(7)), { keep: 5, now: NOW }), null, '5 + 2 of slack')
  const s = session(recent(8))
  const range = lowContextRange(s, { keep: 5, now: NOW })
  assert.deepEqual(range, { start: s.surface.nodes[1], end: s.seqOf(3) - 3 }, 'from after the system prompt to just before the 5th-latest message')
})

test('after a compaction its summary is not compacted again by itself', () => {
  const s = session([{ at: NOW - 30 * 60_000, summary: true }, ...recent(6)])
  assert.equal(lowContextRange(s, { keep: 5, now: NOW }), null)
  const more = session([{ at: NOW - 30 * 60_000, summary: true }, ...recent(8)])
  assert.deepEqual(lowContextRange(more, { keep: 5, now: NOW }), { start: more.surface.nodes[1], end: more.seqOf(4) - 3 }, 'the summary goes into the next one')
})

test('a message older than a day is compacted however few there are, and the latest one always stays', () => {
  const s = session([{ at: NOW - 30 * HOUR }, { at: NOW - 26 * HOUR }, { at: NOW - HOUR }])
  assert.deepEqual(lowContextRange(s, { keep: 5, now: NOW }), { start: s.surface.nodes[1], end: s.seqOf(2) - 3 })
  const old = session([{ at: NOW - 50 * HOUR }, { at: NOW - 30 * HOUR }])
  assert.deepEqual(lowContextRange(old, { keep: 5, now: NOW }), { start: old.surface.nodes[1], end: old.seqOf(1) - 3 }, 'all old: the latest stays')
  assert.equal(lowContextRange(session([{ at: NOW - 50 * HOUR }]), { keep: 5, now: NOW }), null, 'one message: nothing before it')
  assert.equal(lowContextRange(session([]), { keep: 5, now: NOW }), null)
})

test('the settings come from compaction.json, off when it is missing or broken, and are read again when it changes', () => {
  assert.deepEqual(parseLowContext(undefined), { on: false, keep: 5 })
  assert.deepEqual(parseLowContext({ lowContext: true, keepMessages: 99 }), { on: true, keep: 20 })
  assert.deepEqual(parseLowContext({ lowContext: 'yes', keepMessages: 1.5 }), { on: false, keep: 5 })
  const file = join(mkdtempSync(join(tmpdir(), 'adg-low-context-')), 'compaction.json')
  const read = settingsReader(file)
  assert.equal(read().on, false, 'no file yet')
  writeFileSync(file, JSON.stringify({ auto: true, threshold: 80, lowContext: true, keepMessages: 3 }))
  assert.deepEqual(read(), { on: true, keep: 3 })
  writeFileSync(file, 'not json at all, and longer')
  assert.equal(read().on, false)
})
