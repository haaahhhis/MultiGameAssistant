import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { test } from 'node:test'
import { Pipeline, type PipelineRun, type PipelineTrigger } from '@adg/protocol'
import { Power, type AwakeLevel, type PowerNotice, type SleepAction } from '../src/power.ts'
import { Scheduler, WAKE_LEAD_MS, type AutostartPort } from '../src/scheduler.ts'
import { localIso, wakeTaskXml, windowsPower, windowsWake, type WakePort } from '../src/windows.ts'

function setup(options: { nextSlot?: number } = {}) {
  let now = 1_000_000
  let activity: AwakeLevel | undefined
  const held: (AwakeLevel | undefined)[] = []
  const performed: SleepAction[] = []
  const sent: PowerNotice[] = []
  const updates: string[] = []
  const power = new Power({
    port: { hold: level => { held.push(level) }, perform: async action => { performed.push(action) } },
    activity: () => activity,
    nextSlot: () => options.nextSlot,
    countdownMs: () => 60_000,
    notices: () => ({ send: async n => { sent.push(n); return ['飞书'] }, update: async (id, p) => { updates.push(`${id} ${p.done}`) } }),
    changed: () => {},
    settleMs: 20_000,
    now: () => now,
    log: { info() {}, warn() {} },
  })
  // The clock for quiet time; countdowns are setTimeout (mocked in the tests that need them).
  const advance = async (ms: number) => {
    now += ms
    power.check()
    await new Promise(resolve => setImmediate(resolve))
  }
  return {
    power, held, performed, sent, updates, advance,
    busy: (level: AwakeLevel | undefined) => { activity = level; power.check() },
  }
}

const pipeline = (powerAfter: Pipeline['powerAfter']) => Pipeline.parse({ id: 'daily', name: '每日日常', nodes: [{ id: 'n', kind: 'notify', text: 'x' }], powerAfter })
const run = (kind: PipelineTrigger['kind'], state: PipelineRun['state'] = 'succeeded'): PipelineRun => ({
  id: 'pl-1', pipelineId: 'daily', pipelineName: '每日日常', trigger: { kind }, state, nodes: {}, startedAt: 0, endedAt: 1,
})

test('keeping awake follows what runs: the screen too for a desktop script, let go when it all ends', () => {
  const env = setup()
  env.busy('system')
  env.busy('system')
  env.busy('display')
  env.busy(undefined)
  assert.deepEqual(env.held, ['system', 'display', undefined])
  assert.equal(env.power.status().awake, false)
})

test('after an unattended run: wait for quiet, count down with a cancel button, then shut down', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const env = setup()
  env.busy('system') // a chained pipeline is still running
  env.power.pipelineEnded(run('schedule'), pipeline('shutdown'))
  assert.deepEqual(env.power.status().pending, { action: 'shutdown', pipelineName: '每日日常' })
  await env.advance(60_000)
  assert.equal(env.sent.length, 0, 'nothing while something runs')
  env.busy(undefined)
  await env.advance(10_000)
  assert.equal(env.sent.length, 0, 'not before the quiet time')
  await env.advance(11_000)
  assert.equal(env.sent.length, 1)
  assert.equal(env.sent[0]!.title, '60 秒后关机')
  assert.deepEqual(env.sent[0]!.actions, [{ id: 'cancel', label: '取消关机', style: 'danger' }])
  assert.ok(env.power.status().pending?.at !== undefined, 'counting down')
  t.mock.timers.tick(60_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(env.performed, ['shutdown'])
  assert.match(env.updates.at(-1)!, /正在关机$/)
  assert.equal(env.power.status().pending, undefined)
})

test('cancelled from a channel or the UI: nothing happens', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const env = setup()
  env.power.pipelineEnded(run('autostart'), pipeline('sleep'))
  await env.advance(21_000)
  assert.equal(env.sent.length, 1)
  assert.equal(env.power.cancel('飞书 小明'), true)
  assert.match(env.updates.at(-1)!, /已取消睡眠（飞书 小明）$/)
  t.mock.timers.tick(120_000)
  assert.deepEqual(env.performed, [])
  assert.equal(env.power.cancel('界面'), false, 'nothing left to cancel')
})

test('something starting during the countdown stops it; it counts down again once quiet', async t => {
  t.mock.timers.enable({ apis: ['setTimeout'] })
  const env = setup()
  env.power.pipelineEnded(run('after'), pipeline('hibernate'))
  await env.advance(21_000)
  env.busy('system')
  assert.match(env.updates.at(-1)!, /又有任务开始了/)
  assert.equal(env.power.status().pending?.at, undefined)
  t.mock.timers.tick(120_000)
  assert.deepEqual(env.performed, [], 'the old countdown does not fire')
  env.busy(undefined)
  await env.advance(21_000)
  assert.equal(env.sent.length, 2, 'a new countdown')
  t.mock.timers.tick(60_000)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(env.performed, ['hibernate'])
})

test('not after a run by hand, a cancelled run, or with no action; the stronger of two wins; skipped near a scheduled time', async () => {
  const env = setup()
  env.power.pipelineEnded(run('manual'), pipeline('shutdown'))
  env.power.pipelineEnded(run('schedule', 'cancelled'), pipeline('shutdown'))
  env.power.pipelineEnded(run('schedule'), pipeline('none'))
  assert.equal(env.power.status().pending, undefined)
  env.power.pipelineEnded(run('schedule'), pipeline('sleep'))
  env.power.pipelineEnded(run('schedule'), pipeline('shutdown'))
  env.power.pipelineEnded(run('schedule'), pipeline('hibernate'))
  assert.equal(env.power.status().pending?.action, 'shutdown')
  env.power.cancel('界面')

  const near = setup({ nextSlot: 1_000_000 + 21_000 + 10 * 60_000 })
  near.power.pipelineEnded(run('schedule'), pipeline('sleep'))
  await near.advance(21_000)
  assert.equal(near.sent[0]?.title, '这次不睡眠')
  assert.equal(near.power.status().pending, undefined)
})

