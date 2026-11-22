import assert from 'node:assert/strict'
import { test } from 'node:test'
import { buildChat } from '../src/chat.ts'
import type { SessionEvent } from '@adg/protocol'

test('a queued dispatch is visible before the owner wakes, and its later delivery reuses that card', () => {
  const origin = { kind: 'adg-task-dispatched', human: false, childId: 'child', summary: '查活动' }
  const queued: SessionEvent = { type: 'unknown', seq: 1, time: 1, upstreamType: 'agent/inbox/spliced', data: { inserted: [{ source: origin }] } }
  const received: SessionEvent = { type: 'user/message', seq: 2, time: 2, origin, content: [{ type: 'text', text: '查活动' }] }
  for (const events of [[queued], [queued, received], [received], [received, queued], [received, received], [queued, queued]]) {
    const chat = buildChat(events, null)
    assert.equal(chat.length, 1)
    assert.ok(chat[0]?.kind === 'context' && chat[0].childId === 'child')
  }
})
