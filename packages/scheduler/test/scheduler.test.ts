// A zone with DST, before any Date is made: China has none to test against.
process.env.TZ = 'America/New_York'

import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { Pipeline, type PipelineRun, type PipelineTrigger } from '@adg/protocol'
import { joinArgs, taskXml, windowsAutostart } from '../src/autostart.ts'
import { Scheduler, slotsBetween, type AutostartPort, type SavedState } from '../src/scheduler.ts'

const at = (y: number, mo: number, d: number, h: number, mi: number, s = 0) => new Date(y, mo - 1, d, h, mi, s).getTime()

function setup(pipelines: Pipeline[], options: { saved?: Partial<SavedState>; autostarted?: boolean; lastSuccess?: string; running?: string[] } = {}) {
  let now = at(2026, 10, 19, 4, 0)
  const started: { id: string; trigger: PipelineTrigger; at: number }[] = []
  let saved: SavedState | undefined = options.saved as SavedState | undefined
  const registered: string[] = []
  const autostart: AutostartPort = {
    available: () => true,
    status: async () => ({ registered: registered.length > 0 }),
    register: async () => { registered.push('on') },
    unregister: async () => { registered.length = 0 },
  }
  const make = () => new Scheduler({
    pipelines: () => pipelines,
    start: (id, trigger) => { started.push({ id, trigger, at: now }) },
    isRunning: id => options.running?.includes(id) === true,
    lastSuccessDay: () => options.lastSuccess,
    store: { load: async () => structuredClone(saved ?? {}), save: async state => { saved = structuredClone(state) } },
    autostart,
    autostarted: options.autostarted ?? false,
    now: () => now,
    changed: () => {},
    log: { info() {}, warn() {} },
  })
  return { make, started, registered, set: (t: number) => { now = t }, saved: () => saved }
}

const daily = (schedule: Partial<Pipeline['schedule']>, id = 'daily') => Pipeline.parse({
  id, name: id, nodes: [{ id: 'n', kind: 'notify', text: 'x' }], schedule: { enabled: true, times: ['04:30'], ...schedule },
})

test('a time fires once when it comes, and never twice across a restart', async () => {
  const env = setup([daily({})])
  const scheduler = env.make()
  await scheduler.start(0)
  env.set(at(2026, 10, 19, 4, 29, 59)); scheduler.tick()
  assert.equal(env.started.length, 0)
  env.set(at(2026, 10, 19, 4, 30, 1)); scheduler.tick()
  env.set(at(2026, 10, 19, 4, 31)); scheduler.tick()
  assert.deepEqual(env.started.map(s => [s.id, s.trigger]), [['daily', { kind: 'schedule', detail: '04:30' }]])
  scheduler.stop()

  // The program restarts a minute later with what was saved.
  env.set(at(2026, 10, 19, 4, 32))
  const again = env.make()
  await again.start(0)
  env.set(at(2026, 10, 19, 4, 33)); again.tick()
  assert.equal(env.started.length, 1, 'the same slot is not run again')
  assert.equal(again.history()[0]?.slot, '2026-10-19 04:30')
  again.stop()
})

test('a time missed by sleep runs within the grace window and is recorded as missed beyond it', async () => {
  const late = setup([daily({ catchUpMinutes: 10 })])
  const scheduler = late.make()
  await scheduler.start(0)
  late.set(at(2026, 10, 19, 4, 36)); scheduler.tick()  // woke up 6 minutes late
  assert.equal(late.started.length, 1)

  const tooLate = setup([daily({ catchUpMinutes: 10 })])
  const other = tooLate.make()
  await other.start(0)
  tooLate.set(at(2026, 10, 19, 7, 0)); other.tick()    // switched on hours later
  assert.equal(tooLate.started.length, 0)
  assert.equal(other.history()[0]?.outcome, 'missed')
  assert.match(other.history()[0]?.detail ?? '', /晚了 150 分钟，超过补跑宽限 10 分钟/)
  other.stop(); scheduler.stop()
})

