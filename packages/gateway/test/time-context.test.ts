import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { ARCHIVE_MARK } from '@adg/protocol'
import { coverOf, formatGap, LONG_GAP_MS, TIME_SOURCE, timeFacts, timeNote, type TimedEvent } from '../src/time-context.ts'

const ZONE = 'Asia/Shanghai'
const NOW = Date.parse('2026-10-29T08:30:00+08:00')
const MIN = 60_000
const user = (time: number, kind = 'user-rpc'): TimedEvent => ({ type: 'user/message', time, data: { source: { kind } } })
const at = (events: TimedEvent[]) => timeFacts(events.length, seq => events[seq])

test('the facts: the latest message, and a summary only when it is newer than the last reminder', () => {
  const summary = { type: 'compaction/summary', time: NOW - 2870 * MIN }
  assert.deepEqual(at([user(NOW - 3000 * MIN), summary, { type: 'assistant/message', time: NOW - 2860 * MIN }, { type: 'turn/end', time: NOW - 2850 * MIN }]),
    { previous: NOW - 2860 * MIN, summaryAt: NOW - 2870 * MIN })
  assert.deepEqual(at([summary, user(NOW - 2800 * MIN, TIME_SOURCE), user(NOW - 10 * MIN, 'time-context')]), { previous: NOW - 10 * MIN }, 'announced already')
  assert.deepEqual(at([]), {})
})

test('a turn after a long gap is reminded that earlier things may be out of date', () => {
  const note = timeNote({ previous: NOW - 2 * 1440 * MIN - 3 * 60 * MIN }, NOW, 1, ZONE)
  assert.equal(note, '（提醒）距上一条消息过去了 2 天 3 小时（上一条在 2026-10-27 周二 05:30，现在 2026-10-29 周四 08:30）。之前对话里的待办、问题和状态可能已经过时：涉及它们时先用工具查现在的情况，不要直接追问；还需要问时说明是哪天的事。')
})

test('a short gap, or a later step, gets nothing', () => {
  assert.equal(timeNote({ previous: NOW - LONG_GAP_MS + MIN }, NOW, 1, ZONE), undefined)
  assert.equal(timeNote({ previous: NOW - 2 * LONG_GAP_MS }, NOW, 3, ZONE), undefined)
  assert.equal(timeNote({}, NOW, 1, ZONE), undefined)
})

test('a summary since the last reminder is dated', () => {
  const note = timeNote({ previous: NOW - MIN, summaryAt: Date.parse('2026-10-27T21:05:00+08:00') }, NOW, 2, ZONE)
  assert.equal(note, '（提醒）前面的对话摘要生成于 2026-10-27 周二 21:05，只反映那时的情况，里面的待办和下一步以现在的实际状态为准。')
})

test('gaps read in days, hours and minutes', () => {
  assert.equal(formatGap(30_000), '不到 1 分钟')
  assert.equal(formatGap(45 * MIN), '45 分钟')
  assert.equal(formatGap(125 * MIN), '2 小时 5 分钟')
  assert.equal(formatGap(1440 * MIN), '1 天')
})

test('an archive pointer is no summary: the reminder still describes the newest summary, or says nothing', () => {
  const replace = { op: 'replace', startSeq: 0, endSeq: 0 }
  const pointer = (time: number, sources: number[]): TimedEvent => ({ type: 'user/message', time, data: { content: [{ type: 'text', text: `${ARCHIVE_MARK}这个对话……` }] }, surfaceOp: replace, sourceEventSeqs: sources })
  const events: TimedEvent[] = [
    user(NOW - 3000 * MIN),
    { type: 'compaction/summary', time: NOW - 100 * MIN },
    { type: 'user/message', time: NOW - 100 * MIN, data: { content: [{ type: 'text', text: '要点' }] }, surfaceOp: replace, sourceEventSeqs: [0] },
    { type: 'compaction/summary', time: NOW - 99 * MIN },
    pointer(NOW - 99 * MIN, [2]),
  ]
  const facts = at(events)
  assert.equal(facts.summaryAt, NOW - 100 * MIN, "the summary's time, not the pointer's")
  assert.equal(facts.summaryCovers?.firstSeq, 0)
  assert.equal(at([user(NOW - 3000 * MIN), { type: 'compaction/summary', time: NOW - 99 * MIN }, pointer(NOW - 99 * MIN, [0])]).summaryAt, undefined, 'a pointer alone: nothing to remind')
})

test('a summary is labelled with the time and the #numbers of what it replaced, an earlier summary in it included', () => {
  const replace = { op: 'replace', startSeq: 0, endSeq: 0 }
  const events: TimedEvent[] = [
    user(Date.parse('2026-10-27T09:00:00+08:00')),
    { type: 'assistant/message', time: Date.parse('2026-10-27T09:01:00+08:00') },
    { type: 'user/message', time: Date.parse('2026-10-27T12:00:00+08:00'), surfaceOp: replace, sourceEventSeqs: [0, 1] },
    user(Date.parse('2026-10-28T10:00:00+08:00')),
    { type: 'assistant/message', time: Date.parse('2026-10-28T10:02:00+08:00') },
    { type: 'compaction/summary', time: Date.parse('2026-10-28T20:00:00+08:00') },
    { type: 'user/message', time: Date.parse('2026-10-28T20:00:00+08:00'), surfaceOp: replace, sourceEventSeqs: [2, 3, 4] },
  ]
  const facts = at(events)
  assert.deepEqual(facts.summaryCovers, { from: events[0]!.time, to: events[4]!.time, firstSeq: 0, lastSeq: 4 })
  assert.deepEqual(coverOf(events[2]!, seq => events[seq]), { from: events[0]!.time, to: events[1]!.time, firstSeq: 0, lastSeq: 1 })
  assert.equal(timeNote(facts, NOW, 2, ZONE), '（提醒）前面的对话摘要生成于 2026-10-28 周三 20:00，概括的是 2026-10-27 周二 09:00 到 2026-10-28 周三 10:02 的对话（原文是 #0–#4，要细节用 history_read 查），只反映那时的情况，里面的待办和下一步以现在的实际状态为准。')
})
