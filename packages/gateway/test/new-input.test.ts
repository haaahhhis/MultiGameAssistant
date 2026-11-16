import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { NEW_INPUT, NewInput } from '../src/new-input.ts'

/** A context with just the inbox event, and an agent whose next-step inbox the test fills. */
function setup() {
  let listener: ((payload: { agent: object }) => void) | undefined
  const ctx = { on: (_name: string, fn: typeof listener) => { listener = fn; return () => {} } } as unknown as Context
  const newInput = new NewInput(ctx)
  const agent = { inbox: { nextStep: [] as { id: string }[] } }
  const send = (id: string, to: object = agent) => {
    if (to === agent) agent.inbox.nextStep.push({ id })
    listener?.({ agent: to })
  }
  return { newInput, agent, send }
}

test('a wait gives way to input that reaches its agent', () => {
  const { newInput, agent, send } = setup()
  const watch = newInput.watch({ agent, rootCallId: 'call-1' })
  send('m0', {})
  assert.equal(watch.signal.aborted, false, 'another agent\'s input does not count')
  send('m1')
  assert.equal(watch.signal.aborted, true)
  assert.equal(watch.signal.reason, NEW_INPUT)
})

test('input already waiting ends a new wait at once, but not twice inside one run_code program', () => {
  const { newInput, agent, send } = setup()
  send('m1')
  const first = newInput.watch({ agent, rootCallId: 'program' })
  assert.equal(first.signal.aborted, true)
  const again = newInput.watch({ agent, rootCallId: 'program' })
  assert.equal(again.signal.aborted, false, 'the program was told already; that input reaches the model when it ends')
  send('m2')
  assert.equal(again.signal.aborted, true, 'newer input still ends it')
  assert.equal(newInput.watch({ agent, rootCallId: 'next-step' }).signal.aborted, true, 'a later model call is told again')
})

test('a disposed watch, or a call without an agent, never aborts', () => {
  const { newInput, agent, send } = setup()
  const watch = newInput.watch({ agent, rootCallId: 'call-1' })
  watch.dispose()
  send('m1')
  assert.equal(watch.signal.aborted, false)
  assert.equal(newInput.watch({ rootCallId: 'call-2' }).signal.aborted, false)
})