test('weekdays, several times, drafts and disabled schedules', async () => {
  const env = setup([
    daily({ times: ['04:30', '16:30'], days: [1, 2, 3, 4, 5] }),               // weekdays
    daily({ times: ['05:00'] }, 'off'),
    Pipeline.parse({ ...daily({ times: ['05:00'] }, 'draft'), draft: true }),
  ])
  env.make()
  // 2026-10-19 is a Monday; 2026-10-24 a Saturday.
  const p = daily({ times: ['04:30', '16:30'], days: [1, 2, 3, 4, 5] })
  assert.deepEqual(slotsBetween(p, at(2026, 10, 19, 0, 0), at(2026, 10, 26, 0, 0)).map(s => s.key.slice(5)), [
    '10-19 04:30', '10-19 16:30', '10-20 04:30', '10-20 16:30', '10-21 04:30', '10-21 16:30', '10-22 04:30', '10-22 16:30', '10-23 04:30', '10-23 16:30',
  ])
  const off = setup([Pipeline.parse({ ...daily({}), schedule: { enabled: false, times: ['04:30'] } }), Pipeline.parse({ ...daily({}, 'd2'), draft: true })])
  const s = off.make()
  await s.start(0)
  off.set(at(2026, 10, 19, 4, 31)); s.tick()
  assert.equal(off.started.length, 0, 'disabled and draft pipelines never run on a schedule')
  s.stop()
})

test('DST: a time inside the skipped hour runs once; the repeated hour runs once', async () => {
  // 2026-03-08 02:00 → 03:00 in New York; 2026-11-01 02:00 → 01:00.
  const spring = setup([daily({ times: ['02:30'] })])
  spring.set(at(2026, 3, 8, 0, 0))
  const a = spring.make()
  await a.start(0)
  for (let t = at(2026, 3, 8, 0, 0); t <= at(2026, 3, 8, 6, 0); t += 10 * 60_000) { spring.set(t); a.tick() }
  assert.equal(spring.started.length, 1)
  assert.equal(new Date(spring.started[0]!.at).getHours(), 3, 'it runs when the clock jumps past it')

  const fall = setup([daily({ times: ['01:30'] })])
  fall.set(at(2026, 11, 1, 0, 0))
  const b = fall.make()
  await b.start(0)
  // Tick through real time: the 01:00–02:00 hour happens twice.
  for (let t = at(2026, 11, 1, 0, 0); t <= at(2026, 11, 1, 0, 0) + 5 * 3_600_000; t += 10 * 60_000) { fall.set(t); b.tick() }
  assert.equal(fall.started.length, 1)
  a.stop(); b.stop()
})

test('a pipeline still running is skipped, chains start after a success, autostart skips what already ran today', async () => {
  const busy = setup([daily({})], { running: ['daily'] })
  const s1 = busy.make()
  await s1.start(0)
  busy.set(at(2026, 10, 19, 4, 31)); s1.tick()
  assert.equal(s1.history()[0]?.outcome, 'skipped')
  assert.equal(s1.history()[0]?.detail, '上一次还没有结束')

  const chain = setup([daily({ times: [], after: 'first' }, 'second')])
  const s2 = chain.make()
  await s2.start(0)
  const run = (state: PipelineRun['state']) => ({ id: 'pl-1', pipelineId: 'first', pipelineName: '第一条', trigger: { kind: 'manual' }, state, nodes: {}, startedAt: 0 }) as PipelineRun
  s2.pipelineEnded(run('failed'))
  assert.equal(chain.started.length, 0)
  s2.pipelineEnded(run('succeeded'))
  assert.deepEqual(chain.started.map(s => [s.id, s.trigger.kind]), [['second', 'after']])

  const boot = setup([daily({}, 'a'), daily({}, 'b')], { autostarted: true, lastSuccess: '2026-10-19', saved: { settings: { autostart: true, autostartPipelines: ['a', 'b'], autostartDelaySeconds: 0, skipIfRanToday: true } } })
  const s3 = boot.make()
  await s3.start(0)
  s3.runAutostart()
  assert.equal(boot.started.length, 0, 'both already succeeded today')
  assert.deepEqual(s3.history().map(h => h.outcome), ['skipped', 'skipped'])
  s1.stop(); s2.stop(); s3.stop()
})

