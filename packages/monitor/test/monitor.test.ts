import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '@adg/pack-schema'
import type { Incident, ScriptInfo } from '@adg/protocol'
import { Runner, type EmulatorBridge } from '@adg/runner'
import { Monitor, type IncidentStore, type InterventionPort, type MonitorNotice } from '../src/monitor.ts'

const CLI = fileURLToPath(new URL('../../test-kit/src/fake-script-cli.ts', import.meta.url))
const SAMPLES = fileURLToPath(new URL('./samples/', import.meta.url))

/** Turn a sample log into a scenario that appends it to `logFile`, one line every few ms. */
function replay(sample: string, logFile: string, tail: unknown[] = []): unknown {
  const steps: unknown[] = []
  let target = steps
  for (const line of readFileSync(join(SAMPLES, sample), 'utf8').split(/\r?\n/)) {
    if (line === '' || line.startsWith('#')) continue
    if (line === '@once') { const once: unknown[] = []; steps.push({ once: 'debug/.once', steps: once }); target = once; continue }
    if (line === '@end') { target = steps; continue }
    target.push(logFile === 'stdout' ? { log: line } : { logFile, line }, { sleepMs: 20 })
  }
  return { steps: [...steps, ...tail] }
}

const MAA = `
id: maa
name: MAA
launch: { exe: MAA.exe, stopAfterDone: true, stopGraceSeconds: 0 }
tasks:
  - id: daily
    title: 日常
    args: ['daily.json']
    resources: { input: adb }
    success: done-log
logs:
  sources: [{ path: debug/gui.log }]
  rules:
    - { match: '任务已全部完成', level: done }
    - { match: '重连失败，连接断开', level: error, tag: adb-disconnected }
    - { match: '模拟器断开，正在尝试重连', level: warning, tag: adb-reconnecting }
    - { match: '截图失败', level: warning, tag: screencap-failed }
recovery:
  - { on: adb-disconnected, do: reconnect-adb }
  - { on: adb-disconnected, do: restart }
`

function setup(pack: string, files: Record<string, unknown>, intervene?: InterventionPort) {
  const dir = mkdtempSync(join(tmpdir(), 'adg-mon-'))
  mkdirSync(join(dir, 'debug'))
  writeFileSync(join(dir, 'MAA.exe'), 'MZ')
  for (const [name, value] of Object.entries(files)) writeFileSync(join(dir, name), JSON.stringify(value))
  const manifest = parseManifest(pack)
  const reconnects: string[] = []
  const bridge: EmulatorBridge = {
    prepare: async () => ({ address: '127.0.0.1:16384', label: 'MuMu 0' }),
    reconnect: async address => { reconnects.push(address); return `已重新连接 ${address}` },
    screencap: async () => Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]),
  }
  const runner = new Runner({
    library: {
      get: id => ({ id, name: manifest.name, source: { kind: 'local', path: dir }, dir, versions: [], addedAt: 0 }) as ScriptInfo,
      packOf: () => ({ manifest }),
    },
    dataDir: mkdtempSync(join(tmpdir(), 'adg-mon-data-')),
    emulators: () => bridge,
    onState: () => {},
    onLog: () => {},
    command: (_exe, args) => ({ file: process.execPath, args: [CLI, ...args] }),
    log: { info() {}, warn() {} },
    pollMs: 50,
  })
  const notices: MonitorNotice[] = []
  const updates: { id: string; done?: string }[] = []
  let offset = 0
  const shots = new Map<string, Buffer>()
  const store: IncidentStore = {
    load: async () => ({ incidents: [], settings: {} }),
    saveIncidents: async () => {},
    saveSettings: async () => {},
    saveScreenshot: async (id, png) => { shots.set(id, png) },
    readScreenshot: async id => shots.get(id),
  }
  const monitor = new Monitor({
    ...(intervene === undefined ? {} : { intervene: () => intervene }),
    runner,
    packOf: () => ({ manifest }),
    emulators: () => bridge,
    notices: () => ({
      send: async notice => { notices.push(notice); return ['飞书'] },
      update: async (id, patch) => { updates.push({ id, ...patch }) },
    }),
    desktopScreenshot: async () => Buffer.from('desktop'),
    store,
    onIncident: () => {},
    now: () => Date.now() + offset,
    log: { info() {}, warn() {} },
  })
  return { dir, runner, monitor, notices, updates, reconnects, shots, later: (ms: number) => { offset += ms } }
}

