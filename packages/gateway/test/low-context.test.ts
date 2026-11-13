import { strict as assert } from 'node:assert'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ARCHIVE_MARK } from '@adg/protocol'
import { archiveRange, archiver, coverOf, isMessage, isPointer, keepSummaries, lowContextRange, parseArchiveDays, parseLowContext, pointerText, settingsReader, summariesReader, taskOver, type StoppingAgent, type SurfaceEvent, type SurfaceView } from '../src/low-context.ts'

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
  assert.equal(parseArchiveDays({ archiveDays: 7 }), 7)
  assert.equal(parseArchiveDays({ archiveDays: 0 }), null, 'out of range: off')
  assert.equal(parseArchiveDays({ archiveDays: '7' }), null)
  assert.equal(parseArchiveDays({}), null, 'older files have none: off')
  const file = join(mkdtempSync(join(tmpdir(), 'adg-low-context-')), 'compaction.json')
  const read = settingsReader(file)
  assert.deepEqual(read(), { lowContext: false, archiveDays: null }, 'no file yet')
  writeFileSync(file, JSON.stringify({ auto: true, threshold: 80, lowContext: true }))
  assert.deepEqual(read(), { lowContext: true, archiveDays: null })
  writeFileSync(file, JSON.stringify({ auto: true, threshold: 80, lowContext: true, archiveDays: 14 }))
  assert.deepEqual(read(), { lowContext: true, archiveDays: 14 })
  writeFileSync(file, 'not json at all, and longer than before')
  assert.deepEqual(read(), { lowContext: false, archiveDays: null })
})

const DAY = 24 * HOUR

/**
 * A log for archiving: every record by its seq (shadowed ones too, as dsh keeps
 * them), and a surface of the seqs still in view.
 */
function log() {
  const events = new Map<number, SurfaceEvent>()
  let next = 1
  const add = (event: SurfaceEvent) => { const seq = next++; events.set(seq, event); return seq }
  const say = (at: number) => [add({ type: 'user/message', time: at, data: { source: { kind: 'user' } }, surfaceOp: 'append' }), add({ type: 'assistant/message', time: at + 1, surfaceOp: 'append' })]
  const summary = (written: number, replaced: readonly number[], text = '要点：装好了 MAA') => {
    const start = add({ type: 'compaction/start', time: written })
    const record = add({ type: 'compaction/summary', time: written })
    return add({ type: 'user/message', time: written, data: { content: [{ type: 'text', text: '这是检查点。\n\n<compacted-summary>' }, { type: 'text', text }, { type: 'text', text: '</compacted-summary>' }] }, surfaceOp: { op: 'replace' }, sourceEventSeqs: [start, record, ...replaced] })
  }
  const system = add({ type: 'system/message', time: NOW - 100 * DAY })
  return { events, add, say, summary, system, view: (nodes: number[]): SurfaceView & { id: string } => ({ id: 's1', surface: { nodes }, eventAt: seq => events.get(seq) }) }
}

test('with archiving, the summaries at the start stay and only what follows is compacted, a day or so at a time', () => {
  const l = log()
  const old = l.say(NOW - 3 * DAY)
  const s1 = l.summary(NOW - 3 * DAY + HOUR, old)
  const day2 = l.say(NOW - 30 * HOUR)
  const day3 = l.say(NOW - 20 * HOUR)
  const today = l.say(NOW - HOUR)
  const session = l.view([l.system, s1, ...day2, ...day3, ...today])
  assert.deepEqual(lowContextRange(session, { now: NOW }), { start: s1, end: day3[1] }, 'without archiving: the summary goes in again')
  assert.deepEqual(lowContextRange(session, { now: NOW, separate: true, batchMs: 12 * HOUR }), { start: day2[0], end: day3[1] }, 'with it: from after the summary')
  const young = l.view([l.system, s1, ...day3, ...today])
  assert.equal(lowContextRange(young, { now: NOW, separate: true, batchMs: 12 * HOUR }), null, 'its oldest message is not a day old yet: it waits')
})

test("a summary's span is the messages it replaced, through a summary inside it; its compaction's own records do not count", () => {
  const l = log()
  const first = l.say(NOW - 10 * DAY)
  const s1 = l.summary(NOW - 9 * DAY, first)
  const second = l.say(NOW - 8 * DAY)
  const s2 = l.summary(NOW - 2 * DAY, [s1, ...second])
  assert.deepEqual(coverOf(l.view([]), l.events.get(s2)!), { from: NOW - 10 * DAY, to: NOW - 8 * DAY + 1, firstSeq: first[0], lastSeq: second[1] })
})

