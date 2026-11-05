import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '@adg/pack-schema'
import type { Incident, ScriptInfo } from '@adg/protocol'
import { Runner, type EmulatorBridge } from '@adg/runner'
import { DEFAULT_SETTINGS, DEFAULT_STALL_SECONDS, Monitor, type IncidentStore, type InterventionPort, type MonitorNotice } from '../src/monitor.ts'

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
  // Wait until the sample has printed all its lines (a fixed delay is flaky when the machine is busy).
  for (let i = 0, last = -1; i < 100; i++) {
    await new Promise(resolve => setTimeout(resolve, 150))
    const count = runner.logs(run.id, 5000).length
    if (count === last && monitor.incidents().length > 0) break
    last = count
  }
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

test('stopping a run while the agent handles it: the agent is called off, the incident closes, nothing is pushed or restarted', async () => {
  const pack = MAA.replace(/recovery:[\s\S]*$/, '').replace("resources: { input: adb }", 'resources: { input: none }')
  const steps = { steps: [{ logFile: 'debug/gui.log', line: '[ERR] 重连失败，连接断开！' }, { sleepMs: 60_000 }] }
  const cancelled: string[] = []
  let callOff: (() => void) | undefined
  const port: InterventionPort = {
    // The agent works until it is called off.
    handle: () => new Promise(resolve => { callOff = () => resolve({ state: 'taken-over', summary: '已停止', paused: false }) }),
    countToday: () => 0,
    resumeRun: async () => true,
    cancel: (incidentId, why) => { cancelled.push(why); callOff?.() },
  }
  const { runner, monitor, notices } = setup(pack, { 'daily.json': steps }, port)
  await monitor.start(0)
  const run = await runner.start('maa', 'daily')
  while (callOff === undefined) await new Promise(resolve => setTimeout(resolve, 20))
  await runner.stop(run.id, '流水线「日常」已取消')
  await runner.finished(run.id)
  await monitor.idle()
  const incident = monitor.incidents({ status: 'all' })[0]!
  assert.equal(incident.status, 'resolved')
  assert.match(incident.resolution ?? '', /运行已被停止/)
  assert.deepEqual(cancelled, ['停止'], 'the agent was called off as soon as the run was stopped')
  assert.equal(notices.length, 0, 'nothing pushed about a run the user stopped')
  assert.equal(runner.list().filter(r => r.retryOf === run.id).length, 0, 'not restarted')
  await assert.rejects(runner.restart(run.id, '自动重启'), /不再重新运行/)
  monitor.stop()
})

test("a desktop task's screenshot brings its hidden windows forward first; when that fails, the desktop as it is", async () => {
  const pack = MAA.replace(/recovery:[\s\S]*$/, '').replace("resources: { input: adb }", 'resources: { input: none }').replace('success: done-log', 'success: exit-code')
  const steps = { steps: [{ logFile: 'debug/gui.log', line: '开始任务' }, { sleepMs: 100 }, { exit: 3 }] }
  const seen: Array<Buffer | undefined> = []
  const port = (capture: InterventionPort['captureDesktop']): InterventionPort => ({
    handle: async (_incident, _mode, shot) => { seen.push(shot); return { state: 'gave-up', summary: '处理不了', paused: false } },
    countToday: () => 0,
    resumeRun: async () => false,
    ...(capture === undefined ? {} : { captureDesktop: capture }),
  })
  const asked: string[] = []
  const raised = setup(pack, { 'daily.json': steps }, port(async runId => { asked.push(runId); return { png: Buffer.from('raised'), raised: ['错误'], hidden: ['管理员窗口'] } }))
  await raised.monitor.start(0)
  const run = await raised.runner.finished((await raised.runner.start('maa', 'daily')).id)
  await raised.monitor.idle()
  assert.deepEqual(asked, [run.id])
  const incident = raised.monitor.incidents({ status: 'all' })[0]!
  assert.equal(raised.shots.get(incident.id)?.toString(), 'raised')
  assert.equal(seen[0]?.toString(), 'raised', 'the agent gets the same picture')
  assert.match(incident.steps.find(s => s.action === 'screenshot')!.detail, /已截取桌面（先把被挡住的「错误」提到了最前；「管理员窗口」还被挡着/)
  raised.monitor.stop()

  const failing = setup(pack, { 'daily.json': steps }, port(async () => { throw new Error('桌面助手没能启动') }))
  await failing.monitor.start(0)
  await failing.runner.finished((await failing.runner.start('maa', 'daily')).id)
  await failing.monitor.idle()
  const plain = failing.monitor.incidents({ status: 'all' })[0]!
  assert.equal(failing.shots.get(plain.id)?.toString(), 'desktop')
  assert.equal(plain.steps.find(s => s.action === 'screenshot')!.detail, '已截取桌面')
  failing.monitor.stop()
})