async function settle(runner: Runner, monitor: Monitor, runId: string) {
  let run = await runner.finished(runId)
  await monitor.idle()
  // Follow restarts to the end of the chain.
  for (;;) {
    const next = runner.list().find(r => r.retryOf === run.id)
    if (next === undefined) return run
    run = await runner.finished(next.id)
    await monitor.idle()
  }
}

const byTag = (incidents: Incident[], tag: string) => incidents.find(i => i.tag === tag)

test('MAA drops the emulator: L0 reconnects ADB, restarts the task, the restart succeeds and settles everything', async () => {
  const { runner, monitor, notices, reconnects } = setup(MAA, { 'daily.json': replay('maa-adb-disconnect.log', 'debug/gui.log', [{ sleepMs: 60_000 }]) })
  await monitor.start(0)
  const first = await runner.start('maa', 'daily')
  const last = await settle(runner, monitor, first.id)
  assert.equal(last.state, 'succeeded', last.outcome)
  assert.equal(last.retryOf, first.id)
  assert.equal(runner.get(first.id).state, 'cancelled')
  assert.match(runner.get(first.id).outcome ?? '', /已重启/)

  const incidents = monitor.incidents({ status: 'all' })
  const dropped = byTag(incidents, 'adb-disconnected')!
  assert.equal(dropped.kind, 'error')
  assert.deepEqual(dropped.steps.map(s => [s.action, s.ok]), [['reconnect-adb', true], ['restart', true]])
  assert.deepEqual(reconnects, ['127.0.0.1:16384'])
  assert.equal(dropped.status, 'resolved')
  assert.match(dropped.resolution ?? '', /重新运行后成功/)
  assert.equal(byTag(incidents, 'adb-reconnecting')?.kind, 'warning', 'MAA retrying by itself is only a warning')
  assert.equal(byTag(incidents, 'screencap-failed')?.status, 'resolved')
  assert.equal(notices.length, 0, 'what L0 fixed is not pushed')
  assert.ok(dropped.lines.some(l => l.includes('重连失败')), 'the incident keeps the log tail')
  monitor.stop()
})

test('an unknown failure is pushed with a screenshot and retry / ignore; retry runs the task again', async () => {
  const pack = MAA.replace(/recovery:[\s\S]*$/, '').replace("resources: { input: adb }", 'resources: { input: none }').replace('success: done-log', 'success: exit-code')
  const { runner, monitor, notices, shots } = setup(pack, { 'daily.json': { steps: [{ logFile: 'debug/gui.log', line: '开始任务' }, { sleepMs: 100 }, { exit: 3 }] } })
  await monitor.start(0)
  const run = await runner.finished((await runner.start('maa', 'daily')).id)
  await monitor.idle()
  assert.equal(run.state, 'failed')
  const [incident] = monitor.incidents()
  assert.equal(incident?.kind, 'failed')
  assert.equal(notices.length, 1)
  assert.deepEqual(notices[0]!.actions.map(a => a.id), ['retry', 'resolve'], 'no stop button: the run already ended')
  assert.equal(notices[0]!.image?.toString(), 'desktop', 'a task without an emulator gets a desktop screenshot')
  assert.ok(shots.has(incident!.id) && incident!.screenshot)
  assert.match(incident!.steps.at(-1)!.detail, /已推送（飞书）/)

  const acted = await monitor.act(incident!.id, 'retry', { by: 'user', name: '张三' })
  assert.equal(acted.status, 'resolved')
  assert.match(acted.resolution ?? '', /已重新运行（张三）/)
  const retried = runner.list().find(r => r.retryOf === run.id)!
  await runner.finished(retried.id)
  monitor.stop()
})

