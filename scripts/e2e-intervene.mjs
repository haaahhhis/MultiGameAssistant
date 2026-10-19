#!/usr/bin/env node
/**
 * End-to-end check of M5 against a running host, with no game and no API key.
 * A fake image-capable model plays the agent; a copy of node.exe plays the
 * script.
 *
 * 1. A script reports an error no L0 recovery covers: the monitor hands it
 *    to the agent, which pauses the script, gets the incident in a 「干预」
 *    session, and decides to run it again; the rerun succeeds and the
 *    incident is settled by the agent.
 * 2. Another error the agent cannot handle: it looks (screen_capture) and
 *    gives up; the script stays paused (really suspended) until 继续.
 * 3. An image in a session (here: sent with a prompt) can be fetched back
 *    for display, as the chat does for screenshots.
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e:intervene
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { decodePng, encodePng } from '../packages/intervene/lib/png.js'
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.ADG_DATA_DIR ?? join(process.env.DSH_HOME ?? join(here, '..', '.dev-home'), 'adg', 'data')
const ID = 'e2e-intervene-tool'

const dir = mkdtempSync(join(tmpdir(), 'adg-e2e-iv-'))
copyFileSync(process.execPath, join(dir, 'Tool.exe'))
mkdirSync(join(dir, 'app'))
for (const file of ['fake-script-cli.js', 'fake-script.js']) copyFileSync(join(here, '..', 'packages', 'test-kit', 'lib', file), join(dir, 'app', file))
writeFileSync(join(dir, 'app', 'package.json'), '{"type":"module"}')
mkdirSync(join(dir, 'debug'))
writeFileSync(join(dir, 'flaky.json'), JSON.stringify({ steps: [
  { logFile: 'debug/run.log', line: '[INF] 开始' },
  { once: 'debug/.flaky-once', steps: [{ sleepMs: 300 }, { logFile: 'debug/run.log', line: '[ERR] 任务出错: 识别失败' }, { sleepMs: 60_000 }] },
  { logFile: 'debug/run.log', line: '[INF] 全部完成' },
  { sleepMs: 60_000 },
] }))
// Prints a tick every 100 ms after its error, so a pause is visible in the log file.
writeFileSync(join(dir, 'stuck.json'), JSON.stringify({ steps: [
  { logFile: 'debug/run.log', line: '[INF] 开始' },
  { sleepMs: 300 },
  { logFile: 'debug/run.log', line: '[ERR] 任务出错: 需要验证码' },
  ...Array.from({ length: 300 }, () => [{ sleepMs: 100 }, { logFile: 'debug/tick.log', line: 'tick' }]).flat(),
] }))
const packDir = join(dataDir, 'packs', ID)
mkdirSync(packDir, { recursive: true })
writeFileSync(join(packDir, 'adg.script.yaml'), `id: ${ID}
name: E2E 干预假工具
detect:
  files: [Tool.exe, flaky.json]
launch:
  exe: Tool.exe
  args: ['app/fake-script-cli.js']
  stopAfterDone: true
  stopGraceSeconds: 0
tasks:
  - { id: flaky, title: 会出错一次的任务, args: ['flaky.json'], success: done-log }
  - { id: stuck, title: 处理不了的任务, args: ['stuck.json'], success: done-log }
logs:
  sources: [{ path: debug/run.log }]
  rules:
    - { match: '全部完成', level: done }
    - { match: '任务出错', level: error, tag: task-error }
`)
writeFileSync(join(packDir, 'SKILL.md'), `---\nname: ${ID}\ndescription: M5 端到端检查用的假脚本。\n---\n\n# 假脚本\n`)

const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] })
const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  replies: [
    call('intervention_done', { result: 'retry', summary: '识别失败是界面没加载完，重新运行一次' }), { text: '已处理。' },
    call('screen_capture', { target: 'desktop' }), call('intervention_done', { result: 'give-up', summary: '要输入验证码，需要你来' }), { text: '交给用户。' },
  ],
  fallback: { text: '好的。' },
  scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
})
const gateway = await connectGateway({ name: 'adg-e2e-intervene' })
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
    await delay(300)
  }
}
const ticks = () => { try { return readFileSync(join(dir, 'debug', 'tick.log'), 'utf8').split('\n').filter(Boolean).length } catch { return 0 } }

let defaultBefore
let settingsBefore
try {
  for (const cap of ['monitor', 'intervene', 'model-default']) if (!gateway.capabilities.includes(cap)) fail(`capability ${cap} missing; rebuild and restart pnpm dev:host`)
  await saveFakeProvider(rpc, `${llm.url}/v1`)
  defaultBefore = (await rpc('models/catalog', {})).default
  await until('the fake model route', () => rpc('models/setDefault', { provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false))
  settingsBefore = await rpc('monitor/settings', {})
  // Earlier runs today count towards the daily cap: lift it for the check (restored at the end).
  await rpc('monitor/settings/set', { intervene: 'act', interventionsPerDay: 200 })
  const imported = await rpc('scripts/import', { path: dir, id: ID, name: 'E2E 干预假工具' })
  if (imported.packId !== ID) fail('pack not attached')
  step('script imported; the fake model is the default and can see images')

  // 1. the agent reruns it
  const first = await rpc('runs/start', { scriptId: ID, taskId: 'flaky' })
  const iv1 = await until('the first intervention to end', async () => (await rpc('intervene/list', {})).items.find(i => i.runId === first.id && i.state !== 'running'), 90_000)
  if (iv1.state !== 'retried') fail(`intervention ${iv1.state}: ${iv1.summary}`)
  const prompt = JSON.stringify(llm.requests.find(r => JSON.stringify(r.messages ?? []).includes('任务出错: 识别失败'))?.messages ?? [])
  if (!prompt.includes('intervention_done')) fail('the agent did not get the intervention prompt')
  const rerun = await until('the rerun to succeed', async () => (await rpc('runs/list', { scriptId: ID })).items.find(r => r.retryOf === first.id && r.state === 'succeeded'), 60_000)
  const incident1 = await until('the incident to settle', async () => (await rpc('monitor/incidents', { status: 'all' })).items.find(i => i.runId === first.id && i.status === 'resolved'))
  step('an error went to the agent, which ran the task again', `${iv1.summary} → ${rerun.id} 成功；${incident1.resolution}`)

  // 2. the agent gives up; the script stays paused
  const second = await rpc('runs/start', { scriptId: ID, taskId: 'stuck' })
  const iv2 = await until('the second intervention to end', async () => (await rpc('intervene/list', {})).items.find(i => i.runId === second.id && i.state !== 'running'), 90_000)
  if (iv2.state !== 'gave-up' || !iv2.paused) fail(`intervention ${iv2.state} paused=${iv2.paused}: ${iv2.summary}`)
  const captured = llm.requests.some(r => JSON.stringify(r.messages ?? []).includes('screen_capture'))
  if (!captured) fail('screen_capture was never called')
  const frozen = ticks()
  await delay(1000)
  if (ticks() - frozen > 1) fail(`the script kept running while paused (${ticks() - frozen} ticks)`)
  const incident2 = (await rpc('monitor/incidents', { status: 'open' })).items.find(i => i.runId === second.id)
  if (incident2 === undefined) fail('no open incident for the paused run')
  await rpc('monitor/act', { incidentId: incident2.id, action: 'resume' })
  await delay(1000)
  if (ticks() <= frozen + 3) fail('the script did not continue after 继续')
  step('the agent gave up; the script stayed paused until 继续', `${iv2.summary}`)
  await rpc('runs/stop', { runId: second.id })

  // 3. images in sessions come back to the UI (screenshots under tool calls, images sent with a prompt)
  if (!gateway.capabilities.includes('attachments')) fail('capability attachments missing')
  const red = encodePng({ width: 64, height: 40, data: Buffer.alloc(64 * 40 * 4, Buffer.from([220, 40, 40, 255])) })
  const { sessionId } = await rpc('sessions/create', {})
  await rpc('session/prompt', { sessionId, requestId: `e2e-iv-img-${Date.now()}`, text: '看看这张图', mode: 'queue', images: [{ mediaType: 'image/png', data: red.toString('base64'), name: 'red.png' }] })
  const image = await until('the image in the session', async () => {
    const opened = await rpc('session/open', { sessionId })
    await rpc('session/close', { subscriptionId: opened.subscriptionId }).catch(() => {})
    return opened.events.flatMap(e => e.type === 'user/message' ? e.content : []).find(p => p.type === 'image' && p.attachmentId !== undefined)
  })
  const fetched = await rpc('attachments/image', { attachmentId: image.attachmentId, mediaType: image.mediaType, bytes: image.bytes, width: image.width, height: image.height })
  const back = decodePng(Buffer.from(fetched.data, 'base64'))
  if (back.width !== 64 || back.height !== 40 || back.data[0] !== 220) fail(`the image came back as ${back.width}×${back.height}`)
  step('an image in a session can be fetched for display', `${image.attachmentId.slice(0, 12)}… ${fetched.mediaType} ${back.width}×${back.height}`)

  console.log(`\nM5 end-to-end OK (${steps.length} steps); the fake model served ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  process.exitCode = 1
} finally {
  for (const run of (await rpc('runs/list', { scriptId: ID }).catch(() => ({ items: [] }))).items) if (run.endedAt === undefined) await rpc('runs/stop', { runId: run.id }).catch(() => {})
  if (settingsBefore !== undefined) await rpc('monitor/settings/set', { intervene: settingsBefore.intervene, interventionsPerDay: settingsBefore.interventionsPerDay }).catch(() => {})
  if (defaultBefore !== undefined) await rpc('models/setDefault', { provider: defaultBefore.provider, model: defaultBefore.model }).catch(() => {})
  await rpc('scripts/remove', { id: ID }).catch(() => {})
  await removeFakeProvider(rpc)
  rmSync(packDir, { recursive: true, force: true })
  rmSync(join(dataDir, 'configs', ID), { recursive: true, force: true })
  gateway.close()
  await llm.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}
