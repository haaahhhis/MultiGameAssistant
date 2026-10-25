#!/usr/bin/env node
/**
 * End-to-end check of M2 against a running gateway, with no network, no API
 * key and no game: a copy of node.exe stands in for a script's program and
 * plays a test-kit scenario.
 *
 * 1. The agent sees the new tools, the analysis skill and the skills repository
 *    (script skills are downloaded from it, not shipped).
 * 2. A local "script" directory is imported; the fake model analyzes it and
 *    proposes a Script Pack; the draft is accepted through `packs@1`.
 * 3. The agent runs the pack's config-driven task (`script_run`, wait): the
 *    config is patched during the run and restored after; the log file's
 *    `done` line ends it; the run succeeds.
 * 3a. A task that needs the emulator (`adb`) runs through the real emulator
 *    service with a manual ADB address: its address is patched into the
 *    config during the run (M2 real-device step 6 failed exactly here).
 * 4. The agent tries to write into the script directory: the guard refuses.
 * 5. The agent changes a declared config value with `script_config_set`: the
 *    local config copy changes, the original project config does not.
 *
 * Everything it creates is removed afterwards.
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host          # in another terminal
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e:run
 */
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const ID = 'e2e-fake-tool'
const dataDir = process.env.ADG_DATA_DIR ?? join(process.env.DSH_HOME ?? join(here, '..', '.dev-home'), 'adg', 'data')

// ── a script directory: FakeTool.exe (node), its scenario, a config, a log dir ──
const dir = mkdtempSync(join(tmpdir(), 'adg-e2e-tool-'))
copyFileSync(process.execPath, join(dir, 'FakeTool.exe'))
mkdirSync(join(dir, 'app'))
copyFileSync(join(here, '..', 'packages', 'test-kit', 'lib', 'fake-script-cli.js'), join(dir, 'app', 'fake-script-cli.js'))
copyFileSync(join(here, '..', 'packages', 'test-kit', 'lib', 'fake-script.js'), join(dir, 'app', 'fake-script.js'))
writeFileSync(join(dir, 'app', 'package.json'), '{"type":"module"}')
mkdirSync(join(dir, 'config'))
mkdirSync(join(dir, 'debug'))
const CONFIG = '{\n    "Settings": {\n        "Run.Directly": false,\n        "Stage": "1-7"\n    }\n}\n'
writeFileSync(join(dir, 'config', 'settings.json'), CONFIG)
writeFileSync(join(dir, 'daily.json'), JSON.stringify({
  steps: [
    { log: '开始运行' },
    { logFile: 'debug/run.log', line: '[INFO] 读取配置' },
    { sleepMs: 1500 },
    { logFile: 'debug/run.log', line: '[INFO] 全部任务完成' },
    { sleepMs: 60_000 },
  ],
}))

const MANIFEST = `id: ${ID}
name: E2E 假工具
family: gui-config
config:
  files:
    - path: config/settings.json
      format: json
detect:
  files: [FakeTool.exe, daily.json]
launch:
  exe: FakeTool.exe
  args: ['app/fake-script-cli.js']
  stopAfterDone: true
  stopGraceSeconds: 1
tasks:
  - id: daily
    title: 日常
    utterances: [跑日常]
    args: ['daily.json']
    patches:
      - file: config/settings.json
        set:
          - path: [Settings, Run.Directly]
            value: true
    success: done-log
  - id: android
    title: 模拟器任务
    args: ['daily.json']
    patches:
      - file: config/settings.json
        set:
          - path: [Settings, Connect.Address]
            value: '{adb}'
    resources: { input: adb, emulator: mumu }
    success: done-log
logs:
  sources:
    - stdout: true
    - path: debug/run.log
  rules:
    - { match: '全部任务完成', level: done }
`
const SKILL = '---\nname: e2e-fake-tool\ndescription: E2E 假工具，用于端到端检查。\n---\n\n# E2E 假工具\n\n任务 daily：跑日常。\n'

