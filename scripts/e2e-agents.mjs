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

const NAME = '小满'
const STYLE = '稳重周到的管家'
const seen = { child: [], lead: [], main: [], peer: [] }
let threadId
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
    const system = systemOf(body)
    // 游戏, asked by its colleague.
    if (system.includes('你的角色：游戏')) {
      seen.peer.push(body)
      return { text: '用户玩国服。' }
    }
    // 脚本, on the thread: tries to hand back up the chain, asks a colleague, asks 助手, concludes.
    if (system.includes('你的角色：脚本') && all.includes('E2E-THREAD-TASK') && !said.includes('E2E-LEAD')) {
      seen.lead.push(body)
      if (said.includes('今晚装')) return { text: '结论：按国服今晚装好了。' }
      if (said.includes('E2E-THREAD-TASK')) {
        threadId = /线索是 (\S+)：/.exec(said)?.[1]
        return call('agent_delegate', { agent: '助手', task: '你替我决定 E2E-BACK' })
      }
      if (last?.role === 'tool' && lastTool(body) === 'agent_delegate' && all.includes('E2E-BACK') && !all.includes('E2E-PEER')) {
        return { toolCalls: [{ name: 'agent_delegate', arguments: { agent: '游戏', task: 'E2E-PEER 用户玩哪个服？', expecting: '服' } }] }
      }
      if (last?.role === 'tool' && lastTool(body) === 'agent_delegate') return { text: '问了游戏，等它回来。' }
      if (said.includes('用户玩国服')) return call('agent_message', { thread: threadId, kind: 'question', text: 'E2E-QUESTION 现在装还是今晚装？' })
      if (last?.role === 'tool' && lastTool(body) === 'agent_message') return { text: '问了助手，等它回答。' }
      if (said.includes('今晚装')) return { text: '结论：按国服今晚装好了。' }
      return { text: '（脚本）好的。' }
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
    if (said.includes('E2E-THREAD ')) return call('agent_delegate', { agent: '脚本', task: 'E2E-THREAD-TASK 装 MAA' })
    if (said.includes('E2E-QUESTION')) {
      const id = /在线索 (\S+) 里问你/.exec(said)?.[1]
      return call('agent_message', { thread: id, kind: 'answer', text: '今晚装' })
    }
    if (last?.role === 'tool' && lastTool(body) === 'agent_message') return { text: '回答了。' }
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
  await rpc('persona/set', { persona: { style: 'butler', name: NAME } })
  const home = async agentId => {
    // A conversation of its own for this run: the fake model reads the history.
    await rpc('sessions/archive', { sessionId: (await rpc('agents/home', { agentId })).sessionId })
    const { sessionId } = await rpc('agents/home', { agentId })
    await until(`the fake model route for ${agentId}`, () => rpc('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false))
    return sessionId
  }
  const main = await home('main')
  const scripts = await home('scripts')
  await home('games')

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

  // Identity: each knows who it is and who else there is; a sub-agent knows only whose it is; the name is 助手's.
  const leadSystem = systemOf(seen.lead[0])
  const mainSystem = systemOf(seen.main[0])
  for (const [who, text, wanted] of [
    ['脚本', leadSystem, ['你是「脚本」（scripts）', '上级是「助手」（main）', '「游戏」（games）', '「干预」（intervene）', '没有任何标注：用户本人']],
    ['助手', mainSystem, ['你是「助手」（main）', '最上级', '「脚本」（scripts）', '没有任何标注：用户本人']],
  ]) for (const part of wanted) if (!text.includes(part)) fail(`${who} was not told: ${part}`)
  if (childSystem.includes('# 团队')) fail('a sub-agent has no team of its own')
  if (leadSystem.includes(NAME)) fail("脚本 was given the name that is 助手's")
  if (!mainSystem.includes(`你的名字是「${NAME}」`)) fail('助手 did not get its name')
  if (childSystem.includes('# 回复风格')) fail('a sub-agent got a reply style: its answer is data')
  if (!leadSystem.includes(STYLE) || !mainSystem.includes(STYLE)) fail('the reply style did not reach the agents')
  step('each knows who it is and who else there is; the name is 助手\'s; a sub-agent has neither')

  const settled = await until('the hand-off to settle', async () => (await rpc('handoffs/list', { sessionId: scripts })).items.find(h => h.startedAt >= since && h.state !== 'running'), 60_000)
  if (settled.state !== 'done') fail(`the hand-off ended as ${settled.state}: ${settled.reply}`)
  if (!settled.reply?.includes('结论')) fail(`the hand-off settled before the sub-agent came back; 助手 was given: ${settled.reply}`)
  step('the hand-off settled on the conclusion, after the sub-agent came back', settled.reply)

  await until('助手 to get the conclusion', () => seen.main.some(b => newSince(b).includes('结论：第 212 行报错')))
  step('助手 was given the conclusion')

  // Layer 2: more than one question and one answer, and leads talking directly.
  const threadSince = Date.now()
  await rpc('session/prompt', { sessionId: main, requestId: `e2e-t-${threadSince}`, text: 'E2E-THREAD 让脚本装 MAA', mode: 'queue' })
  const thread = await until('the thread to close', async () => (await rpc('handoffs/list', { sessionId: scripts })).items.find(h => h.startedAt >= threadSince && h.by === '助手' && h.state !== 'running' && h.state !== 'waiting'), 90_000)
  if (thread.state !== 'done') fail(`the thread ended as ${thread.state}: ${thread.reply}`)
  const kinds = (thread.messages ?? []).map(m => `${m.from}:${m.kind}`).join(' ')
  if (kinds !== '脚本:question 助手:answer') fail(`the thread went: ${kinds}; ${JSON.stringify(thread).slice(0, 700)}; all: ${JSON.stringify((await rpc("handoffs/list", { sessionId: scripts })).items.filter(h => h.startedAt >= threadSince).map(h => [h.id, h.by, h.to, h.state, h.reply])).slice(0, 700)}; 脚本 was asked: ${seen.lead.slice(-6).map(b => JSON.stringify(b.messages?.at(-1)).slice(0, 160)).join(" | ")}`)
  if (!thread.reply?.includes('按国服今晚装好了')) fail(`it concluded without what it heard: ${thread.reply}`)
  step('脚本 asked 助手 mid-way, was answered, and went on', kinds)

  const peer = (await rpc('handoffs/list', { sessionId: scripts })).items.find(h => h.startedAt >= threadSince && h.by === '脚本')
  if (peer?.to !== 'games' || peer.state !== 'done') fail(`脚本 did not ask 游戏 directly: ${JSON.stringify(peer)}`)
  if (peer.parent !== thread.id || peer.chain?.join('>') !== 'main>scripts>games') fail(`the chain is wrong: ${JSON.stringify(peer)}`)
  if (seen.main.some(b => newSince(b).includes('E2E-PEER'))) fail('助手 was woken for what two leads said to each other')
  step('脚本 asked 游戏 directly, on the chain, without waking 助手', peer.chain.join(' → '))

  const told = await until('助手 to hear how it ended', () => seen.main.find(b => newSince(b).includes('按国服今晚装好了')))
  if (!newSince(told).includes('还问了：游戏')) fail('助手 was not told who it asked')
  step('助手 heard the conclusion, and who was consulted')

  const back = seen.lead.find(b => { const m = b.messages?.at(-1); return m?.role === 'tool' && textOf(m.content).includes('绕回去了') })
  if (back === undefined) fail('脚本 was not told that handing back to 助手 comes back on itself')
  step('handing back up the chain is refused, with what to do instead')

  console.log(`\nagents end-to-end OK (${steps.length} steps); the fake model served ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  process.exitCode = 1
} finally {
  await rpc('persona/set', { persona: { style: 'default' } }).catch(() => {})
  await removeFakeProvider(rpc)
  gateway.close()
  await llm.close()
}
process.exit(process.exitCode ?? 0)
