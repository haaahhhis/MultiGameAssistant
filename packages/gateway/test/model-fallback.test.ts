import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { MODEL_FALLBACK_SOURCE, type ModelSelection } from '@adg/protocol'
import { convertEvent } from '../src/convert.ts'
import { failureOf, fallbackReason, fallbackText, ModelFallback, nextFallback, type FallbackAgent, type FallbackDeps } from '../src/model-fallback.ts'

const A = { provider: 'deepseek', model: 'deepseek-chat' }
const B = { provider: 'kimi', model: 'kimi-k2' }
const C = { provider: 'qwen', model: 'qwen-max', reasoningEffort: 'high' }
const key = (s: ModelSelection) => `${s.provider}/${s.model}`
const tick = () => new Promise(resolve => setTimeout(resolve, 0))

/** dsh's LlmError, structurally. */
const llmError = (code: string, message: string, status?: number) => Object.assign(new Error(message), { code, failure: { code, message, ...(status === undefined ? {} : { status }) } })

test('only failures another model would not have are fallen back from', () => {
  const reason = (code: string, message = '', status?: number) => fallbackReason({ code, message, ...(status === undefined ? {} : { status }) })
  assert.equal(reason('QUOTA'), '余额或额度不足')
  assert.equal(reason('HTTP_402'), '余额或额度不足')
  assert.equal(reason('PI_AI_ERROR', '400 Insufficient Balance'), '余额或额度不足', "a service's balance wording dsh could not classify")
  assert.equal(reason('HTTP_400', '账户余额不足，请充值'), '余额或额度不足')
  assert.equal(reason('AUTH'), 'Key 无效或没有权限')
  assert.equal(reason('MISSING_CREDENTIAL'), 'Key 无效或没有权限')
  assert.equal(reason('UNKNOWN_MODEL'), '模型不可用')
  assert.equal(reason('RATE_LIMIT'), '请求太频繁，重试后仍被限流')
  assert.equal(reason('HTTP_503'), '模型服务出错，重试后仍然失败')
  for (const code of ['TRANSPORT', 'TIMEOUT', 'CONTEXT_WINDOW_EXCEEDED', 'ABORTED', 'INVALID_REQUEST', 'UNKNOWN']) assert.equal(reason(code, 'something'), undefined, code)
  assert.deepEqual(failureOf(llmError('QUOTA', 'no money', 402)), { code: 'QUOTA', message: 'no money', status: 402 })
  assert.equal(failureOf(new Error('plain')), undefined)
})

test('the next model: after the one that failed, then from the top; none tried, none unusable', () => {
  const all = () => true
  assert.deepEqual(nextFallback(A, [B, C], new Set(), all), B, 'not in the list: from the top')
  assert.deepEqual(nextFallback(B, [A, B, C], new Set([key(B)]), all), C, 'after it')
  assert.deepEqual(nextFallback(C, [A, B, C], new Set([key(C)]), all), A, 'then the ones before it')
  assert.deepEqual(nextFallback(A, [B, C], new Set([key(A), key(B)]), all), C, 'tried ones are skipped')
  assert.deepEqual(nextFallback(A, [B, C], new Set(), s => s !== B), C, 'models that cannot be used now are skipped')
  assert.equal(nextFallback(A, [A], new Set([key(A)]), all), undefined)
  assert.equal(nextFallback(A, [], new Set(), all), undefined)
})

/** A dsh agent, as far as the fallback uses it. */
function fakeAgent(model: ModelSelection, sub = false) {
  const agent = {
    status: 'running' as string,
    session: { id: sub ? 's-sub' : 's-main', header: sub ? { origin: 'subagent' } : {} },
    selected: [] as ModelSelection[],
    queued: [] as { message: any; woke: boolean }[],
    model: {
      current: () => agent.selected.at(-1) ?? model,
      select: (s: ModelSelection) => { agent.selected.push(s) },
    },
    followup(message: unknown) { agent.queued.push({ message, woke: true }) },
    send(message: unknown, _target: 'next-turn', wakeup: boolean) { agent.queued.push({ message, woke: wakeup }) },
  }
  return agent
}

function fallback(lists: { agents?: ModelSelection[]; subAgents?: ModelSelection[] }, extra: Partial<FallbackDeps> = {}) {
  const names: Record<string, { providerName: string; modelName: string }> = {
    [key(A)]: { providerName: 'DeepSeek', modelName: 'DeepSeek V4' },
    [key(B)]: { providerName: 'Kimi', modelName: 'Kimi K2' },
    [key(C)]: { providerName: '通义千问', modelName: 'Qwen Max' },
  }
  return new ModelFallback({ list: sub => (sub ? lists.subAgents : lists.agents) ?? [], route: s => names[key(s)], ...extra })
}

