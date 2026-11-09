#!/usr/bin/env node
/**
 * End-to-end check of how agents work together (docs/design/agent-roles.md
 * §14), against a running host with a fake model.
 *
 * Layer 3: 助手 hands work to 脚本, which opens a sub-agent and ends its turn.
 * - The sub-agent is 脚本's: its tools and role, no coordination tools.
 * - The hand-off settles only when the sub-agent is back and 脚本 has concluded,
 *   so 助手 gets the conclusion and not "I started a sub-task".
 *
 *   DSH_HOME=<a scratch folder> ADG_GATEWAY_TOKEN=dev-token pnpm dev:host
 *   DSH_HOME=<same> ADG_GATEWAY_TOKEN=dev-token pnpm e2e:agents
 */
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const textOf = content => (typeof content === 'string' ? content : Array.isArray(content) ? content.map(p => p.text ?? '').join('') : '')
const toolsOf = body => (body.tools ?? []).map(t => t.function?.name ?? t.name)
const systemOf = body => (body.messages ?? []).filter(m => m.role === 'system').map(m => textOf(m.content)).join('\n')
/** What this turn was started with, and everything said since the model last spoke. */
const newSince = body => {
  const messages = body.messages ?? []
  const last = messages.findLastIndex(m => m.role === 'assistant')
  return messages.slice(last + 1).filter(m => m.role === 'user').map(m => textOf(m.content)).join('\n')
}
const lastTool = body => (body.messages ?? []).findLast(m => m.role === 'assistant')?.tool_calls?.[0]?.function?.name

const seen = { child: [], lead: [], main: [] }
const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] })

const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  respond: body => {
    if (!Array.isArray(body.tools) || body.tools.length === 0) return { text: '模拟会话' }
    const all = JSON.stringify(body.messages ?? [])
    const said = newSince(body)
    const last = (body.messages ?? []).at(-1)
    // The sub-agent: its only task is the words below.
    if (said.includes('E2E-CHILD') && !all.includes('E2E-LEAD')) {
      seen.child.push(body)
      return { delayMs: 3000, text: '子任务结果：第 212 行报错' }
    }
    // 脚本, as the lead.
    if (all.includes('E2E-LEAD') && !systemOf(body).includes('你的角色：助手')) {
      seen.lead.push(body)
      if (last?.role === 'tool' && lastTool(body) === 'subagent') return { text: '我开了一个子任务去读日志，等它回来。' }
      if (said.includes('第 212 行报错')) return { text: '结论：第 212 行报错，是配置格式变了。' }
      if (said.includes('E2E-LEAD')) return call('subagent', { description: '读日志', prompt: 'E2E-CHILD 读运行日志，交回报错的行号' })
      return { text: '（脚本）好的。' }
    }
    // 助手.
    seen.main.push(body)
    if (last?.role === 'tool' && lastTool(body) === 'agent_delegate') return { text: '已经交给「脚本」了。' }
    if (said.includes('E2E-DELEGATE')) return call('agent_delegate', { agent: '脚本', task: 'E2E-LEAD 看看 MAA 为什么报错', expecting: '报错原因' })
    if (/^（「[^」]+」(交回了|没有做完)/.test(said)) return { text: `（助手转述）${said.split('\n\n')[1] ?? ''}` }
    return { text: '（助手）好的。' }
  },
})

/** The host may still be starting. */
async function connect() {
  const end = Date.now() + 90_000
  for (;;) {
    try {
      return await connectGateway({ name: 'adg-e2e-agents' })
    } catch (error) {
      if (Date.now() > end) throw error
      await delay(1000)
    }
  }
}
const gateway = await connect()
const { call: rpc } = gateway
const steps = []
const step = (name, detail = '') => { steps.push(name); console.log(`✔ ${name}${detail === '' ? '' : `: ${detail}`}`) }
const fail = message => { throw new Error(message) }
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
  const home = async agentId => {
    const { sessionId } = await rpc('agents/home', { agentId })
    await until(`the fake model route for ${agentId}`, () => rpc('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false))
    return sessionId
  }
  const main = await home('main')
  const scripts = await home('scripts')

  const since = Date.now()
  await rpc('session/prompt', { sessionId: main, requestId: `e2e-${since}`, text: 'E2E-DELEGATE 帮我看看 MAA', mode: 'queue' })

  const child = await until('the sub-agent to be asked', () => seen.child[0], 60_000)
  const childTools = toolsOf(child)
  const childSystem = systemOf(child)
  const tools = JSON.stringify(childTools)
  if (childSystem.includes('你的角色：助手')) fail(`the sub-agent of 脚本 was told it is 助手; tools: ${tools}`)
  if (childTools.includes('agent_delegate')) fail(`the sub-agent holds agent_delegate; tools: ${tools}`)
  if (!childTools.includes('script_list')) fail(`the sub-agent does not hold 脚本's tools; tools: ${tools}`)
  if (!childSystem.includes('脚本')) fail('the sub-agent does not know whose it is')
  for (const name of ['ask_user_question', 'notice_act', 'subagent_fork']) if (childTools.includes(name)) fail(`the sub-agent holds ${name}; tools: ${tools}`)
  step("the sub-agent is 脚本's: its tools, no coordination", `${childTools.length} tools`)

  const leadTools = toolsOf(seen.lead[0])
  const mainTools = toolsOf(seen.main[0])
  if (!leadTools.includes('subagent') || !mainTools.includes('subagent')) fail('助手 and the lead agents can open sub-agents')
  if (leadTools.includes('subagent_fork') || mainTools.includes('subagent_fork')) fail('nobody forks: an agent has one long conversation')
  if (mainTools.includes('screen_tap')) fail('助手 does not do the work itself')
  step('助手 and 脚本 can open sub-agents; nobody can fork')

  const settled = await until('the hand-off to settle', async () => (await rpc('handoffs/list', { sessionId: scripts })).items.find(h => h.startedAt >= since && h.state !== 'running'), 60_000)
  if (settled.state !== 'done') fail(`the hand-off ended as ${settled.state}: ${settled.reply}`)
  if (!settled.reply?.includes('结论')) fail(`the hand-off settled before the sub-agent came back; 助手 was given: ${settled.reply}`)
  step('the hand-off settled on the conclusion, after the sub-agent came back', settled.reply)

  await until('助手 to get the conclusion', () => seen.main.some(b => newSince(b).includes('结论：第 212 行报错')))
  step('助手 was given the conclusion')

  console.log(`\nagents end-to-end OK (${steps.length} steps); the fake model served ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  process.exitCode = 1
} finally {
  await removeFakeProvider(rpc)
  gateway.close()
  await llm.close()
}
process.exit(process.exitCode ?? 0)