test('a failed run stays held while its incident is open (the pipeline waits); the task run again meanwhile is its next attempt, and its success settles it', async () => {
  const pack = MAA.replace(/recovery:[\s\S]*$/, '').replace("resources: { input: adb }", 'resources: { input: none }').replace('success: done-log', 'success: exit-code')
  const cancelled: string[] = []
  const intervene: InterventionPort = {
    handle: async () => ({ state: 'gave-up', summary: '账号登录过期，要主人登录', paused: false }),
    countToday: () => 0,
    resumeRun: async () => false,
    cancel: (id, why, summary) => { cancelled.push(`${id}:${why}:${summary ?? ''}`) },
  }
  const { dir, runner, monitor, notices } = setup(pack, { 'daily.json': { steps: [{ logFile: 'debug/gui.log', line: '开始任务' }, { exit: 3 }] } }, intervene)
  await monitor.configure({ intervene: 'act' })
  await monitor.start(0)
  const first = await runner.finished((await runner.start('maa', 'daily')).id)
  await monitor.idle()
  const [incident] = monitor.incidents()
  assert.equal(notices.length, 1, 'the agent gave up: the user is told')
  assert.equal(runner.held(first.id), true, 'not let go on a timer: the next pipeline step must not start')

  // The agent (or the user) logs in and runs the task again by hand.
  writeFileSync(join(dir, 'daily.json'), JSON.stringify({ steps: [{ exit: 0 }] }))
  const again = await runner.start('maa', 'daily')
  assert.equal(again.retryOf, first.id, 'the next attempt of the held run')
  const done = await runner.finished(again.id)
  await monitor.idle()
  assert.equal(done.state, 'succeeded')
  const settled = monitor.incident(incident!.id)
  assert.equal(settled.status, 'resolved')
  assert.match(settled.resolution ?? '', /重新运行后成功/)
  assert.equal(runner.held(first.id), false)
  assert.equal((await runner.successor(first.id))?.id, again.id, 'a pipeline waiting on the failed run follows the new one')
  assert.equal(cancelled.length, 1, 'an agent still about to handle it is called off')
  assert.match(cancelled[0]!, /不用再处理/)
  monitor.stop()
})


test('no new log line for the default 30 seconds: stalled, and to the agent; the stall time says where it came from', async () => {
  const pack = MAA.replace(/recovery:[\s\S]*$/, '').replace("resources: { input: adb }", 'resources: { input: none }')
  const { runner, monitor, later } = setup(pack, { 'daily.json': { steps: [{ logFile: 'debug/gui.log', line: '开始任务' }, { sleepMs: 60_000 }] } })
  await monitor.start(0)
  assert.equal(DEFAULT_SETTINGS.defaultStallSeconds, DEFAULT_STALL_SECONDS)
  assert.equal(DEFAULT_STALL_SECONDS, 30)
  assert.deepEqual(monitor.stallFor('maa'), { seconds: 30, source: 'default' })
  const run = await runner.start('maa', 'daily')
  for (let i = 0; i < 100 && !runner.logs(run.id).some(l => l.text.includes('开始任务')); i++) await new Promise(r => setTimeout(r, 50))
  later(20_000)
  monitor.tick()
  assert.equal(monitor.incidents().length, 0, 'quiet for 20 s is fine')
  later(15_000)
  monitor.tick()
  const [stalled] = monitor.incidents()
  assert.equal(stalled?.kind, 'stalled')
  assert.match(stalled?.detail ?? '', /已经 3\d 秒没有新的日志，可能卡住了（这个脚本超过 30 秒没动静就算卡住，默认值）/)
  await runner.stop(run.id)
  await monitor.idle()
  monitor.stop()
})

test("each script learns its own stall time from its clean runs; the agent can set one after reading the rhythm, and clear it", async () => {
  const pack = MAA.replace(/recovery:[\s\S]*$/, '').replace("resources: { input: adb }", 'resources: { input: none }').replace('success: done-log', 'success: exit-code')
  const { runner, monitor } = setup(pack, { 'daily.json': { steps: [{ logFile: 'debug/gui.log', line: '开始' }, { sleepMs: 1600 }, { logFile: 'debug/gui.log', line: '还在' }, { sleepMs: 200 }, { exit: 0 }] } })
  await monitor.start(0)
  await monitor.configure({ defaultStallSeconds: 1 })
  const run = await runner.finished((await runner.start('maa', 'daily')).id)
  await monitor.idle()
  assert.equal(run.state, 'succeeded')
  const learned = monitor.stallFor('maa')
  assert.equal(learned.source, 'script')
  assert.equal(learned.entry?.by, 'learned')
  assert.equal(learned.seconds, Math.ceil(learned.entry!.samples.at(-1)! * 1.5), '1.5 × its longest quiet stretch')
  assert.ok(learned.seconds >= 2)

  const rhythm = await monitor.rhythm('maa')
  assert.equal(rhythm.runs[0]?.id, run.id)
  assert.ok((rhythm.runs[0]?.longestQuietSeconds ?? 0) >= 1)
  assert.equal(rhythm.suggestedSeconds, Math.max(1, Math.ceil(rhythm.runs[0]!.longestQuietSeconds * 1.5)))

  assert.deepEqual(await monitor.setStall('maa', 90, 'agent', '战斗时最长 60 秒不输出'), { seconds: 90, source: 'script' })
  await runner.finished((await runner.start('maa', 'daily')).id)
  await monitor.idle()
  assert.equal(monitor.stallFor('maa').seconds, 90, "the agent's value stays; later runs only add samples")
  assert.equal(monitor.stallFor('maa').entry?.samples.length, 2)
  assert.deepEqual(await monitor.setStall('maa', null, 'agent'), { seconds: 1, source: 'default' })
  monitor.stop()
})
