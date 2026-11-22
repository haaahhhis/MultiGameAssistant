#!/usr/bin/env node
/**
 * End-to-end check of 备用模型 (设置 → 模型) against a running host with two
 * fake model services: 「没钱」 answers every request with 402 Insufficient
 * Balance, 「备用」 answers normally.
 *
 * 1. A conversation on 「没钱」 goes on with 「备用」 (the agents' list): its
 *    log has the card (which service and model, why), the backup model
 *    reads the card and the person's message, and the turn completes.
 * 2. A sub-agent on 「没钱」 goes on with 「备用」 (the sub-agents' list), and
 *    what it hands back is its answer, not a failure: the agent that opened
 *    it waits for the turn the card opens.
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e:fallback
 */
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway } from './lib/gateway.mjs'

const BROKE = { provider: 'adg-fake-broke', model: 'fake-broke' }
const BACKUP = { provider: 'adg-fake-backup', model: 'fake-backup' }
const said = (body, text) => JSON.stringify(body.messages ?? []).includes(text)
const lastTool = body => body.messages?.findLast(m => m.role === 'assistant' && Array.isArray(m.tool_calls))?.tool_calls?.at(-1)?.function?.name
const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] })

const broke = await startFakeLlm({ models: [BROKE.model], fallback: { error: { status: 402, message: 'Insufficient Balance' } } })
const backup = await startFakeLlm({
  models: [BACKUP.model],
  respond: body => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) return undefined
    const last = body.messages?.at(-1)
    if (said(body, 'E2E-SUB-LEAD')) {
      if (said(body, 'CHILD-ANSWER-42')) return { text: '子任务交回了：CHILD-ANSWER-42' }
      if (last?.role === 'tool' && lastTool(body) === 'subagent') return { text: '开了一个子任务，等它回来。' }
      return call('subagent', { description: '数一个数', prompt: 'E2E-SUB-CHILD 回答一个数', provider: 'guessed-parent-provider', model: 'guessed-parent-model' })
    }
    if (said(body, 'E2E-SUB-CHILD')) return { text: 'CHILD-ANSWER-42' }
    if (said(body, 'E2E-FALLBACK')) return { text: '备用模型答好了。' }
    return undefined
  },
})
const gateway = await connectGateway({ name: 'adg-e2e-fallback' })
const { call: rpc } = gateway
const steps = []
const step = (name, detail = '') => { steps.push(name); console.log(`✔ ${name}${detail === '' ? '' : `: ${detail}`}`) }
const fail = message => { throw new Error(message) }
const until = async (what, check, ms = 90_000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) fail(`timed out waiting for ${what}`)
    await delay(250)
  }
}

async function saveProvider(id, name, baseURL, model) {
  const current = await rpc('providers/list', {})
  const exists = current.providers.some(p => p.id === id)
  await rpc('providers/save', {
    id, create: !exists, displayName: name, api: 'openai-completions', baseURL, models: [{ id: model, input: ['text', 'image'] }], apiKey: 'fake-key', expectedRevision: current.revision,
  })
}
async function removeProvider(id) {
  const current = await rpc('providers/list', {}).catch(() => undefined)
  if (current?.providers.some(p => p.id === id)) await rpc('providers/remove', { id, removeKey: true, expectedRevision: current.revision }).catch(() => {})
}

