import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { resumeAfterError, TakenInput, toQueue, type InboxMessage, type ResumableAgent } from '../src/queue.ts'

const said = (id: string, text: string, kind = 'user', rpcId?: string): InboxMessage => ({
  id, role: 'user', content: [{ type: 'text', text }], source: { kind, ...(rpcId === undefined ? {} : { rpcId }) },
} as InboxMessage)

/** A dsh agent as resumeAfterError sees it: next-step only, and what it was told. */
function fakeAgent(nextStep: InboxMessage[], status = 'idle') {
  const told: [string, string][] = []
  const agent: ResumableAgent = {
    status,
    session: { id: 's1' },
    inbox: {
      get nextStep() { return nextStep },
      remove(messageId) {
        const at = nextStep.findIndex(m => m.id === messageId)
        if (at < 0) return false
        nextStep.splice(at, 1)
        return true
      },
    },
    followup: message => { told.push(['followup', message.id as string]) },
    steer: message => { nextStep.push(message); told.push(['steer', message.id as string]) },
  }
  return { agent, told, nextStep }
}

test('queue: the person\'s waiting messages in run order, then the taken ones; other inbox entries are left out', () => {
  const inbox = {
    'next-turn': [said('b', 'later', 'user', 'r-b')],
    'next-step': [said('a', 'now'), said('n', 'sub-agent report', 'subagent')],
  }
  const taken = [{ id: 't', text: 'first', placement: 'taken' as const }]
  assert.deepEqual(toQueue(inbox, taken).map(i => [i.id, i.placement, i.requestId]), [
    ['t', 'taken', undefined], ['a', 'next-step', undefined], ['b', 'next-turn', 'r-b'],
  ])
  assert.deepEqual(toQueue(undefined), [])
})

test('taken input: listed from the claim until the message is logged', () => {
  const changed: string[] = []
  const taken = new TakenInput(id => changed.push(id))
  taken.take('s1', said('m1', 'hello', 'user', 'r1'))
  taken.take('s1', said('x', 'reminder', 'reminder'))
  assert.deepEqual(taken.items('s1'), [{ id: 'm1', requestId: 'r1', text: 'hello', placement: 'taken' }])
  assert.deepEqual(changed, ['s1'])
  taken.logged('s1', 'other')
  assert.equal(changed.length, 1)
  taken.logged('s1', 'm1')
  assert.deepEqual(taken.items('s1'), [])
  assert.deepEqual(changed, ['s1', 's1'])
})

test('after a failed turn, a message left for the next step wakes the agent', () => {
  const { agent, told, nextStep } = fakeAgent([said('a', 'one'), said('n', 'report', 'subagent'), said('b', 'two')])
  assert.equal(resumeAfterError(agent, new TakenInput(() => {})), 2)
  // The last one is sent again with a wake-up; the turn that opens takes the rest along.
  assert.deepEqual(told, [['steer', 'b']])
  assert.deepEqual(nextStep.map(m => m.id), ['a', 'n', 'b'])
})

test('after a failed turn, a taken message never logged goes to a new turn, once', () => {
  const taken = new TakenInput(() => {})
  const { agent, told } = fakeAgent([])
  taken.take('s1', said('m1', 'hello'))
  assert.equal(resumeAfterError(agent, taken), 1)
  assert.deepEqual(told, [['followup', 'm1']])
  assert.deepEqual(taken.items('s1'), [])
  // Lost again: not handed back a second time (a step that keeps failing does not loop).
  taken.take('s1', said('m1', 'hello'))
  assert.equal(resumeAfterError(agent, taken), 0)
  assert.equal(told.length, 1)
})

test('nothing is handed on while the agent is running or with nothing of the person\'s waiting', () => {
  const running = fakeAgent([said('a', 'one')], 'running')
  assert.equal(resumeAfterError(running.agent, new TakenInput(() => {})), 0)
  const idle = fakeAgent([said('n', 'report', 'subagent')])
  assert.equal(resumeAfterError(idle.agent, new TakenInput(() => {})), 0)
  assert.deepEqual([...running.told, ...idle.told], [])
})
