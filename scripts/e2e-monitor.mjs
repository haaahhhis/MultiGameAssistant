#!/usr/bin/env node
/**
 * End-to-end check of M3 against a running host, with no network, no game and
 * no real Feishu app: a fake Feishu Open Platform (REST + the long connection
 * the official SDK opens) plays the person on the phone, a fake model plays
 * the agent's brain, and a copy of node.exe plays the script.
 *
 * 1. Feishu is configured through `feishu@1` (App ID, the secret in dsh
 *    credentials); the bot connects; a stranger is told their open_id and is
 *    then allowed.
 * 2. L0: a task whose first run loses its connection is restarted by the
 *    pack's recovery and succeeds; the incident settles itself; nothing is
 *    pushed.
 * 3. L3: a task that reports an error nobody handles is pushed to Feishu as a
 *    card; pressing 停止 on the card stops the run and the card says so.
 * 4. A Feishu message becomes a conversation with the agent: it looks at the
 *    incidents and the answer comes back as a reply.
 * 5. An approval the agent needs is sent as a card and answered from Feishu.
 * 6. A session in the app keeps its approvals out of Feishu, unless
 *    「软件里的会话需要确认时也发到飞书」 is on.
 * 7. The agent's question (ask_user_question) in a Feishu conversation goes to
 *    that person as a card; replying with an option's number answers it.
 *
 *   ADG_GATEWAY_TOKEN=dev-token ADG_FEISHU_BASE_URL=http://127.0.0.1:3299 pnpm dev:host
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e:monitor
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startFakeFeishu, startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ID = 'e2e-monitor-tool'
const APP_ID = 'cli_a1b2c3d4e5f60718'
const USER = 'ou_7d8a6e2e00000000000000000000e2e1'
const SECRET_REF = 'ADG_FEISHU_APP_SECRET'
const FEISHU_PORT = Number(process.env.ADG_FAKE_FEISHU_PORT ?? 3299)
const dataDir = process.env.ADG_DATA_DIR ?? join(process.env.DSH_HOME ?? join(here, '..', '.dev-home'), 'adg', 'data')
const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

// ── the script: FakeTool.exe (node) with two scenarios ──
const dir = mkdtempSync(join(tmpdir(), 'adg-e2e-monitor-'))
copyFileSync(process.execPath, join(dir, 'FakeTool.exe'))
mkdirSync(join(dir, 'app'))
for (const file of ['fake-script-cli.js', 'fake-script.js']) copyFileSync(join(here, '..', 'packages', 'test-kit', 'lib', file), join(dir, 'app', file))
writeFileSync(join(dir, 'app', 'package.json'), '{"type":"module"}')
mkdirSync(join(dir, 'debug'))
writeFileSync(join(dir, 'flaky.json'), JSON.stringify({ steps: [
  { logFile: 'debug/run.log', line: '[INF] 开始任务' },
  { once: 'debug/.lost-once', steps: [{ sleepMs: 300 }, { logFile: 'debug/run.log', line: '[ERR] 连接断开，无法继续' }, { sleepMs: 60_000 }] },
  { sleepMs: 300 },
  { logFile: 'debug/run.log', line: '[INF] 全部任务完成' },
  { sleepMs: 60_000 },
] }))
writeFileSync(join(dir, 'stuck.json'), JSON.stringify({ steps: [
  { logFile: 'debug/run.log', line: '[INF] 开始任务' },
  { sleepMs: 300 },
  { logFile: 'debug/run.log', line: '[ERR] 任务出错: 遇到了不认识的界面' },
  { sleepMs: 120_000 },
] }))

const MANIFEST = `id: ${ID}
name: E2E 监控假工具
family: gui-config
detect:
  files: [FakeTool.exe, flaky.json]
launch:
  exe: FakeTool.exe
  args: ['app/fake-script-cli.js']
  stopAfterDone: true
  stopGraceSeconds: 0
tasks:
  - { id: flaky, title: 会断线的任务, args: ['flaky.json'], success: done-log }
  - { id: stuck, title: 会出错的任务, args: ['stuck.json'], success: done-log }
logs:
  sources: [{ path: debug/run.log }]
  rules:
    - { match: '全部任务完成', level: done }
    - { match: '连接断开', level: error, tag: link-lost }
    - { match: '任务出错', level: error, tag: task-error }
recovery:
  - { on: link-lost, do: restart }
`
const packDir = join(dataDir, 'packs', ID)
mkdirSync(packDir, { recursive: true })
writeFileSync(join(packDir, 'adg.script.yaml'), MANIFEST)
writeFileSync(join(packDir, 'SKILL.md'), `---\nname: ${ID}\ndescription: M3 端到端检查用的假工具。\n---\n\n# E2E 监控假工具\n`)

const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] })
const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  replies: [
    call('monitor_incidents', { status: 'all' }), { text: '刚才「会出错的任务」遇到了不认识的界面，已经按你的要求停止了；「会断线的任务」断线后自动重跑成功。' },
    call(SHELL, { description: 'Print hi', command: 'echo hi', sandbox_permissions: 'danger-full-access', justification: 'e2e：在飞书里确认' }), { text: '命令已经运行，输出 hi。' },
    call(SHELL, { description: 'Print ui-1', command: 'echo ui-1', sandbox_permissions: 'danger-full-access', justification: 'e2e：只在界面里确认' }), { text: '运行了 ui-1。' },
    call(SHELL, { description: 'Print ui-2', command: 'echo ui-2', sandbox_permissions: 'danger-full-access', justification: 'e2e：也发到飞书' }), { text: '运行了 ui-2。' },
    call('ask_user_question', { questions: [{ id: 'close', question: '活动看完了，要不要把游戏关掉？', options: [{ label: '关掉游戏 (Recommended)' }, { label: '先开着' }] }] }), { text: '好的，游戏先开着。' },
  ],
  fallback: { text: '好的。' },
  scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
})
const feishu = await startFakeFeishu({ appId: APP_ID, appSecret: 'secret-ok', port: FEISHU_PORT })
const gateway = await connectGateway({ name: 'adg-e2e-monitor' })
const { call: rpc } = gateway
const steps = []
const step = (name, detail = '') => {
  steps.push(name)
  console.log(`✔ ${name}${detail === '' ? '' : `: ${detail}`}`)
}
const fail = message => { throw new Error(message) }
const until = async (what, check, ms = 30_000) => {
  const end = Date.now() + ms
  for (;;) {
    const value = await check()
    if (value) return value
    if (Date.now() > end) fail(`timed out waiting for ${what}`)
    await delay(200)
  }
}

let interveneBefore
try {
  for (const cap of ['runs', 'monitor', 'notify', 'feishu']) if (!gateway.capabilities.includes(cap)) fail(`capability ${cap} missing; rebuild and restart pnpm dev:host`)

  // The model a Feishu conversation uses is the one last used in the UI.
  await saveFakeProvider(rpc, `${llm.url}/v1`)
  const { sessionId: uiSession } = await rpc('sessions/create', {})
  await until('the fake model route', () => rpc('session/selectModel', { sessionId: uiSession, provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false))

  // M3 behaviour: what L0 leaves goes straight to the user (M5's agent step is e2e:intervene).
  interveneBefore = (await rpc('monitor/settings', {})).intervene
  if (interveneBefore !== undefined) await rpc('monitor/settings/set', { intervene: 'off' })

  // 1. Feishu
  await rpc('credentials/set', { ref: SECRET_REF, value: 'secret-ok' })
  await rpc('feishu/settings/set', { appId: APP_ID, enabled: true })
  const ready = await until('the Feishu bot to connect (was the host started with ADG_FEISHU_BASE_URL?)', async () => {
    const { channels } = await rpc('notify/status', {})
    const channel = channels.find(c => c.id === 'feishu')
    return channel?.state === 'ready' && feishu.connected() ? channel : undefined
  })
  step('Feishu connected over the long connection', ready.checks.map(c => `${c.label}${c.ok ? '✓' : c.ok === false ? '✗' : '…'}`).join(' '))
  await feishu.sendMessage({ openId: USER, text: '你好' })
  await feishu.waitForMessage(m => m.kind === 'reply' && m.text.includes(`open_id：${USER}`))
  const pending = await rpc('feishu/settings', {})
  if (!pending.pending.some(p => p.openId === USER)) fail('the stranger is not listed as pending')
  await rpc('feishu/users/allow', { openId: USER, name: 'E2E 用户' })
  await feishu.waitForMessage(m => m.kind === 'create' && m.to === USER && m.text.includes('你已被允许'))
  step('a stranger is told their open_id, then allowed from the UI')

  const imported = await rpc('scripts/import', { path: dir, id: ID, name: 'E2E 监控假工具' })
  if (imported.packId !== ID) fail(`pack not attached: ${imported.packId}`)

  // 2. L0
  const cardsBefore = feishu.messages.filter(m => m.msgType === 'interactive').length
  const first = await rpc('runs/start', { scriptId: ID, taskId: 'flaky' })
  const restarted = await until('the restarted run to succeed', async () => {
    const { items } = await rpc('runs/list', { scriptId: ID })
    return items.find(r => r.retryOf === first.id && r.state === 'succeeded')
  })
  const lost = (await rpc('monitor/incidents', { status: 'all' })).items.find(i => i.runId === first.id && i.tag === 'link-lost')
  if (lost === undefined) fail('no link-lost incident')
  if (lost.steps[0]?.action !== 'restart' || lost.steps[0]?.ok !== true) fail(`recovery did not restart: ${JSON.stringify(lost.steps)}`)
  await until('the incident to settle', async () => (await rpc('monitor/incidents', { status: 'all' })).items.find(i => i.id === lost.id)?.status === 'resolved')
  if (feishu.messages.filter(m => m.msgType === 'interactive').length !== cardsBefore) fail('a recovered incident was pushed')
  step('L0: the lost connection was handled by a restart; nothing pushed', `${first.id} → ${restarted.id} succeeded`)

  // 3. L3 card, stopped from Feishu
  const stuck = await rpc('runs/start', { scriptId: ID, taskId: 'stuck' })
  const card = await feishu.waitForMessage(m => m.kind === 'create' && m.msgType === 'interactive' && m.text.includes('不认识的界面'))
  if (!JSON.stringify(card.content).includes('"action":"stop"')) fail('the card has no stop button')
  const incidentId = card.content.elements.find(e => e.tag === 'action').actions[0].value.id
  const toast = await feishu.clickCard({ openId: USER, value: { kind: 'notice', id: incidentId, action: 'stop' }, messageId: card.id })
  if (toast?.toast?.type !== 'success') fail(`click answered ${JSON.stringify(toast)}`)
  const stopped = await until('the run to stop', async () => (await rpc('runs/list', { scriptId: ID })).items.find(r => r.id === stuck.id && r.state === 'cancelled'))
  await feishu.waitForMessage(m => m.kind === 'patch' && m.id === card.id && m.text.includes('已处理'))
  step('an unhandled error went to Feishu as a card; 停止 on the card stopped the run', `${toast.toast.content}; outcome: ${stopped.outcome}`)

  // 4. conversation
  await feishu.sendMessage({ openId: USER, text: '刚才怎么了' })
  const answer = await feishu.waitForMessage(m => m.kind === 'reply' && m.text.includes('自动重跑成功'), 120_000)
  const asked = llm.requests.find(r => JSON.stringify(r.messages ?? []).includes('刚才怎么了'))
  if (asked === undefined) fail('the agent never saw the Feishu message')
  if (answer.msgType !== 'post' || answer.content?.zh_cn?.content?.[0]?.[0]?.tag !== 'md') fail(`the answer went out as ${answer.msgType}, not rich text with markdown`)
  step('a Feishu message became a conversation with the agent (it used monitor_incidents); the answer is rich text', answer.text.slice(0, 40))

  // 5. approval answered in Feishu
  await feishu.sendMessage({ openId: USER, text: '运行 echo hi' })
  const approvalCard = await feishu.waitForMessage(m => m.kind === 'create' && m.text.includes('需要你确认'), 120_000)
  const approvalId = approvalCard.content.elements.find(e => e.tag === 'action').actions[0].value.id
  const allowed = await feishu.clickCard({ openId: USER, value: { kind: 'approval', id: approvalId, decision: 'allow-once' }, messageId: approvalCard.id })
  if (allowed?.toast?.type !== 'success') fail(`approval click answered ${JSON.stringify(allowed)}`)
  await feishu.waitForMessage(m => m.kind === 'reply' && m.text.includes('输出 hi'), 120_000)
  step('an approval went to Feishu as a card and was answered there', allowed.toast.content)

  // 6. a session in the app keeps its approvals to itself, unless 「软件里的会话」 is on
  const seen = new Set()
  const uiApproval = async text => {
    const requested = gateway.waitFor(m => m.method === 'approval/requested' && m.params.sessionId === uiSession, 'an approval in the UI session', 120_000)
    await rpc('session/prompt', { sessionId: uiSession, requestId: `p-${Date.now()}`, text, mode: 'queue' })
    const request = await requested
    await delay(1500)
    const card = feishu.messages.find(m => m.kind === 'create' && m.text.includes('需要你确认') && m.text.includes(uiSession) && !seen.has(m.id))
    for (const m of feishu.messages) seen.add(m.id)
    await rpc('approval/respond', { approvalId: request.approvalId, decision: 'allow-once' })
    return card
  }
  if ((await uiApproval('运行 ui-1')) !== undefined) fail('a UI session’s approval was sent to Feishu')
  await rpc('feishu/settings/set', { otherApprovals: true })
  const shared = await uiApproval('运行 ui-2')
  await rpc('feishu/settings/set', { otherApprovals: false })
  if (shared === undefined) fail('with 「软件里的会话」 on, the UI session’s approval did not reach Feishu')
  // Its last reply is scripted too: let the UI session take it before Feishu asks for the next one.
  await until('the UI session to finish', () => llm.requests.some(r => r.messages?.at(-1)?.role === 'tool' && JSON.stringify(r.messages.at(-1)).includes('ui-2')), 60_000)
  step('a UI session’s approval stayed in the UI; with 「软件里的会话」 on it also went to Feishu')

  // 7. the agent's question in the Feishu conversation, answered by a plain reply
  await feishu.sendMessage({ openId: USER, text: '帮我去看看有什么活动没做' })
  const asking = await feishu.waitForMessage(m => m.kind === 'create' && m.text.includes('agent 在问你'), 120_000)
  if (asking.to !== USER) fail(`the question went to ${asking.to}, not the person who asked`)
  await feishu.sendMessage({ openId: USER, text: '2' })
  await feishu.waitForMessage(m => m.kind === 'reply' && m.text.includes('已经告诉 agent：先开着'), 60_000)
  await feishu.waitForMessage(m => m.kind === 'reply' && m.text.includes('游戏先开着'), 120_000)
  await feishu.waitForMessage(m => m.kind === 'patch' && m.id === asking.id && m.text.includes('你的回答：先开着'), 30_000)
  step('the agent’s question in a Feishu conversation went to that person; replying 2 answered it')

  console.log(`\nM3 end-to-end OK (${steps.length} steps); fake Feishu saw ${feishu.messages.length} messages, the fake model ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  for (const m of feishu.messages.slice(-5)) console.error(`  last Feishu ${m.kind} → ${m.to ?? m.parentId ?? m.id}: ${m.text.slice(0, 120).replace(/\n/g, ' ')}`)
  process.exitCode = 1
} finally {
  if (interveneBefore !== undefined) await rpc('monitor/settings/set', { intervene: interveneBefore }).catch(() => {})
  for (const run of (await rpc('runs/list', { scriptId: ID }).catch(() => ({ items: [] }))).items) if (run.endedAt === undefined) await rpc('runs/stop', { runId: run.id }).catch(() => {})
  await rpc('scripts/remove', { id: ID }).catch(() => {})
  await rpc('feishu/users/remove', { openId: USER }).catch(() => {})
  await rpc('feishu/settings/set', { enabled: false, appId: null }).catch(() => {})
  await rpc('credentials/unset', { ref: SECRET_REF }).catch(() => {})
  await removeFakeProvider(rpc)
  rmSync(packDir, { recursive: true, force: true })
  rmSync(join(dataDir, 'configs', ID), { recursive: true, force: true })
  gateway.close()
  await llm.close()
  await feishu.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}