const before = await rpc('models/agentModels', {})
try {
  if (before.fallbacks === undefined) fail('the gateway has no fallback lists (is the host running this checkout?)')
  await saveProvider(BROKE.provider, 'E2E 没钱', `${broke.url}/v1`, BROKE.model)
  await saveProvider(BACKUP.provider, 'E2E 备用', `${backup.url}/v1`, BACKUP.model)
  await rpc('models/setFallbacks', { sub: false, models: [BACKUP] })
  await rpc('models/setFallbacks', { sub: true, models: [BACKUP] })
  const lists = (await rpc('models/agentModels', {})).fallbacks
  if (JSON.stringify(lists) !== JSON.stringify({ agents: [BACKUP], subAgents: [BACKUP] })) fail(`the lists were not kept: ${JSON.stringify(lists)}`)
  step('both fallback lists set')

  // 1. The conversation's own model.
  const { sessionId } = await rpc('sessions/create', {})
  await until('the broke model route', () => rpc('session/selectModel', { sessionId, ...BROKE }).then(() => true, () => false))
  await rpc('session/prompt', { sessionId, requestId: `p-${Date.now()}`, text: 'E2E-FALLBACK 查一下', mode: 'queue' })
  await until('the broke model to be asked', () => broke.requests.some(r => said(r, 'E2E-FALLBACK')))
  const answered = await until('the backup model to go on with it', () => backup.requests.find(r => said(r, 'E2E-FALLBACK') && said(r, '软件通知')))
  for (const part of ['E2E 没钱', 'E2E 备用', '余额或额度不足', 'Insufficient Balance']) if (!said(answered, part)) fail(`the backup model did not read 「${part}」 in the card`)
  step('the backup model read the person\'s message and the card', 'service names, the reason and the error are in its context')

  const events = await until('the turn to complete', async () => {
    const opened = await rpc('session/open', { sessionId })
    await rpc('session/close', { subscriptionId: opened.subscriptionId }).catch(() => {})
    const all = opened.events
    const end = all.findLast(e => e.type === 'turn/end')
    return end?.reason.kind === 'completed' && all.some(e => e.type === 'assistant/message' && JSON.stringify(e.content).includes('备用模型答好了')) ? all : undefined
  })
  const card = events.find(e => e.type === 'user/message' && e.origin.fallback !== undefined)
  if (card === undefined) fail('no fallback card in the log')
  const { from, to, reason, code } = card.origin.fallback
  if (from.provider !== BROKE.provider || to.provider !== BACKUP.provider || to.providerName !== 'E2E 备用') fail(`unexpected card: ${JSON.stringify(card.origin.fallback)}`)
  const failedTurn = events.find(e => e.type === 'turn/end' && e.reason.kind === 'error')
  if (failedTurn === undefined || failedTurn.seq > card.seq) fail('the failed turn should end before the card')
  step('the log has the card', `${from.providerName}/${from.modelName} → ${to.providerName}/${to.modelName}, ${reason} (${code})`)
  const model = await rpc('session/model', { sessionId })
  if (model.next?.provider !== BACKUP.provider || model.lastUsed?.provider !== BACKUP.provider) fail(`the conversation should stay on the backup model: ${JSON.stringify(model)}`)
  step('the conversation goes on with the backup model')

  // 2. A sub-agent's model.
  await rpc('models/setAgentModel', { agentId: 'main', sub: true, model: BROKE })
  const lead = (await rpc('sessions/create', {})).sessionId
  await until('the backup model route', () => rpc('session/selectModel', { sessionId: lead, ...BACKUP }).then(() => true, () => false))
  await rpc('session/prompt', { sessionId: lead, requestId: `p-${Date.now()}-lead`, text: 'E2E-SUB-LEAD 开个子任务', mode: 'queue' })
  await until('the sub-agent to ask the broke model', () => broke.requests.some(r => said(r, 'E2E-SUB-CHILD')))
  await until('the sub-agent to go on with the backup model', () => backup.requests.some(r => said(r, 'E2E-SUB-CHILD') && said(r, '软件通知')))
  step('the sub-agent went on with the backup model')
  const back = await until('the lead to get the sub-agent\'s answer', () => backup.requests.find(r => said(r, 'E2E-SUB-LEAD') && said(r, 'CHILD-ANSWER-42')))
  const handed = JSON.stringify(back.messages)
  if (/failed before it finished|stopReason[^,]*error/i.test(handed)) fail('the lead was told the sub-agent failed')
  if (back.tools?.some(tool => (tool.function?.name ?? tool.name) === 'wait_agent')) fail('the host offered a blocking inbox wait to the lead')
  await until('the settlement to resume and finish the lead turn', async () => {
    const opened = await rpc('session/open', { sessionId: lead })
    await rpc('session/close', { subscriptionId: opened.subscriptionId })
    const events = opened.events
    if (events.some(e => e.type === 'tool/call' && e.name === 'wait_agent')) fail('the lead polled for its child')
    const receipt = events.find(e => e.type === 'user/message' && e.origin.kind === 'subagent-settled')
    if (!receipt) return false
    const answer = events.find(e => e.seq > receipt.seq && e.type === 'assistant/message' && JSON.stringify(e.content).includes('子任务交回了：CHILD-ANSWER-42'))
    return answer && events.some(e => e.seq > answer.seq && e.type === 'turn/end' && e.reason.kind === 'completed')
  })
  step('the native settlement resumed the lead and it completed without wait_agent')
  console.log(`\nfallback end-to-end OK (${steps.length} steps); 没钱 served ${broke.requests.length} requests, 备用 ${backup.requests.length}`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  for (const [name, llm] of [['broke', broke], ['backup', backup]]) for (const [i, r] of llm.requests.entries()) console.error(`  ${name} ${i + 1}: last ${JSON.stringify(r.messages?.at(-1) ?? {}).slice(0, 200)}`)
  process.exitCode = 1
} finally {
  await rpc('models/setFallbacks', { sub: false, models: before.fallbacks?.agents ?? [] }).catch(() => {})
  await rpc('models/setFallbacks', { sub: true, models: before.fallbacks?.subAgents ?? [] }).catch(() => {})
  await rpc('models/setAgentModel', { agentId: 'main', sub: true, model: before.subAgentsOf?.main ?? null }).catch(() => {})
  await removeProvider(BROKE.provider)
  await removeProvider(BACKUP.provider)
  gateway.close()
  await broke.close()
  await backup.close()
}
process.exit(process.exitCode ?? 0)