test('old summaries at the start are archived together; a recent one, and what follows it, stay', () => {
  const l = log()
  const a = l.say(NOW - 20 * DAY)
  const sa = l.summary(NOW - 19 * DAY, a, '要点 A')
  const b = l.say(NOW - 10 * DAY)
  const sb = l.summary(NOW - 9 * DAY, b, '要点 B')
  const c = l.say(NOW - 2 * DAY)
  const sc = l.summary(NOW - DAY, c, '要点 C')
  const today = l.say(NOW - HOUR)
  const session = l.view([l.system, sa, sb, sc, ...today])
  const range = archiveRange(session, { now: NOW, archiveDays: 7 })
  assert.equal(range?.start, sa)
  assert.equal(range?.end, sb)
  assert.deepEqual(range?.cover, { from: NOW - 20 * DAY, to: NOW - 10 * DAY + 1, firstSeq: a[0], lastSeq: b[1] })
  assert.deepEqual(range?.summaries.map(s => [s.seq, s.text]), [[sa, '要点 A'], [sb, '要点 B']], "each one's own words, without dsh's framing")
  assert.equal(archiveRange(session, { now: NOW, archiveDays: 30 }), null, 'none old enough')

  // The pointer they leave is archived again with the next old summary, and alone is nothing to do.
  const text = pointerText(range!.cover)
  assert.ok(text.startsWith(ARCHIVE_MARK))
  assert.match(text, new RegExp(`#${a[0]}–#${b[1]}`))
  assert.match(text, /history_search/)
  const start = l.add({ type: 'compaction/start', time: NOW })
  const pointer = l.add({ type: 'user/message', time: NOW, data: { content: [{ type: 'text', text }] }, surfaceOp: { op: 'replace' }, sourceEventSeqs: [start, sa, sb] })
  assert.equal(isPointer(l.events.get(pointer)!), true)
  assert.equal(isPointer(l.events.get(sc)!), false)
  assert.equal(archiveRange(l.view([l.system, pointer, sc, ...today]), { now: NOW, archiveDays: 7 }), null, 'only the pointer is old')
  const later = archiveRange(l.view([l.system, pointer, sc, ...today]), { now: NOW + 7 * DAY, archiveDays: 7 })
  assert.equal(later?.start, pointer)
  assert.equal(later?.end, sc)
  assert.deepEqual(later?.summaries.map(s => s.text), ['要点 C'], 'the pointer is not kept as a summary')
  assert.equal(later?.cover.firstSeq, a[0], 'the new pointer stands for all of it')
})

test('archiving answers the summary step with the pointer for that session only, and lets go of the engine when done', async () => {
  const calls: string[] = []
  const engine = {
    async summarize(_input: unknown, agent: unknown) { calls.push(`model:${(agent as StoppingAgent).session.id}`); return { summary: [{ type: 'text', text: 'model' }] } },
    async compactRegion(start: number, end: number, agent: unknown) {
      const result = await (this as unknown as { summarize(input: unknown, agent: unknown): Promise<{ summary: { text: string }[] }> }).summarize({}, agent)
      calls.push(`${start}-${end}:${result.summary[0]!.text}`)
      return { shadowedSeqs: [start, end] }
    },
  }
  const original = engine.summarize
  const archive = archiver(engine)!
  const agent = (id: string) => ({ session: { id, surface: { nodes: [] }, eventAt: () => undefined, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }) as StoppingAgent
  await archive.run({ start: 2, end: 5 }, agent('s1'), `${ARCHIVE_MARK}已归档`, new AbortController().signal)
  await engine.compactRegion(7, 9, agent('s2'))
  await engine.compactRegion(3, 4, agent('s1'))
  assert.deepEqual(calls, [`2-5:${ARCHIVE_MARK}已归档`, 'model:s2', '7-9:model', 'model:s1', '3-4:model'], 'only while it is archived, and only that session')
  archive.dispose()
  assert.equal(engine.summarize, original)
  assert.equal(archiver({ async compactRegion() { return { shadowedSeqs: [] } } }), undefined, 'no summarize step: no archiving')
})

test('archived summaries are kept in summaries.jsonl and read back once each, a broken line aside', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-summaries-')), 'summaries.jsonl')
  const read = summariesReader(file)
  assert.deepEqual(await read(), [], 'none yet')
  const cover = { from: 1, to: 2, firstSeq: 3, lastSeq: 4 }
  await keepSummaries(file, 's1', [{ seq: 10, text: '要点 A', cover }, { seq: 11, text: '要点 B', cover }], 99)
  await keepSummaries(file, 's1', [{ seq: 10, text: '要点 A', cover }], 100)
  appendFileSync(file, '{"cut short\n')
  const rows = await read()
  assert.deepEqual(rows.map(r => [r.sessionId, r.seq, r.text]), [['s1', 10, '要点 A'], ['s1', 11, '要点 B']])
  assert.equal(rows[0]!.archivedAt, 100, 'kept twice (a failed compaction tried again): the last copy')
})
