#!/usr/bin/env node
/**
 * End-to-end check of messages sent while the agent is busy, against a
 * running host with a fake model:
 *
 * 1. 插入当前轮次 (`steer`): sent while a slow command runs, the model sees
 *    it in the same turn, right after that command's result.
 * 2. 排队 (`queue`): sent while the turn runs, it starts a turn of its own
 *    once the current one ends.
 * 3. The queue is visible to clients (on open, and as it changes): a waiting
 *    message can be taken back (撤回) before it runs, or moved into the
 *    running turn (现在插入).
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e:steer
 */
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'
const SLEEP = process.platform === 'win32' ? 'Start-Sleep -Seconds 12; echo slept' : 'sleep 12; echo slept'
const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] })
const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  replies: [call(SHELL, { description: 'Wait a while', command: SLEEP }), { text: '第一轮做完了。' }, { text: '排队的那条也处理了。' }],
  fallback: { text: '好的。' },
  scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
})
const gateway = await connectGateway({ name: 'adg-e2e-steer' })
const { call: rpc, waitFor } = gateway
const steps = []
const step = (name, detail = '') => { steps.push(name); console.log(`✔ ${name}${detail === '' ? '' : `: ${detail}`}`) }
const fail = message => { throw new Error(message) }
const said = (r, text) => JSON.stringify(r.messages ?? []).includes(text)
const until = async (what, check, ms = 60_000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) fail(`timed out waiting for ${what}`)
    await delay(200)
  }
}
try {
  await saveFakeProvider(rpc, `${llm.url}/v1`)
  const { sessionId } = await rpc('sessions/create', {})
  await until('the fake model route', () => rpc('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false))
  const prompt = (text, mode) => rpc('session/prompt', { sessionId, requestId: `p-${Date.now()}-${mode}`, text, mode })

  await prompt('先等一会儿', 'queue')
  // The command is running: the model has asked for it and has not seen its result yet.
  await until('the slow command to start', () => llm.requests.some(r => said(r, '先等一会儿')) && llm.requests.length >= 1)
  await delay(2500)
  const before = llm.requests.length
  await prompt('插入：顺便看看日志', 'steer')
  await prompt('排队：然后发日报', 'queue')

  // The queue is visible (and survives reopening): what is waiting, and where.
  const queueNow = async () => (await rpc('session/open', { sessionId })).queue ?? []
  const waiting = await until('both messages in the queue', async () => {
    const q = await queueNow()
    return q.length >= 2 ? q : undefined
  }, 10_000)
  const where = Object.fromEntries(waiting.map(q => [q.text, q.placement]))
  if (where['插入：顺便看看日志'] !== 'next-step' || where['排队：然后发日报'] !== 'next-turn') fail(`unexpected queue: ${JSON.stringify(waiting)}`)
  step('the queue lists both: the inserted one for this turn, the queued one for the next', JSON.stringify(where))

  // Taken back before it ran: the model never sees it.
  const notified = waitFor(m => m.method === 'session/queue' && m.params.sessionId === sessionId && m.params.items.some(i => i.text === '撤回：这条不要了'), 'the queue to list the extra message', 10_000)
  await prompt('撤回：这条不要了', 'queue')
  const extra = (await notified).items.find(i => i.text === '撤回：这条不要了')
  const removed = waitFor(m => m.method === 'session/queue' && m.params.sessionId === sessionId && !m.params.items.some(i => i.text === '撤回：这条不要了'), 'the queue to drop it', 10_000)
  await rpc('session/queue/update', { sessionId, itemId: extra.id, action: 'remove' })
  await removed
  step('撤回: a waiting message was taken back; clients were told')

  const steered = await until('the steered message to reach the model', () => llm.requests.find(r => said(r, '插入：顺便看看日志')), 90_000)
  const index = llm.requests.indexOf(steered)
  if (said(steered, '排队：然后发日报')) fail('the queued message went in with the steered one')
  if (!said(steered, 'slept')) fail('the steered message reached the model before the running command finished: it should come after its result')
  if (index < before) fail('the steered message was seen before it was sent')
  step('插入当前轮次: the model saw it in the same turn, after the running command', `request #${index + 1}`)

  const queued = await until('the queued message to start its own turn', () => llm.requests.find(r => said(r, '排队：然后发日报')), 90_000)
  if (llm.requests.indexOf(queued) <= index) fail('the queued message did not wait for the turn to end')
  if (!said(queued, '第一轮做完了')) fail('the queued turn started before the first one ended')
  step('排队: it waited for the turn to end, then started its own')
  if (llm.requests.some(r => said(r, '撤回：这条不要了'))) fail('the withdrawn message still reached the model')

  // 现在插入: a queued message moved into the running turn.
  llm.push(call(SHELL, { description: 'Wait a while', command: SLEEP }), { text: '第三轮做完了。' })
  await prompt('再等一会儿', 'queue')
  await until('the second slow command to start', () => llm.requests.some(r => said(r, '再等一会儿')))
  await delay(2000)
  const listed = waitFor(m => m.method === 'session/queue' && m.params.sessionId === sessionId && m.params.items.some(i => i.text === '现在插入：这条提前'), 'the queue to list it', 10_000)
  await prompt('现在插入：这条提前', 'queue')
  const moving = (await listed).items.find(i => i.text === '现在插入：这条提前')
  await rpc('session/queue/update', { sessionId, itemId: moving.id, action: 'steer' })
  const early = await until('the moved message to reach the model', () => llm.requests.find(r => said(r, '现在插入：这条提前')), 90_000)
  if (said(early, '第三轮做完了')) fail('the moved message waited for the turn to end')
  if (!said(early, 'slept')) fail('the moved message did not go in after the running command')
  step('现在插入: a queued message went into the running turn')

  console.log(`\nsteer / queue end-to-end OK (${steps.length} steps); the fake model served ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  for (const [i, r] of llm.requests.entries()) console.error(`  request ${i + 1}: last ${JSON.stringify(r.messages?.at(-1) ?? {}).slice(0, 160)}`)
  process.exitCode = 1
} finally {
  await removeFakeProvider(rpc)
  gateway.close()
  await llm.close()
}
process.exit(process.exitCode ?? 0)
