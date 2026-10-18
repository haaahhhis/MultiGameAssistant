import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { SessionEvent } from '@adg/protocol'
import { buildChat } from '../src/chat.ts'
import { SessionHandle, type SessionTransport } from '../src/session.ts'

const human = { kind: 'user-rpc', human: true }
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

function fakeTransport(openEvents: SessionEvent[] = []) {
  const calls: { method: string; params: any }[] = []
  let readyHandler: ((g: number) => void) | null = null
  const transport: SessionTransport = {
    ready: true,
    onReady(handler) {
      readyHandler = handler
      return () => { readyHandler = null }
    },
    async call(method: string, params: any): Promise<any> {
      calls.push({ method, params })
      switch (method) {
        case 'session/open':
          return {
            subscriptionId: `sub-${calls.length}`, header: { id: params.sessionId, createdAt: 0 },
            cursor: openEvents.at(-1)?.seq ?? -1, events: openEvents, hasMore: true, title: 'T', live: null,
          }
        case 'session/history':
          return { events: [{ type: 'turn/start', seq: 0, time: 0, turn: 1 }], hasMore: false }
        default:
          return { accepted: true }
      }
    },
  } as SessionTransport
  return { transport, calls, connect: (g: number) => readyHandler?.(g) }
}

function handleWith(events: SessionEvent[] = []) {
  const fake = fakeTransport(events)
  const bound: (string | null)[] = []
  const handle = new SessionHandle('s1', fake.transport, { bindSubscription: (_h, id) => bound.push(id) })
  return { ...fake, handle, bound }
}

test('opens on ready and re-opens on each new generation', async () => {
  const { handle, calls, connect, bound } = handleWith([{ type: 'turn/start', seq: 1, time: 1, turn: 1 }])
  connect(1)
  await tick()
  assert.equal(handle.state.get().status, 'open')
  assert.equal(handle.state.get().running, true)
  assert.equal(handle.state.get().title, 'T')
  connect(2)
  await tick()
  assert.deepEqual(calls.map(c => c.method), ['session/open', 'session/open'])
  assert.deepEqual(bound, ['sub-1', 'sub-2'])
})

test('a prompt echo stays until its user/message arrives', async () => {
  const { handle, calls, connect } = handleWith()
  connect(1)
  await tick()
  await handle.prompt('hello')
  const requestId = calls.at(-1)?.params.requestId
  assert.equal(handle.state.get().pending.length, 1)
  handle.receiveEvent({ type: 'user/message', seq: 5, time: 5, messageId: 'm', content: [{ type: 'text', text: 'hello' }], origin: human, requestId })
  assert.equal(handle.state.get().pending.length, 0)
})

test('live deltas accumulate and clear when the durable message lands', async () => {
  const { handle, connect } = handleWith()
  connect(1)
  await tick()
  handle.receiveLive({ type: 'start', attemptId: 'a', turn: 1, step: 1, afterSeq: 3 })
  handle.receiveLive({ type: 'delta', attemptId: 'a', time: 10, kind: 'text', index: 0, text: 'Hel' })
  handle.receiveLive({ type: 'delta', attemptId: 'a', time: 11, kind: 'text', index: 0, text: 'lo' })
  const before = handle.state.get()
  assert.equal(before.live?.deltas.length, 2)
  assert.equal(before.running, true)
  const chat = buildChat(before.events, before.live)
  assert.deepEqual(chat.map(i => i.kind === 'assistant' ? [i.text, i.live] : null), [['Hello', true]])
  handle.receiveEvent({
    type: 'assistant/message', seq: 4, time: 12, turn: 1, step: 1, messageId: 'x',
    content: [{ type: 'text', text: 'Hello' }], timing: { tokenChunks: 2 },
  })
  assert.equal(handle.state.get().live, null)
})

test('duplicate or older events are ignored', async () => {
  const { handle, connect } = handleWith([{ type: 'turn/start', seq: 7, time: 1, turn: 1 }])
  connect(1)
  await tick()
  handle.receiveEvent({ type: 'turn/start', seq: 7, time: 1, turn: 1 })
  handle.receiveEvent({ type: 'step/start', seq: 6, time: 1, turn: 1, step: 1 })
  assert.equal(handle.state.get().events.length, 1)
})

test('loadOlder prepends a page anchored at the opening cursor', async () => {
  const { handle, calls, connect } = handleWith([{ type: 'step/start', seq: 3, time: 1, turn: 1, step: 1 }])
  connect(1)
  await tick()
  await handle.loadOlder()
  assert.deepEqual(calls.at(-1)?.params, { sessionId: 's1', throughSeq: 3, beforeSeq: 3 })
  assert.deepEqual(handle.state.get().events.map(e => e.seq), [0, 3])
  assert.equal(handle.state.get().hasMore, false)
})

test('chat: tool rows pair results and approvals; turn errors become notices', () => {
  const events: SessionEvent[] = [
    { type: 'turn/start', seq: 0, time: 0, turn: 1 },
    { type: 'user/message', seq: 1, time: 1, messageId: 'm', content: [{ type: 'text', text: 'ls' }], origin: human },
    { type: 'user/message', seq: 2, time: 2, messageId: 'c', content: [{ type: 'text', text: 'agents.md' }], origin: { kind: 'agent-instructions', human: false } },
    { type: 'tool/call', seq: 3, time: 3, turn: 1, step: 1, callId: 'c1', name: 'bash', arguments: '{"command":"ls"}' },
    { type: 'approval/asked', seq: 4, time: 4, approvalId: 'p', toolName: 'bash', callId: 'c1' },
    { type: 'approval/decided', seq: 5, time: 5, approvalId: 'p', outcome: 'allowed-once' },
    { type: 'tool/result', seq: 6, time: 6, turn: 1, step: 1, callId: 'c1', isError: false, content: [{ type: 'text', text: 'a.txt' }] },
    { type: 'turn/end', seq: 7, time: 7, turn: 1, reason: { kind: 'error', message: 'no API key' } },
  ]
  const chat = buildChat(events, null, [{ requestId: 'r', text: 'next', mode: 'queue', sentAt: 9 }])
  assert.deepEqual(chat.map(i => i.kind), ['user', 'tool', 'notice', 'user'])
  const tool = chat[1]
  assert.ok(tool?.kind === 'tool')
  assert.equal(tool.status, 'ok')
  assert.equal(tool.result, 'a.txt')
  assert.equal(tool.approval, 'allowed-once')
  const echo = chat[3]
  assert.ok(echo?.kind === 'user' && echo.pending?.requestId === 'r')
})