test('turning autostart on registers the task; upcoming lists the next times', async () => {
  const env = setup([daily({ times: ['04:30', '16:30'] })])
  const s = env.make()
  await s.start(0)
  await s.configure({ autostart: true, autostartPipelines: ['daily'] })
  assert.deepEqual(env.registered, ['on'])
  assert.deepEqual(env.saved()?.settings.autostartPipelines, ['daily'])
  await s.configure({ autostart: false })
  assert.deepEqual(env.registered, [])
  assert.deepEqual(s.upcoming(3).map(u => new Date(u.at).getHours()), [4, 16, 4])
  s.stop()
})

test('the Windows task: logon trigger for this user, no time limit, the desktop command with --auto-start', async () => {
  const command = ['C:\\Program Files\\ADG\\electron.exe', 'C:\\Users\\me\\AutoDailyGamePlay\\apps\\desktop', '--auto-start']
  const xml = taskXml(command, 'PC\\me')
  assert.match(xml, /<LogonTrigger>[\s\S]*<UserId>PC\\me<\/UserId>/)
  assert.match(xml, /<ExecutionTimeLimit>PT0S<\/ExecutionTimeLimit>/)
  assert.match(xml, /<DisallowStartIfOnBatteries>false<\/DisallowStartIfOnBatteries>/)
  assert.match(xml, /<RunLevel>LeastPrivilege<\/RunLevel>/)
  assert.match(xml, /<Command>C:\\Program Files\\ADG\\electron.exe<\/Command>/)
  assert.equal(joinArgs(command.slice(1)), 'C:\\Users\\me\\AutoDailyGamePlay\\apps\\desktop --auto-start')
  assert.equal(joinArgs(['C:\\My Apps\\x', '--auto-start']), '"C:\\My Apps\\x" --auto-start')

  const calls: string[][] = []
  let stored = ''
  const exec = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args])
    if (args[0] === '/Query') return stored === '' ? { code: 1, stdout: Buffer.alloc(0), stderr: Buffer.from('ERROR: not found') } : { code: 0, stdout: Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(stored, 'utf16le')]), stderr: Buffer.alloc(0) }
    if (args[0] === '/Create') { stored = taskXml(command, 'PC\\me'); return { code: 0, stdout: Buffer.from('SUCCESS'), stderr: Buffer.alloc(0) } }
    if (args[0] === '/Delete') { stored = ''; return { code: 0, stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) } }
    return undefined
  }
  const port = windowsAutostart({ command, user: 'PC\\me', exec, platform: 'win32', taskName: 'ADG-test' })
  assert.equal(port.available(), true)
  assert.deepEqual(await port.status(), { registered: false })
  await port.register()
  assert.deepEqual(calls.at(-1)!.slice(0, 4), ['schtasks.exe', '/Create', '/TN', 'ADG-test'])
  assert.deepEqual(await port.status(), { registered: true })
  const moved = windowsAutostart({ command: ['D:\\elsewhere\\electron.exe', '--auto-start'], user: 'PC\\me', exec, platform: 'win32', taskName: 'ADG-test' })
  assert.match((await moved.status()).detail ?? '', /和当前程序位置不一致/)
  await port.unregister()
  assert.deepEqual(await port.status(), { registered: false })
  assert.equal(windowsAutostart({ command: undefined, platform: 'win32' }).available(), false, 'no desktop app, no autostart')
})

// Real Task Scheduler round trip: ADG_REAL_SCHTASKS=1 node --test packages/scheduler/test/scheduler.test.ts
test('real schtasks: register, read back, remove', { skip: process.env['ADG_REAL_SCHTASKS'] !== '1' || process.platform !== 'win32' }, async () => {
  const name = `AutoDailyGamePlay-test-${Date.now()}`
  const port = windowsAutostart({ command: [process.execPath, '--version', '--auto-start'], taskName: name })
  try {
    await port.register()
    assert.deepEqual(await port.status(), { registered: true })
  } finally {
    await port.unregister()
  }
  assert.deepEqual(await port.status(), { registered: false })
})
