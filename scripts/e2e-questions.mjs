#!/usr/bin/env node
/**
 * End-to-end check of the agent's questions (dsh's ask_user_question) against
 * a running host, with a fake model:
 *
 * 1. The model is offered ask_user_question.
 * 2. It asks; the question reaches this client as `question/requested` (with
 *    its choices), and the answer from `question/respond` comes back to the
 *    model as the tool result.
 * 3. A question nobody answers is withdrawn when the turn is stopped, and the
 *    client hears `question/resolved` (cancelled).
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e:questions
 */
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] })
const CLOSE = { id: 'close', header: '收尾', question: '活动看完了，要不要把游戏关掉？', options: [{ label: '关掉游戏 (Recommended)', description: '游戏是这次打开的' }, { label: '先开着' }] }
const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  replies: [
    call('ask_user_question', { questions: [CLOSE] }), { text: '好的，游戏先开着。' },
    call('ask_user_question', { questions: [{ id: 'later', question: '这个问题没人回答' }] }), { text: '不会走到这里。' },
  ],
  fallback: { text: '好的。' },
  scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
})
const gateway = await connectGateway({ name: 'adg-e2e-questions' })
const { call: rpc, waitFor } = gateway
const steps = []
const step = (name, detail = '') => { steps.push(name); console.log(`✔ ${name}${detail === '' ? '' : `: ${detail}`}`) }
const fail = message => { throw new Error(message) }
try {
  if (!gateway.capabilities.includes('questions')) fail('capability questions missing; rebuild and restart pnpm dev:host')
  await saveFakeProvider(rpc, `${llm.url}/v1`)
  const { sessionId } = await rpc('sessions/create', {})
  for (let i = 0; !(await rpc('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false)); i++) {
    if (i > 50) fail('the fake model route never appeared')
    await delay(200)
  }
  const prompt = text => rpc('session/prompt', { sessionId, requestId: `p-${Date.now()}`, text, mode: 'queue' })

  // 1 + 2. asked, answered here, answer back in the model
  const requested = waitFor(m => m.method === 'question/requested' && m.params.sessionId === sessionId, 'the question', 120_000)
  await prompt('帮我去看看有什么活动没做')
  const question = await requested
  const offered = llm.requests.find(r => Array.isArray(r.tools) && r.tools.length > 0)
  const names = (offered?.tools ?? []).map(t => t.function?.name ?? t.name)
  if (!names.includes('ask_user_question')) fail(`ask_user_question is not offered to the model: ${names.join(', ')}`)
  step('the model is offered ask_user_question', `${names.length} tools`)
  const item = question.questions[0]
  if (item?.question !== CLOSE.question || item.options?.length !== 2 || item.header !== '收尾') fail(`unexpected question: ${JSON.stringify(question)}`)
  const resolved = waitFor(m => m.method === 'question/resolved' && m.params.questionId === question.questionId, 'the question to close', 30_000)
  await rpc('question/respond', { questionId: question.questionId, answers: [{ id: 'close', selected: ['先开着'] }] })
  if ((await resolved).outcome !== 'answered') fail('the question did not close as answered')
  const back = async () => {
    for (let i = 0; i < 300; i++) {
      const r = llm.requests.find(q => q.messages?.at(-1)?.role === 'tool' && JSON.stringify(q.messages.at(-1)).includes('先开着'))
      if (r !== undefined) return JSON.stringify(r.messages.at(-1))
      await delay(300)
    }
    return undefined
  }
  const result = await back()
  if (result === undefined) fail('the answer never reached the model')
  step('the question reached the UI with its choices; the answer came back as the tool result', result.slice(0, 120))

  // 3. withdrawn when the turn stops
  const second = waitFor(m => m.method === 'question/requested' && m.params.sessionId === sessionId, 'the second question', 120_000)
  await prompt('再问一个')
  const unanswered = await second
  const cancelled = waitFor(m => m.method === 'question/resolved' && m.params.questionId === unanswered.questionId, 'the question to be withdrawn', 60_000)
  await rpc('session/cancel', { sessionId }).catch(error => fail(`could not stop the turn: ${error.message}`))
  const outcome = (await cancelled).outcome
  if (outcome !== 'cancelled') fail(`expected cancelled, got ${outcome}`)
  step('a question nobody answered was withdrawn when the turn stopped', outcome)

  console.log(`\nquestions end-to-end OK (${steps.length} steps); the fake model served ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  process.exitCode = 1
} finally {
  await removeFakeProvider(rpc)
  gateway.close()
  await llm.close()
}
process.exit(process.exitCode ?? 0)