test("a request's balance error switches the agent to the next model and opens a turn with the card", async () => {
  const agent = fakeAgent(A)
  const lost = [{ id: 'm1', role: 'user', source: { kind: 'user' } }]
  const fb = fallback({ agents: [B, C], subAgents: [C] }, { lost: () => lost })
  fb.requested(agent.session.id)
  const notice = fb.failed(agent as FallbackAgent, llmError('QUOTA', 'Insufficient Balance', 402))
  assert.ok(notice)
  assert.deepEqual(agent.selected, [B], 'the model is chosen as the turn fails, before its end is logged')
  assert.deepEqual(notice.from, { ...A, providerName: 'DeepSeek', modelName: 'DeepSeek V4' })
  assert.deepEqual(notice.to, { ...B, providerName: 'Kimi', modelName: 'Kimi K2' })
  assert.equal(notice.reason, '余额或额度不足')
  assert.equal(notice.error, 'Insufficient Balance')
  assert.equal(notice.sub, undefined)
  assert.equal(agent.queued.length, 0)

  agent.status = 'idle'
  assert.equal(fb.idle(agent as FallbackAgent), true)
  assert.equal(agent.queued.length, 0, 'not inside dsh\'s status emit')
  await Promise.resolve()
  assert.deepEqual(agent.queued.map(q => q.woke), [false, true], 'the lost message waits for the card, which wakes the agent: one turn takes both')
  assert.equal(agent.queued[0]!.message, lost[0])
  const card = agent.queued[1]!.message
  assert.equal(card.role, 'user')
  assert.equal(card.source.kind, MODEL_FALLBACK_SOURCE)
  assert.equal(card.source.form, 'notice')
  assert.deepEqual(card.source.fallback, notice)
  const said = card.content[0].text as string
  for (const part of ['DeepSeek', 'DeepSeek V4', 'Kimi', 'Kimi K2', '余额或额度不足', 'Insufficient Balance']) assert.ok(said.includes(part), `the agent reads ${part}`)
  assert.equal(said, fallbackText(notice))

  // The card as the UI gets it.
  const event = convertEvent({ type: 'user/message', seq: 9, time: 1, data: card } as never)
  assert.equal(event.type, 'user/message')
  if (event.type === 'user/message') {
    assert.equal(event.origin.human, false)
    assert.deepEqual(event.origin.fallback, notice)
    assert.ok(event.origin.summary?.includes('Kimi K2'))
  }
})

test('a sub-agent takes the sub-agent list; the thinking level of the listed model goes with it', () => {
  const agent = fakeAgent(A, true)
  const fb = fallback({ agents: [B], subAgents: [C] })
  fb.requested(agent.session.id)
  const notice = fb.failed(agent as FallbackAgent, llmError('AUTH', 'invalid api key'))
  assert.equal(notice?.sub, true)
  assert.deepEqual(agent.selected, [C])
})

test('no switch: an error after the model answered, a failure another model would have, no list, all tried', () => {
  const agent = fakeAgent(A)
  const fb = fallback({ agents: [B] })
  // A tool failing after the model answered is not the model's.
  fb.requested(agent.session.id)
  fb.logged(agent.session.id, { type: 'assistant/message' })
  assert.equal(fb.failed(agent as FallbackAgent, llmError('QUOTA', 'x')), undefined)
  // The network.
  fb.requested(agent.session.id)
  assert.equal(fb.failed(agent as FallbackAgent, llmError('TRANSPORT', 'fetch failed')), undefined)
  // No list.
  const none = fallback({})
  none.requested(agent.session.id)
  assert.equal(none.failed(agent as FallbackAgent, llmError('QUOTA', 'x')), undefined)
  // A fails, B; then B fails too: A was tried, nothing left.
  fb.requested(agent.session.id)
  assert.ok(fb.failed(agent as FallbackAgent, llmError('QUOTA', 'x')))
  fb.requested(agent.session.id)
  assert.equal(fb.failed(agent as FallbackAgent, llmError('QUOTA', 'x')), undefined)
  assert.deepEqual(agent.selected, [B], 'only the one switch')
  // A completed turn (the person put it back on A): the models may be tried again.
  fb.logged(agent.session.id, { type: 'turn/end', data: { reason: { kind: 'completed' } } })
  agent.selected.length = 0
  fb.requested(agent.session.id)
  assert.ok(fb.failed(agent as FallbackAgent, llmError('QUOTA', 'x')))
})

test('not the app\'s session (a dsh shared with other work): left alone', () => {
  const agent = fakeAgent(A)
  const fb = fallback({ agents: [B] }, { isOwn: () => false })
  fb.requested(agent.session.id)
  assert.equal(fb.failed(agent as FallbackAgent, llmError('QUOTA', 'x')), undefined)
})

test('an agent stopped for good before it goes on: nothing is sent', async () => {
  const agent = Object.assign(fakeAgent(A), { lifetimeSignal: AbortSignal.abort() })
  const fb = fallback({ agents: [B] })
  fb.requested(agent.session.id)
  fb.failed(agent as FallbackAgent, llmError('QUOTA', 'x'))
  agent.status = 'idle'
  fb.idle(agent as FallbackAgent)
  await tick()
  assert.equal(agent.queued.length, 0)
})
