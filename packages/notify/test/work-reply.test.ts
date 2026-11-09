import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { workReply } from '../src/conversations.ts'
import { finalText } from '../src/reply.ts'

/** dsh's session records, as `follow` gives them. */
const event = (type: string, data: Record<string, unknown>) => ({ type: 'event', event: { type, seq: 1, time: 0, data: { turn: 1, step: 1, ...data } } })
const user = (text: string, requestId?: string) => event('user/message', { id: `u-${text}`, content: [{ type: 'text', text }], source: requestId === undefined ? { kind: 'subagent-settled' } : { kind: 'user', rpcId: requestId } })
const says = (text: string) => event('assistant/message', { message: { id: `a-${text}`, content: [{ type: 'text', text }] } })
const uses = (name: string) => event('tool/call', { callId: `c-${name}`, name, arguments: '{}' })
const ends = (kind = 'completed') => event('turn/end', { reason: { kind } })

/** Frames in order; a function runs when reached (the agent going idle); then the follow stays open. */
function follow(script: readonly (Record<string, unknown> | (() => void))[]) {
  let at = 0
  return {
    async next() {
      for (;;) {
        const item = script[at++]
        if (item === undefined) return new Promise<never>(() => {})
        if (typeof item === 'function') { item(); continue }
        return { done: false, value: item }
      }
    },
  } as never
}

const R = 'req-1'
/** A `settled` that resolves when the script reaches `done`. */
function idle() {
  let done = () => {}
  return { settled: () => new Promise<void>(resolve => { done = resolve }), done: () => done() }
}

test('a turn that opened no sub-agent ends the work: nothing waits, whatever is queued behind it', async () => {
  let asked = 0
  const reply = await workReply(follow([
    user('查一下', R), says('查完了'), ends(),
    user('别人排队的', 'req-2'), says('别人的回答'), ends(),
  ]), R, '查一下', { started: false }, async () => { asked++ })
  assert.equal(finalText(reply), '查完了')
  assert.equal(asked, 0)
})

test('a turn that opened a sub-agent is not the end: the conclusion is what comes after it is back', async () => {
  const agent = idle()
  const reply = await workReply(follow([
    user('看看 MAA', R), uses('subagent'), says('我开了一个子任务，等它回来'), ends(),
    user('子任务结果：第 212 行'), says('结论：配置格式变了'), ends(),
    () => agent.done(),
  ]), R, '看看 MAA', { started: false }, agent.settled)
  assert.equal(finalText(reply), '结论：配置格式变了')
})

test('someone else taking a turn in between is not part of the work', async () => {
  const agent = idle()
  const reply = await workReply(follow([
    user('看看 MAA', R), uses('subagent'), says('等它回来'), ends(),
    user('用户插了一句', 'req-2'), says('回答用户的话'), ends(),
    user('子任务结果'), says('结论：好了'), ends(),
    () => agent.done(),
  ]), R, '看看 MAA', { started: false }, agent.settled)
  assert.equal(finalText(reply), '结论：好了')
  assert.ok(!JSON.stringify(reply).includes('回答用户的话'))
})

test('a turn cut short does not wait for the sub-agents it opened', async () => {
  let asked = 0
  const reply = await workReply(follow([user('看看', R), uses('subagent'), ends('aborted')]), R, '看看', { started: false }, async () => { asked++ })
  assert.equal(asked, 0)
  assert.match(finalText(reply), /没有完成/)
})

test('with no way to know when it is done (a client without the gateway), the turn is all there is', async () => {
  const reply = await workReply(follow([user('看看', R), uses('subagent'), says('等它回来'), ends()]), R, '看看', { started: false }, undefined)
  assert.equal(finalText(reply), '等它回来')
})