test('a stalled run is pushed with a stop button; stopping it from the notice ends the run and the incident', async () => {
  const pack = MAA.replace(/recovery:[\s\S]*$/, '').replace("resources: { input: adb }", 'resources: { input: desktop }').replace('  sources: [{ path: debug/gui.log }]', '  stallAfter: 10m\n  sources: [{ stdout: true }]')
  const { runner, monitor, notices, updates, later } = setup(pack, { 'daily.json': replay('march7th-stuck.log', 'stdout', [{ sleepMs: 60_000 }]) })
  await monitor.start(0)
  const run = await runner.start('maa', 'daily')
  await new Promise(resolve => setTimeout(resolve, 400))
  monitor.tick()
  assert.equal(monitor.incidents().filter(i => i.kind === 'stalled').length, 0, 'not stalled yet')
  assert.equal(monitor.incidents()[0]?.tag, 'screencap-failed', 'the sample has a 截图失败 line, a warning')
  later(11 * 60_000)
  monitor.tick()
  await monitor.idle()
  const stalled = monitor.incidents().find(i => i.kind === 'stalled')!
  assert.match(stalled.detail, /11 分钟没有新的日志/)
  assert.ok(runner.get(run.id).warnings.some(w => /可能卡住了/.test(w)))
  assert.deepEqual(notices.map(n => n.actions.map(a => a.id)), [['stop', 'retry', 'resolve']])
  monitor.tick()
  assert.equal(monitor.incidents().filter(i => i.kind === 'stalled').length, 1, 'raised once')

  await monitor.act(stalled.id, 'stop', { by: 'user', name: '飞书用户' })
  const ended = await runner.finished(run.id)
  assert.equal(ended.state, 'cancelled')
  assert.match(ended.outcome ?? '', /按异常处理停止（飞书用户）/)
  assert.equal(monitor.incident(stalled.id).status, 'resolved')
  assert.deepEqual(updates.at(-1), { id: stalled.id, done: '已停止（飞书用户）' }, 'the card is updated')
  await assert.rejects(monitor.act(stalled.id, 'stop'), /已经结束/)
  monitor.stop()
})

test('recovery stops at its limit and then hands over: the push says what was tried', async () => {
  const pack = MAA.replace(/recovery:[\s\S]*$/, 'recovery:\n  - { on: failed, do: restart, max: 1 }\n').replace("resources: { input: adb }", 'resources: { input: none }').replace('success: done-log', 'success: exit-code')
  const { runner, monitor, notices } = setup(pack, { 'daily.json': { steps: [{ log: 'boom' }, { exit: 2 }] } })
  await monitor.start(0)
  const first = await runner.start('maa', 'daily')
  const last = await settle(runner, monitor, first.id)
  assert.equal(last.state, 'failed')
  assert.equal(last.retryOf, first.id, 'restarted once')
  const incidents = monitor.incidents({ status: 'all' })
  assert.equal(incidents.length, 2)
  assert.equal(notices.length, 1, 'only the second failure is pushed')
  assert.match(notices[0]!.text, /重新运行已用过 1 次（上限 1）/)
  monitor.stop()
})

test('an error line the script recovers from on its own still ends with a done line: the run succeeds', async () => {
  const pack = MAA.replace(/recovery:[\s\S]*$/, '')
  const { runner, monitor, notices } = setup(pack, {
    'daily.json': { steps: [{ logFile: 'debug/gui.log', line: '重连失败，连接断开！' }, { sleepMs: 200 }, { logFile: 'debug/gui.log', line: '任务已全部完成！' }, { sleepMs: 60_000 }] },
  })
  await monitor.start(0)
  const run = await runner.finished((await runner.start('maa', 'daily')).id)
  await monitor.idle()
  assert.equal(run.state, 'succeeded', run.outcome)
  assert.equal(notices.length, 1, 'the error was still worth telling')
  assert.equal(notices[0]!.image?.[0], 0x89, 'an adb task gets the emulator screenshot')
  monitor.stop()
})

