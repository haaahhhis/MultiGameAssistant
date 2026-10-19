#!/usr/bin/env node
/**
 * End-to-end check of M4 against a running host, with no game and no API key.
 * Copies of node.exe play two scripts: one on the emulator (a manual ADB
 * address), one on the desktop.
 *
 * 1. A pipeline with an emulator task and two desktop tasks drawn in
 *    parallel, then a message: the check says the desktop tasks will take
 *    turns; the run overlaps the emulator task with the desktop ones and runs
 *    the desktop ones one after the other.
 * 2. The scheduler: the pipeline is set to the next minute and runs by itself.
 * 3. The agent drafts a pipeline from a request (`pipeline_draft`) and runs it
 *    (`pipeline_run`); the draft is kept as a draft.
 *
 * Everything it creates is removed afterwards (ADG_E2E_KEEP=1 keeps the
 * pipelines and scripts to look at in the UI).
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e:pipelines
 */
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const dataDir = process.env.ADG_DATA_DIR ?? join(process.env.DSH_HOME ?? join(here, '..', '.dev-home'), 'adg', 'data')
const keep = process.env.ADG_E2E_KEEP === '1'
const ADB = 'e2e-emu-tool'
const DESK = 'e2e-desk-tool'
const PIPELINE = 'e2e-daily'
const DRAFT = 'e2e-agent-draft'

function fakeScript(id, name, input, tasks) {
  const dir = mkdtempSync(join(tmpdir(), `adg-e2e-${id}-`))
  copyFileSync(process.execPath, join(dir, 'Tool.exe'))
  mkdirSync(join(dir, 'app'))
  for (const file of ['fake-script-cli.js', 'fake-script.js']) copyFileSync(join(here, '..', 'packages', 'test-kit', 'lib', file), join(dir, 'app', file))
  writeFileSync(join(dir, 'app', 'package.json'), '{"type":"module"}')
  for (const [task, ms] of Object.entries(tasks)) writeFileSync(join(dir, `${task}.json`), JSON.stringify({ steps: [{ log: `${task} 开始` }, { sleepMs: ms }, { log: `${task} 完成` }, { exit: 0 }] }))
  const packDir = join(dataDir, 'packs', id)
  mkdirSync(packDir, { recursive: true })
  writeFileSync(join(packDir, 'adg.script.yaml'), `id: ${id}
name: ${name}
detect:
  files: [Tool.exe, ${Object.keys(tasks)[0]}.json]
launch:
  exe: Tool.exe
  args: ['app/fake-script-cli.js']
tasks:
${Object.keys(tasks).map(t => `  - { id: ${t}, title: 任务${t}, args: ['${t}.json'], resources: { input: ${input} }, expectedDuration: 1m }`).join('\n')}
`)
  writeFileSync(join(packDir, 'SKILL.md'), `---\nname: ${id}\ndescription: M4 端到端检查用的假脚本。\n---\n\n# ${name}\n`)
  return { dir, packDir }
}

const emu = fakeScript(ADB, 'E2E 模拟器脚本', 'adb', { daily: 2500 })
const desk = fakeScript(DESK, 'E2E 前台脚本', 'desktop', { a: 1200, b: 1200 })

const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] })
const draft = {
  id: DRAFT, name: 'agent 编的流水线',
  nodes: [{ id: 'a', kind: 'script-task', scriptId: DESK, taskId: 'a' }, { id: 'n', kind: 'notify', text: '前台任务跑完了' }],
  edges: [{ from: 'a', to: 'n' }],
}
const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  replies: [call('pipeline_draft', { pipeline: draft }), call('pipeline_run', { id: DRAFT, wait: true }), { text: '流水线跑完了。' }],
  fallback: { text: '好的。' },
  scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
})
const gateway = await connectGateway({ name: 'adg-e2e-pipelines' })
const { call: rpc, waitFor } = gateway
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
const finished = runId => until(`pipeline run ${runId}`, async () => (await rpc('pipelines/runs', { limit: 50 })).items.find(r => r.id === runId && r.state !== 'running'), 120_000)
const windowOf = async runId => {
  const info = (await rpc('runs/list', {})).items.find(r => r.id === runId)
  return [info.startedAt, info.endedAt]
}