test('the wake task: one-time triggers in local time that wake the computer and start the app quietly', () => {
  const xml = wakeTaskXml(['C:\\Program Files\\ADG\\AutoDailyGamePlay.exe', '--wake'], 'PC\\me', [new Date(2026, 9, 25, 4, 28).getTime(), new Date(2026, 9, 26, 4, 28).getTime()])
  assert.equal((xml.match(/<TimeTrigger>/g) ?? []).length, 2)
  assert.match(xml, /<StartBoundary>2026-10-25T04:28:00<\/StartBoundary>/)
  assert.match(xml, /<WakeToRun>true<\/WakeToRun>/)
  assert.match(xml, /<Command>C:\\Program Files\\ADG\\AutoDailyGamePlay.exe<\/Command>/)
  assert.match(xml, /<Arguments>--wake<\/Arguments>/)
  assert.equal(localIso(new Date(2026, 0, 2, 3, 4, 5).getTime()), '2026-01-02T03:04:05')
})

test('the scheduler keeps the wake-ups current: off removes them, on registers the next times early, unchanged is left alone', async () => {
  let now = new Date(2026, 9, 19, 3, 0).getTime()
  const calls: string[] = []
  let available = true
  const wake: WakePort = {
    available: () => available,
    status: async () => ({ registered: calls.at(-1)?.startsWith('sync') === true }),
    sync: async times => { calls.push(`sync ${times.map(t => new Date(t).toTimeString().slice(0, 5)).join(',')}`) },
    remove: async () => { calls.push('remove') },
  }
  const autostart: AutostartPort = { available: () => true, status: async () => ({ registered: false }), register: async () => {}, unregister: async () => {} }
  const daily = Pipeline.parse({ id: 'daily', name: 'daily', nodes: [{ id: 'n', kind: 'notify', text: 'x' }], schedule: { enabled: true, times: ['04:30', '16:30'] } })
  const scheduler = new Scheduler({
    pipelines: () => [daily], start: () => {}, isRunning: () => false, lastSuccessDay: () => undefined,
    store: { load: async () => ({}), save: async () => {} }, autostart, wake, autostarted: false, now: () => now, changed: () => {}, log: { info() {}, warn() {} },
  })
  await scheduler.start(0)
  await new Promise(resolve => setImmediate(resolve))
  assert.deepEqual(calls, ['remove'], 'off: nothing registered')
  await scheduler.configure({ wakeToRun: true })
  assert.equal(calls.length, 2)
  assert.ok(calls[1]!.startsWith('sync 04:28,16:28,04:28'), calls[1])
  assert.equal(WAKE_LEAD_MS, 2 * 60_000)
  now += 61_000
  scheduler.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(calls.length, 2, 'the same times are not registered again')
  now = new Date(2026, 9, 19, 4, 31).getTime()
  scheduler.tick()
  await new Promise(resolve => setImmediate(resolve))
  assert.ok(calls[2]!.startsWith('sync 16:28,04:28'), 'a passed time drops out')
  assert.equal((await scheduler.wakeStatus()).registered, true)
  await scheduler.configure({ wakeToRun: false })
  assert.equal(calls.at(-1), 'remove')

  available = false
  await assert.rejects(scheduler.configure({ wakeToRun: true }), /只有桌面版/)
  assert.equal(scheduler.settings.wakeToRun, false)
  scheduler.stop()
})

// Real Windows round trips: ADG_REAL_SCHTASKS=1 node --test packages/scheduler/test/power.test.ts
const real = { skip: process.env['ADG_REAL_SCHTASKS'] !== '1' || process.platform !== 'win32' }

test('real schtasks: the wake task registers, reads back its next time, and is removed', real, async () => {
  const name = `AutoDailyGamePlay-wake-test-${Date.now()}`
  const port = windowsWake({ command: [process.execPath, '--version', '--wake'], taskName: name })
  // Far enough ahead that it never fires during the test.
  const times = [Date.now() + 30 * 86_400_000, Date.now() + 31 * 86_400_000].map(t => Math.floor(t / 60_000) * 60_000)
  try {
    await port.sync(times)
    assert.deepEqual(await port.status(), { registered: true, next: times[0] })
    await port.sync(times.slice(1))
    assert.deepEqual(await port.status(), { registered: true, next: times[1] })
  } finally {
    await port.remove()
  }
  assert.deepEqual(await port.status(), { registered: false })
})

test('real keep-awake helper: Windows lists the request while held, and forgets it when let go', real, async t => {
  const exec = promisify(execFile)
  const requests = async () => (await exec('powercfg.exe', ['/requests'], { windowsHide: true })).stdout
  try { await requests() } catch { return } // powercfg /requests needs an elevated prompt
  const warnings: string[] = []
  const port = windowsPower({ log: { warn: m => warnings.push(m) } })
  port.hold('display')
  let seen = ''
  t.after(() => port.hold(undefined))
  for (let i = 0; i < 20 && !/powershell/i.test(seen); i++) { await new Promise(r => setTimeout(r, 500)); seen = await requests() }
  assert.match(seen, /DISPLAY:\s*\r?\n(?:.*\r?\n)*?.*powershell/i, seen)
  port.hold(undefined)
  for (let i = 0; i < 20 && /powershell/i.test(seen); i++) { await new Promise(r => setTimeout(r, 500)); seen = await requests() }
  assert.doesNotMatch(seen, /powershell/i)
  assert.deepEqual(warnings, [])
})