test('L1/L2: what L0 leaves goes to the agent first; fixed is not pushed, given up is pushed with its summary and a 继续 button', async () => {
  const pack = MAA.replace(/recovery:[\s\S]*$/, '').replace("resources: { input: adb }", 'resources: { input: none }')
  const steps = { steps: [{ logFile: 'debug/gui.log', line: '[ERR] 重连失败，连接断开！' }, { sleepMs: 60_000 }] }
  const handled: string[] = []
  const resumed: string[] = []
  let answer: Awaited<ReturnType<InterventionPort['handle']>> = { state: 'resolved', summary: '点了「重新连接」，游戏恢复了', paused: false }
  let today = 0
  const port: InterventionPort = {
    handle: async (incident, mode, shot) => { handled.push(`${incident.tag}:${mode}:${shot === undefined ? 'no-shot' : 'shot'}`); today++; return answer },
    countToday: () => today,
    resumeRun: async runId => { resumed.push(runId); return true },
  }
  const fixed = setup(pack, { 'daily.json': steps }, port)
  await fixed.monitor.start(0)
  const run1 = await fixed.runner.start('maa', 'daily')
  await new Promise(resolve => setTimeout(resolve, 800))
  await fixed.monitor.idle()
  assert.deepEqual(handled, ['adb-disconnected:act:shot'], 'with the incident screenshot')
  const first = fixed.monitor.incidents({ status: 'all' })[0]!
  assert.equal(first.status, 'resolved')
  assert.match(first.resolution ?? '', /agent 已处理：点了「重新连接」/)
  assert.equal(fixed.notices.length, 0, 'fixed: nothing pushed')
  await fixed.runner.stop(run1.id)
  fixed.monitor.stop()

  answer = { state: 'gave-up', summary: '要输入验证码，交给你', paused: true, image: Buffer.from('agent-shot') }
  const gaveUp = setup(pack, { 'daily.json': steps }, port)
  await gaveUp.monitor.start(0)
  const run2 = await gaveUp.runner.start('maa', 'daily')
  await new Promise(resolve => setTimeout(resolve, 800))
  await gaveUp.monitor.idle()
  const notice = gaveUp.notices[0]!
  assert.deepEqual(notice.actions.map(a => a.id), ['resume', 'stop', 'retry', 'resolve'])
  assert.match(notice.text, /agent 看过了：要输入验证码，交给你/)
  assert.equal(notice.image?.toString(), 'agent-shot', 'with the agent\'s latest screenshot')
  const incident = gaveUp.monitor.incidents()[0]!
  await gaveUp.monitor.act(incident.id, 'resume', { by: 'user', name: '我' })
  assert.deepEqual(resumed, [run2.id])
  assert.equal(gaveUp.monitor.incident(incident.id).resolution, '已继续（我）')
  await gaveUp.runner.stop(run2.id)
  gaveUp.monitor.stop()

  today = 99
  const capped = setup(pack, { 'daily.json': steps }, port)
  await capped.monitor.start(0)
  const run3 = await capped.runner.start('maa', 'daily')
  await new Promise(resolve => setTimeout(resolve, 800))
  await capped.monitor.idle()
  assert.equal(handled.length, 2, 'over the daily cap: the agent is not called')
  assert.match(capped.monitor.incidents()[0]!.steps.map(s => s.detail).join(' '), /今天的 agent 处理次数（10）已用完/)
  assert.equal(capped.notices.length, 1)
  await capped.runner.stop(run3.id)
  capped.monitor.stop()
})