let before
try {
  for (const cap of ['pipelines', 'schedule', 'runs']) if (!gateway.capabilities.includes(cap)) fail(`capability ${cap} missing; rebuild and restart pnpm dev:host`)
  before = (await rpc('emulators/status', {})).settings
  await rpc('emulators/settings/set', { manualAddress: '127.0.0.1:5598' })
  for (const [id, s] of [[ADB, emu], [DESK, desk]]) {
    const imported = await rpc('scripts/import', { path: s.dir, id, name: id })
    if (imported.packId !== id) fail(`pack not attached to ${id}`)
  }
  step('two fake scripts imported', 'an emulator one and a desktop one')

  // 1. parallel + automatic queueing
  const pipeline = {
    id: PIPELINE, name: 'E2E 每日日常',
    nodes: [
      { id: 'emu', kind: 'script-task', scriptId: ADB, taskId: 'daily', position: { x: 40, y: 40 } },
      { id: 'a', kind: 'script-task', scriptId: DESK, taskId: 'a', position: { x: 40, y: 170 } },
      { id: 'b', kind: 'script-task', scriptId: DESK, taskId: 'b', position: { x: 40, y: 300 } },
      { id: 'done', kind: 'notify', text: '日常都跑完了', position: { x: 340, y: 170 } },
    ],
    edges: ['emu', 'a', 'b'].map(from => ({ from, to: 'done', when: 'always' })),
  }
  const saved = await rpc('pipelines/save', { pipeline })
  if (!saved.check.ok) fail(`check failed: ${JSON.stringify(saved.check.issues)}`)
  const serialized = saved.check.serialized.map(s => `${s.a}/${s.b}:${s.resource}`)
  if (!serialized.some(s => s.includes('桌面鼠标键盘'))) fail(`check did not see the desktop conflict: ${serialized}`)
  step('saved and checked', `会排队：${serialized.join('；')}；预计 ${saved.check.estimateMinutes} 分钟`)

  const sawWaiting = waitFor(m => m.method === 'pipelines/run' && m.params.pipelineId === PIPELINE && Object.values(m.params.nodes).some(n => n.state === 'waiting'), 'a waiting node', 60_000)
  const run = await rpc('pipelines/run', { id: PIPELINE })
  const waiting = await sawWaiting
  const done = await finished(run.id)
  if (done.state !== 'succeeded') fail(`run ${done.state}: ${done.outcome}`)
  const [e0, e1] = await windowOf(done.nodes.emu.runIds[0])
  const [a0, a1] = await windowOf(done.nodes.a.runIds[0])
  const [b0, b1] = await windowOf(done.nodes.b.runIds[0])
  if (!(e0 < Math.max(a1, b1) && Math.min(a0, b0) < e1)) fail('the emulator task did not overlap the desktop tasks')
  if (!(a1 <= b0 || b1 <= a0)) fail('the two desktop tasks overlapped')
  const waitingDetail = Object.values(waiting.nodes).find(n => n.state === 'waiting')?.detail
  step('ran: emulator ∥ desktop, the two desktop tasks took turns', `${waitingDetail}; ${done.outcome}`)

  // 2. the scheduler
  const next = new Date(Date.now() + 60_000)
  const hhmm = `${String(next.getHours()).padStart(2, '0')}:${String(next.getMinutes()).padStart(2, '0')}`
  await rpc('pipelines/save', { pipeline: { ...pipeline, schedule: { enabled: true, times: [hhmm], days: [], catchUpMinutes: 10 } } })
  const upcoming = (await rpc('schedule/status', {})).upcoming.find(u => u.pipelineId === PIPELINE)
  if (upcoming === undefined) fail('not in the upcoming list')
  console.log(`  … waiting for ${hhmm} (${Math.round((upcoming.at - Date.now()) / 1000)} s)`)
  const scheduled = await until('the scheduled run', async () => (await rpc('pipelines/runs', { pipelineId: PIPELINE, limit: 5 })).items.find(r => r.trigger.kind === 'schedule'), 150_000)
  const scheduledDone = await finished(scheduled.id)
  const history = (await rpc('schedule/status', {})).history.find(h => h.pipelineId === PIPELINE)
  if (history?.outcome !== 'fired') fail(`schedule history: ${JSON.stringify(history)}`)
  step('the scheduler started it at the set minute', `${history.slot} → ${scheduledDone.state}`)

  // 3. the agent drafts and runs
  await saveFakeProvider(rpc, `${llm.url}/v1`)
  const { sessionId } = await rpc('sessions/create', {})
  const opened = await rpc('session/open', { sessionId })
  await until('the fake model route', () => rpc('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false))
  const turnEnd = waitFor(m => m.method === 'session/event' && m.params.subscriptionId === opened.subscriptionId && m.params.event.type === 'turn/end', 'turn end', 180_000)
  await rpc('session/prompt', { sessionId, requestId: `e2e-pl-${Date.now()}`, text: '帮我编一个：先跑前台任务 a，跑完发飞书，然后现在就跑一次', mode: 'queue' })
  await turnEnd
  const drafted = await rpc('pipelines/get', { id: DRAFT })
  if (drafted.draft !== true) fail('the agent pipeline is not marked as a draft')
  const agentRun = (await rpc('pipelines/runs', { pipelineId: DRAFT, limit: 5 })).items[0]
  if (agentRun?.state !== 'succeeded' || agentRun.trigger.kind !== 'agent') fail(`agent run: ${JSON.stringify(agentRun)}`)
  step('the agent drafted a pipeline and ran it', `${drafted.name}（草稿）→ ${agentRun.outcome}`)

  console.log(`\nM4 end-to-end OK (${steps.length} steps); the fake model served ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  process.exitCode = 1
} finally {
  await rpc('emulators/settings/set', { manualAddress: before?.manualAddress ?? null }).catch(() => {})
  await removeFakeProvider(rpc)
  if (!keep) {
    for (const id of [PIPELINE, DRAFT]) await rpc('pipelines/remove', { id }).catch(() => {})
    for (const id of [ADB, DESK]) await rpc('scripts/remove', { id }).catch(() => {})
    for (const s of [emu, desk]) {
      rmSync(s.packDir, { recursive: true, force: true })
      rmSync(s.dir, { recursive: true, force: true, maxRetries: 5 })
    }
    for (const id of [ADB, DESK]) rmSync(join(dataDir, 'configs', id), { recursive: true, force: true })
  } else {
    // Keep things to look at, but not on a timetable.
    const p = await rpc('pipelines/get', { id: PIPELINE }).catch(() => undefined)
    if (p !== undefined) await rpc('pipelines/save', { pipeline: { ...p, schedule: { ...p.schedule, enabled: false } } }).catch(() => {})
  }
  gateway.close()
  await llm.close()
}
