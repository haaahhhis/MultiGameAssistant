import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { remindersOf, type ScheduleEntry } from '../src/reminders.ts'

const entry = (over: Partial<ScheduleEntry>): ScheduleEntry => ({ id: 'schedule-1', kind: 'at', prompt: '提醒主人换赤金', scheduledAt: '2026-11-12T01:00:00.000Z', target: { kind: 'session', sessionId: 's-main' }, status: 'active', ...over })

test('the agents\' own reminders: active ones only, soonest first, under the agent whose conversation they are in, with when in words', () => {
  const items = remindersOf([
    entry({ id: 'a', title: '换赤金' }),
    entry({ id: 'b', kind: 'daily', time: '09:00:00', scheduledAt: '2026-11-06T01:00:00.000Z', target: { kind: 'session', sessionId: 's-games' }, title: '' }),
    entry({ id: 'c', kind: 'weekly', time: '21:30:00', weekdays: [1, 3], scheduledAt: '2026-11-09T12:30:00.000Z' }),
    entry({ id: 'd', kind: 'every', everySeconds: 7200, scheduledAt: '2026-11-05T03:00:00.000Z' }),
    entry({ id: 'e', status: 'paused' }),
    entry({ id: 'f', status: 'ended' }),
  ], sessionId => (sessionId === 's-games' ? 'games' : 'main'))
  assert.deepEqual(items.map(r => [r.id, r.agent, r.rule, r.repeats]), [
    ['d', 'main', '每 2 小时', true],
    ['b', 'games', '每天 09:00', true],
    ['c', 'main', '每周一、三 21:30', true],
    ['a', 'main', '一次', false],
  ])
  assert.equal(items.find(r => r.id === 'b')?.title, '提醒主人换赤金', 'no title: the prompt\'s first line')
  assert.equal(items.find(r => r.id === 'a')?.next, Date.parse('2026-11-12T01:00:00.000Z'))
})

test('what schedule_create makes (an RRULE) in words, and the conversation it is delivered to', () => {
  const rrule = (rule: string) => `DTSTART;TZID=Asia/Shanghai:20261013T090000\nRRULE:${rule}`
  const items = remindersOf([
    entry({ id: 'once', kind: 'rrule', rrule: rrule('FREQ=DAILY;COUNT=1'), scheduledAt: '2026-11-05T01:00:00.000Z' }),
    entry({ id: 'daily', kind: 'rrule', rrule: rrule('FREQ=DAILY'), scheduledAt: '2026-11-05T02:00:00.000Z' }),
    entry({ id: 'weekly', kind: 'rrule', rrule: rrule('FREQ=WEEKLY;BYDAY=MO,WE'), scheduledAt: '2026-11-05T03:00:00.000Z' }),
    entry({ id: 'hourly', kind: 'rrule', rrule: rrule('FREQ=HOURLY;INTERVAL=2'), scheduledAt: '2026-11-05T04:00:00.000Z' }),
    entry({ id: 'odd', kind: 'rrule', rrule: rrule('FREQ=MONTHLY;BYMONTHDAY=1'), scheduledAt: '2026-11-05T05:00:00.000Z' }),
    entry({ id: 'made-once', kind: 'rrule', rrule: rrule('FREQ=DAILY'), target: { kind: 'new_once', sessionId: 's-games' }, scheduledAt: '2026-11-05T06:00:00.000Z' }),
    // A new conversation each time: in no agent's conversation.
    entry({ id: 'fresh', kind: 'rrule', rrule: rrule('FREQ=DAILY'), target: { kind: 'new' } }),
  ], sessionId => (sessionId === 's-games' ? 'games' : 'main'))
  assert.deepEqual(items.map(r => [r.id, r.agent, r.sessionId, r.rule, r.repeats]), [
    ['once', 'main', 's-main', '一次', false],
    ['daily', 'main', 's-main', '每天 09:00', true],
    ['weekly', 'main', 's-main', '每周一、三 09:00', true],
    ['hourly', 'main', 's-main', '每 2 小时', true],
    ['odd', 'main', 's-main', 'FREQ=MONTHLY;BYMONTHDAY=1', true],
    ['made-once', 'games', 's-games', '每天 09:00', true],
  ])
})