const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'
const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] })
const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  replies: [
    call('script_analyze', { id: ID }), { text: '分析完成。' },
    call('pack_propose', { pack_id: ID, script_id: ID, manifest: MANIFEST, skill: SKILL, summary: '根据目录结构和日志写的脚本包。' }), { text: '草稿已提交。' },
    call('script_run', { id: ID, task: 'daily', wait: true }), { text: '运行结束。' },
    call('write', { file_path: join(dir, 'config', 'hacked.txt'), content: 'x' }), { text: '被拦截了。' },
    call(SHELL, { description: 'try', command: `Set-Content "${join(dir, 'app', 'evil.txt')}" x` }), { text: '也被拦截了。' },
    call('script_config_set', { id: ID, file: 'config/settings.json', path: ['Settings', 'Stage'], value_json: '"CE-6"' }), { text: '已修改。' },
  ],
  fallback: { text: '好的。' },
  scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
})

const gateway = await connectGateway({ name: 'adg-e2e-run' })
const { call: rpc, waitFor } = gateway
const steps = []
const step = (name, detail = '') => {
  steps.push(name)
  console.log(`✔ ${name}${detail === '' ? '' : `: ${detail}`}`)
}
const fail = message => { throw new Error(message) }

try {
  for (const cap of ['scripts', 'runs', 'emulators', 'guard', 'packs']) if (!gateway.capabilities.includes(cap)) fail(`capability ${cap} missing; rebuild and restart pnpm dev:host`)
  await saveFakeProvider(rpc, `${llm.url}/v1`)
  const imported = await rpc('scripts/import', { path: dir, id: ID, name: 'E2E 假工具' })
  step('import the script directory', `${imported.id} (pack: ${imported.packId ?? 'none'})`)

  const { sessionId } = await rpc('sessions/create', {})
  const opened = await rpc('session/open', { sessionId })
  for (let attempt = 0; ; attempt++) {
    if (await rpc('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false)) break
    if (attempt > 20) fail('fake model route never registered')
    await delay(250)
  }
  const toolResult = () => waitFor(m => m.method === 'session/event' && m.params.subscriptionId === opened.subscriptionId && m.params.event.type === 'tool/result', 'a tool result', 120_000)
  const turnEnd = () => waitFor(m => m.method === 'session/event' && m.params.subscriptionId === opened.subscriptionId && m.params.event.type === 'turn/end', 'turn end', 120_000)
  const ask = async text => {
    const result = toolResult()
    const end = turnEnd()
    await rpc('session/prompt', { sessionId, requestId: `e2e-run-${Date.now()}-${Math.random()}`, text, mode: 'queue' })
    const event = (await result).event
    await end
    return { error: event.isError === true, text: event.content?.map(c => c.text ?? '').join('') ?? '' }
  }

  const first = llm.requests.length
  const analyzed = await ask('分析一下这个脚本')
  if (analyzed.error) fail(`script_analyze failed: ${analyzed.text}`)
  const offered = llm.requests[first]?.tools?.map(t => t.function?.name) ?? []
  for (const name of ['script_run', 'script_tasks', 'script_analyze', 'pack_propose', 'script_config_set', 'script_profiles', 'emulator_status', 'skill_hub_list']) if (!offered.includes(name)) fail(`tool ${name} not offered`)
  step('agent tools offered', offered.filter(n => /^(script|pack|emulator)_/.test(n)).length + ' script/pack/emulator tools')
  const prompt = JSON.stringify(llm.requests[first]?.messages ?? [])
  if (!prompt.includes('script-analysis')) fail('skill script-analysis not in the agent skill list')
  step('core skill visible to the agent; script skills come from the skills repository', 'script-analysis, skill_hub_list')
  if (!analyzed.text.includes('"suggestedFamily"')) fail(`unexpected analysis: ${analyzed.text.slice(0, 200)}`)
  step('script_analyze', /"suggestedFamily": "([^"]+)"/.exec(analyzed.text)?.[1] ?? '?')

  const proposed = await ask('生成脚本包')
  if (proposed.error) fail(`pack_propose failed: ${proposed.text}`)
  const drafts = await rpc('packs/drafts', { scriptId: ID })
  if (drafts.items.length !== 1) fail('draft not listed')
  await rpc('packs/accept', { packId: ID })
  const withPack = await rpc('scripts/get', { id: ID })
  if (withPack.packId !== ID) fail(`pack not attached: ${withPack.packId}`)
  step('draft proposed by the agent and accepted', `tasks: ${drafts.items[0].tasks.map(t => t.id).join(', ')}`)

  const configDuring = new Promise(resolve => {
    const timer = setInterval(() => {
      const text = readFileSync(join(dir, 'config', 'settings.json'), 'utf8')
      if (text.includes('"Run.Directly": true')) { clearInterval(timer); resolve(true) }
    }, 100)
    setTimeout(() => { clearInterval(timer); resolve(false) }, 20_000)
  })
  const ran = await ask('跑日常')
  if (ran.error) fail(`script_run failed: ${ran.text}`)
  const run = JSON.parse(ran.text)
  if (run.state !== 'succeeded') fail(`run ${run.state}: ${run.outcome}`)
  if (!(await configDuring)) fail('config was not patched during the run')
  if (readFileSync(join(dir, 'config', 'settings.json'), 'utf8') !== CONFIG) fail('config not restored after the run')
  step('agent ran the task', `${run.state} — ${run.outcome}; config patched during the run and restored`)

  const before = (await rpc('emulators/status', {})).settings
  await rpc('emulators/settings/set', { manualAddress: '127.0.0.1:5599' })
  try {
    const addressDuring = new Promise(resolve => {
      const timer = setInterval(() => {
        const text = readFileSync(join(dir, 'config', 'settings.json'), 'utf8')
        if (text.includes('"Connect.Address": "127.0.0.1:5599"')) { clearInterval(timer); resolve(true) }
      }, 100)
      setTimeout(() => { clearInterval(timer); resolve(false) }, 20_000)
    })
    const started = await rpc('runs/start', { scriptId: ID, taskId: 'android' })
    let info = started
    for (let i = 0; info.endedAt === undefined && i < 120; i++) {
      await delay(250)
      info = (await rpc('runs/list', { scriptId: ID })).items.find(r => r.id === started.id) ?? info
    }
    if (info.state !== 'succeeded') fail(`adb run ${info.state}: ${info.outcome}`)
    if (!info.resources.includes('adb:127.0.0.1:5599')) fail(`adb run did not lock the device: ${info.resources.join(', ')}`)
    if (!(await addressDuring)) fail('the ADB address was not patched into the config during the run')
    if (readFileSync(join(dir, 'config', 'settings.json'), 'utf8') !== CONFIG) fail('config not restored after the adb run')
    step('adb task through the emulator service', `${info.state}; address 127.0.0.1:5599 patched in and restored`)
  } finally {
    await rpc('emulators/settings/set', { manualAddress: before.manualAddress ?? null })
  }

  const wrote = await ask('写个文件试试')
  if (!wrote.error || !wrote.text.includes('已拦截')) fail(`write was not blocked: ${wrote.text}`)
  const shelled = await ask('用命令写')
  if (!shelled.error || !shelled.text.includes('已拦截')) fail(`shell write was not blocked: ${shelled.text}`)
  step('guard blocked file and shell writes into the script directory')

  const configured = await ask('把关卡改成 CE-6')
  if (configured.error) fail(`script_config_set failed: ${configured.text}`)
  if (readFileSync(join(dir, 'config', 'settings.json'), 'utf8') !== CONFIG) fail('script_config_set changed the original project config')
  const local = JSON.parse(readFileSync(join(dataDir, 'configs', ID, 'files', 'config', 'settings.json'), 'utf8'))
  if (local.Settings.Stage !== 'CE-6' || local.Settings['Run.Directly'] !== false) fail(`local config wrong: ${JSON.stringify(local)}`)
  step('script_config_set changed one value in the local copy only', 'local Settings.Stage = CE-6; original untouched')

  console.log(`\nM2 end-to-end OK (${steps.length} steps); the fake model served ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  process.exitCode = 1
} finally {
  await rpc('scripts/remove', { id: ID }).catch(() => {})
  await rpc('packs/reject', { packId: ID }).catch(() => {})
  // The accepted pack and the local config copy live in the data directory; take them out again.
  rmSync(join(dataDir, 'packs', ID), { recursive: true, force: true })
  rmSync(join(dataDir, 'configs', ID), { recursive: true, force: true })
  await removeFakeProvider(rpc)
  gateway.close()
  await llm.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}
