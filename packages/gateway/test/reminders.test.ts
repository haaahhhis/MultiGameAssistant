import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { remindersOf, type ScheduleEntry } from '../src/reminders.ts'

const entry = (over: Partial<ScheduleEntry>): ScheduleEntry => ({ id: 'schedule-1', kind: 'at', prompt: '提醒主人换赤金', scheduledAt: '2026-11-12T01:00:00.000Z', sessionId: 's-main', status: 'active', ...over })

test('the agents\' own reminders: active ones only, soonest first, under the agent whose conversation they are in, with when in words', () => {
  const items = remindersOf([
    entry({ id: 'a', title: '换赤金' }),
    entry({ id: 'b', kind: 'daily', time: '09:00:00', scheduledAt: '2026-11-06T01:00:00.000Z', sessionId: 's-games', title: '' }),
    entry({ id: 'c', kind: 'weekly', time: '21:30:00', weekdays: [1, 3], scheduledAt: '2026-11-09T12:30:00.000Z' }),
    entry({ id: 'd', kind: 'every', everySeconds: 7200, scheduledAt: '2026-11-05T03:00:00.000Z' }),
    entry({ id: 'e', status: 'inactive' }),
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
