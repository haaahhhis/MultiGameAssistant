import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '@adg/pack-schema'
import type { ScriptInfo } from '@adg/protocol'
import { listWithNew, readChoices } from '../src/choices.ts'
import { ensureGame, scriptLaunchesGame } from '../src/game.ts'
import { gameKeywords, locateGame } from '../src/locate.ts'
import { editText } from '../src/patch.ts'
import { Runner, type EmulatorBridge } from '../src/runs.ts'

const CLI = fileURLToPath(new URL('../../test-kit/src/fake-script-cli.ts', import.meta.url))

const MXU = JSON.stringify({
  version: '1',
  instances: [
    { id: 'a', name: '日常（PC）', controllerName: 'Win32-Front', tasks: [{ id: 't1', taskName: 'DailyRewards', enabled: true, optionValues: {} }] },
    { id: 'b', name: '模拟器日常', controllerName: 'ADB', savedDevice: { adbDeviceAddress: '127.0.0.1:5555' }, tasks: [] },
  ],
  settings: { theme: 'system' },
}, null, 2)

const CHOICES = { file: 'config/mxu-MaaEnd.json', list: ['instances'], value: 'name', detail: 'controllerName', create: { set: { id: '{uuid}', name: '{name}' } } }

test('choices come from the config, filtered by a field; a new one is a copy of an existing one', () => {
  assert.deepEqual(readChoices({ ...CHOICES, where: { field: 'controllerName', match: 'win32|front' } }, MXU), [{ value: '日常（PC）', label: '日常（PC）', detail: 'Win32-Front' }])
  assert.deepEqual(readChoices({ ...CHOICES, where: { field: 'controllerName', match: 'adb' } }, MXU).map(c => c.value), ['模拟器日常'])
  assert.deepEqual(readChoices(CHOICES, undefined), [], 'no file yet: no choices')
  assert.deepEqual(readChoices(CHOICES, '{ broken'), [])

  const { list, value } = listWithNew({ ...CHOICES, where: { field: 'controllerName', match: 'win32' } }, MXU, 'AutoDailyGamePlay')
  assert.equal(value, 'AutoDailyGamePlay')
  const made = list.at(-1) as Record<string, unknown>
  assert.equal(made['controllerName'], 'Win32-Front', 'copied from a PC instance')
  assert.notEqual(made['id'], 'a')
  assert.match(String(made['id']), /^[0-9a-f-]{36}$/)
  assert.deepEqual(made['tasks'], [{ id: 't1', taskName: 'DailyRewards', enabled: true, optionValues: {} }], 'with its tasks')
  assert.throws(() => listWithNew(CHOICES, MXU, '模拟器日常'), /已经有「模拟器日常」/)
  assert.throws(() => listWithNew(CHOICES, '{"instances": []}', 'x'), /没有可以复制的现有项/)
})

test('a patch can address a list item by a field', () => {
  const out = JSON.parse(editText('config/mxu-MaaEnd.json', MXU, [{ path: ['instances', { where: { field: 'name', equals: '模拟器日常' } }, 'savedDevice', 'adbDeviceAddress'], value: '127.0.0.1:16384' }]))
  assert.equal(out.instances[1].savedDevice.adbDeviceAddress, '127.0.0.1:16384')
  assert.equal(out.instances[0].savedDevice, undefined)
  const yaml = editText('c.yaml', '# keep\nlist:\n  - name: a\n    v: 1\n  - name: b\n    v: 2\n', [{ path: ['list', { where: { field: 'name', equals: 'b' } }, 'v'], value: 9 }])
  assert.match(yaml, /# keep/)
  assert.match(yaml, /name: b\n {4}v: 9/)
  assert.throws(() => editText('x.json', MXU, [{ path: ['instances', { where: { field: 'name', equals: '没有' } }, 'x'], value: 1 }]), /没有 name 为「没有」的项/)
})

test('the game is started only when the script will not and it is not running', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-game-'))
  mkdirSync(join(dir, 'config'))
  writeFileSync(join(dir, 'config', 'gui.json'), JSON.stringify({ Start: { StartGame: 'True' } }))
  const manifest = (game: string) => parseManifest(`id: g\nname: G\nlaunch: { exe: g.exe }\n${game}`)
  const condition = "game:\n  android: { package: com.example.game }\n  selfLaunch: [{ file: config/gui.json, path: [Start, StartGame], equals: 'True' }]\n  startupSeconds: 1\n"
  assert.equal(await scriptLaunchesGame(manifest(condition).game, dir), true)
  writeFileSync(join(dir, 'config', 'gui.json'), JSON.stringify({ Start: { StartGame: 'False' } }))
  assert.equal(await scriptLaunchesGame(manifest(condition).game, dir), false)

  const calls: string[] = []
  const lines: string[] = []
  let running = false
  const android = {
    appRunning: async (_a: string, pkg: string) => { calls.push(`running? ${pkg}`); return running },
    launchApp: async (address: string, pkg: string) => { calls.push(`launch ${pkg} on ${address}`) },
  }
  const base = { scriptDir: dir, signal: AbortSignal.timeout(5000), line: (t: string) => lines.push(t), sleep: async () => {} }
  await ensureGame({ ...base, manifest: manifest(condition), settings: { mode: 'auto' }, input: 'adb', address: '127.0.0.1:16384', android })
  assert.deepEqual(calls, ['running? com.example.game', 'launch com.example.game on 127.0.0.1:16384'])

  calls.length = 0
  running = true
  await ensureGame({ ...base, manifest: manifest(condition), settings: { mode: 'auto' }, input: 'adb', address: '127.0.0.1:16384', android })
  assert.deepEqual(calls, ['running? com.example.game'], 'already running: left alone')

  calls.length = 0
  running = false
  writeFileSync(join(dir, 'config', 'gui.json'), JSON.stringify({ Start: { StartGame: 'True' } }))
  await ensureGame({ ...base, manifest: manifest(condition), settings: { mode: 'auto' }, input: 'adb', address: '127.0.0.1:16384', android })
  assert.deepEqual(calls, [], 'the script starts it itself this time')
  await ensureGame({ ...base, manifest: manifest(condition), settings: { mode: 'platform' }, input: 'adb', address: '127.0.0.1:16384', android })
  assert.equal(calls.length, 2, '"always by AutoDailyGamePlay" ignores the script setting')
  calls.length = 0
  await ensureGame({ ...base, manifest: manifest(condition), settings: { mode: 'off' }, input: 'adb', address: '127.0.0.1:16384', android })
  assert.deepEqual(calls, [])

  // A PC game: started from the user's path unless its process is running.
  const started: string[] = []
  let up = false
  const pc = { processRunning: async (name: string) => { calls.push(`ps ${name}`); return up }, startProgram: (exe: string) => { started.push(exe); up = true } }
  await ensureGame({ ...base, ...pc, manifest: manifest('game:\n  pc: { process: Game.exe }\n  startupSeconds: 0\n'), settings: { mode: 'auto', pcExe: 'D:\\Games\\Game\\launcher.exe' }, input: 'desktop', android: undefined })
  assert.deepEqual(started, ['D:\\Games\\Game\\launcher.exe'])
  await ensureGame({ ...base, ...pc, manifest: manifest('game:\n  pc: { process: Game.exe }\n'), settings: { mode: 'auto', pcExe: 'D:\\Games\\Game\\launcher.exe' }, input: 'desktop', android: undefined })
  assert.equal(started.length, 1, 'running now: not started twice')
  await ensureGame({ ...base, ...pc, manifest: manifest('game:\n  pc: { process: Game.exe }\n'), settings: { mode: 'auto' }, input: 'desktop', android: undefined })
  assert.equal(started.length, 1, 'no program path: nothing to start')
})

test('a run: managed-emulator patches apply only with a managed emulator; tasks list config choices; the game starts after the config is in place', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-game-run-'))
  mkdirSync(join(dir, 'config'))
  writeFileSync(join(dir, 'tool.exe'), 'MZ')
  writeFileSync(join(dir, 'config', 'gui.json'), JSON.stringify({ OpenEmulator: true, Address: '' }, null, 2))
  writeFileSync(join(dir, 'config', 'mxu.json'), MXU)
  writeFileSync(join(dir, 'ok.json'), JSON.stringify({ steps: [{ log: 'hi' }, { exit: 0 }] }))
  const manifest = parseManifest(`id: tool
name: Tool
config:
  files:
    - { path: config/gui.json, format: json }
    - { path: config/mxu.json, format: json }
launch: { exe: tool.exe }
game:
  android: { package: com.example.game }
  startupSeconds: 0
tasks:
  - id: t
    title: T
    args: [ok.json]
    params:
      instance:
        type: string
        choices: { file: config/mxu.json, list: [instances], value: name, where: { field: controllerName, match: adb }, create: { set: { id: '{uuid}', name: '{name}' } } }
    patches:
      - file: config/gui.json
        set: [{ path: [Address], value: '{adb}' }]
      - file: config/gui.json
        when: emulator-managed
        set: [{ path: [OpenEmulator], value: false }]
      - file: config/mxu.json
        set: [{ path: [instances, { where: { field: name, equals: '{instance}' } }, savedDevice, adbDeviceAddress], value: '{adb}' }]
    resources: { input: adb }
`)
  const seen: string[] = []
  const launched: string[] = []
  const bridge = (managed: boolean): EmulatorBridge => ({
    prepare: async () => ({ address: '127.0.0.1:16384', label: 'MuMu 0', managed }),
    appRunning: async () => false,
    launchApp: async (_a, pkg) => {
      launched.push(pkg)
      seen.push(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'), readFileSync(join(dir, 'config', 'mxu.json'), 'utf8'))
    },
  })
  const make = (managed: boolean) => new Runner({
    library: { get: id => ({ id, name: 'Tool', source: { kind: 'local', path: dir }, dir, versions: [], addedAt: 0 }) as ScriptInfo, packOf: () => ({ manifest }) },
    dataDir: mkdtempSync(join(tmpdir(), 'adg-game-data-')),
    emulators: () => bridge(managed),
    onState: () => {}, onLog: () => {},
    command: (_exe, args) => ({ file: process.execPath, args: [CLI, ...args] }),
    log: { info() {}, warn() {} },
  })

  const runner = make(true)
  const tasks = await runner.tasks('tool')
  assert.deepEqual(tasks.tasks[0]!.params['instance']!.choices, [{ value: '模拟器日常', label: '模拟器日常' }])
  assert.equal(tasks.tasks[0]!.params['instance']!.canCreate, true)
  assert.equal(await runner.createChoice('tool', 't', 'instance', '第二个'), '第二个')
  assert.deepEqual((await runner.tasks('tool')).tasks[0]!.params['instance']!.choices!.map(c => c.value), ['模拟器日常', '第二个'])
  assert.equal(JSON.parse(readFileSync(join(dir, 'config', 'mxu.json'), 'utf8')).instances.length, 2, 'the original config is untouched')

  const run = await runner.finished((await runner.start('tool', 't', { instance: '第二个' })).id)
  assert.equal(run.state, 'succeeded', run.outcome)
  assert.deepEqual(launched, ['com.example.game'])
  const [gui, mxu] = [JSON.parse(seen[0]!), JSON.parse(seen[1]!)]
  assert.equal(gui.OpenEmulator, false, 'we started the emulator: the script must not')
  assert.equal(gui.Address, '127.0.0.1:16384')
  assert.equal(mxu.instances.find((i: { name: string }) => i.name === '第二个').savedDevice.adbDeviceAddress, '127.0.0.1:16384', 'the chosen instance connects to our emulator')
  assert.ok(runner.logs(run.id).some(l => /在模拟器里启动游戏（com.example.game）/.test(l.text)))

  seen.length = 0
  const manual = make(false)
  await manual.finished((await manual.start('tool', 't', { instance: '模拟器日常' })).id)
  assert.equal(JSON.parse(seen[0]!).OpenEmulator, true, 'a manual address: the script keeps starting its emulator')
})

test('finding the PC game: running, installed programs, shortcuts, then matching folders on disk', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-locate-'))
  const make = (...parts: string[]) => { const file = join(root, ...parts); mkdirSync(join(file, '..'), { recursive: true }); writeFileSync(file, ''); return file }
  const running = make('Running', 'StarRail.exe')
  const icon = make('Installed', 'StarRail.exe')
  const viaLauncher = make('HoYoPlay', 'games', 'Star Rail Game', 'StarRail.exe')
  make('HoYoPlay', 'launcher.exe')
  const onDisk = make('D', 'Games', '星穹铁道', 'Game', 'StarRail.exe')
  make('D', 'Other', 'deep', 'StarRail.exe') // not under a matching or game folder: not searched
  const keywords = gameKeywords({ name: '崩坏：星穹铁道', pc: { process: 'StarRail.exe', keywords: ['HoYoPlay'] } })
  assert.deepEqual(keywords, ['HoYoPlay', 'StarRail', '崩坏：星穹铁道', '星穹铁道'])

  const all = await locateGame({
    exe: 'StarRail.exe', keywords, roots: [join(root, 'D')],
    probe: async () => ({
      running: [running, join(root, 'Running', 'other.exe')],
      entries: [{ name: '崩坏：星穹铁道', icon: `"${icon}",0` }, { name: '无关的程序', location: join(root, 'D') }],
      shortcuts: [{ name: 'HoYoPlay', target: join(root, 'HoYoPlay', 'launcher.exe') }],
    }),
  })
  assert.deepEqual(all.map(c => [c.path, c.source]), [
    [running, '游戏正在运行'],
    [icon, '已安装程序：崩坏：星穹铁道'],
    [viaLauncher, '快捷方式「HoYoPlay」所在的目录'],
  ], 'the disk is only walked when nothing better was found')

  const disk = await locateGame({ exe: 'starrail', keywords, roots: [join(root, 'D')], probe: async () => ({ running: [], entries: [], shortcuts: [] }) })
  assert.deepEqual(disk.map(c => c.path), [onDisk], 'Games → a folder named after the game → its program; unrelated folders are not searched')
})

test('starting a game on its own: in the emulator (started first), or the PC program; never over a run that holds the screen', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-game-only-'))
  const manifest = parseManifest(`id: tool
name: Tool
launch: { exe: tool.exe }
game:
  name: 测试游戏
  android: { package: com.example.game }
  pc: { process: Game.exe }
  selfLaunch: always
  startupSeconds: 0
tasks:
  - { id: t, title: T, resources: { input: adb } }
`)
  const launched: string[] = []
  const started: string[] = []
  let up = false
  const dataDir = mkdtempSync(join(tmpdir(), 'adg-game-only-data-'))
  const runner = new Runner({
    library: { get: id => { if (id !== 'tool') throw new Error('no such script'); return { id, name: 'Tool', source: { kind: 'local', path: dir }, dir, versions: [], addedAt: 0 } as ScriptInfo }, packOf: () => ({ manifest }) },
    dataDir,
    emulators: () => ({ prepare: async ({ onStatus }) => { onStatus('启动模拟器 MuMu 0'); return { address: '127.0.0.1:16384', label: 'MuMu 0' } }, appRunning: async () => false, launchApp: async (_a, pkg) => { launched.push(pkg) } }),
    onState: () => {}, onLog: () => {},
    log: { info() {}, warn() {} },
    game: { processRunning: async () => up, startProgram: exe => { started.push(exe); up = true }, sleep: async () => {} },
  })
  assert.equal(runner.hasPack('tool'), true)
  assert.equal(runner.hasPack('other'), false)

  const lines = await runner.startGame('tool', 'emulator', AbortSignal.timeout(5000))
  assert.deepEqual(launched, ['com.example.game'], 'started although the script would start it itself: no script runs now')
  assert.deepEqual(lines, ['启动模拟器 MuMu 0', '使用模拟器 MuMu 0（127.0.0.1:16384）', '在模拟器里启动测试游戏（com.example.game）'])

  await assert.rejects(runner.startGame('tool', 'pc', AbortSignal.timeout(5000)), /还没有设置测试游戏的程序位置/)
  await runner.launch.set('tool', { pcExe: 'D:\Games\launcher.exe' })
  const release = runner.locks.acquire(['desktop'], { runId: 'run-x', label: '三月七 · 日常' })
  await assert.rejects(runner.startGame('tool', 'pc', AbortSignal.timeout(5000)), /desktop|三月七/)
  release()
  await runner.startGame('tool', 'pc', AbortSignal.timeout(5000))
  assert.deepEqual(started, ['D:\Games\launcher.exe'])
  assert.deepEqual(await runner.startGame('tool', 'pc', AbortSignal.timeout(5000)), ['测试游戏（Game.exe）已经在运行'])
  assert.equal(runner.locks.held().size, 0, 'no lock left behind')
})

test('closing a game: only the app in the emulator, or the PC process (asked first, ended if it stays); never under a run', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-game-close-'))
  const manifest = parseManifest(`id: tool
name: Tool
launch: { exe: tool.exe }
game:
  name: 测试游戏
  android: { package: com.example.game }
  pc: { process: Game.exe }
tasks:
  - { id: t, title: T, resources: { input: adb } }
`)
  const stopped: string[] = []
  const ended: string[] = []
  let appUp = true
  let pcUp = true
  let stubborn = false
  let address: string | undefined = '127.0.0.1:16384'
  const runner = new Runner({
    library: { get: id => ({ id, name: 'Tool', source: { kind: 'local', path: dir }, dir, versions: [], addedAt: 0 }) as ScriptInfo, packOf: () => ({ manifest }) },
    dataDir: mkdtempSync(join(tmpdir(), 'adg-game-close-data-')),
    emulators: () => ({
      prepare: async () => { throw new Error('closing never starts the emulator') },
      expectedAddress: async () => address,
      appRunning: async () => appUp,
      stopApp: async (a, pkg) => { stopped.push(`${a} ${pkg}`); appUp = false },
    }),
    onState: () => {}, onLog: () => {},
    log: { info() {}, warn() {} },
    game: { processRunning: async () => pcUp, stopProgram: async (name, force) => { ended.push(`${name}${force ? ' /F' : ''}`); if (force || !stubborn) pcUp = false }, sleep: async () => {} },
  })

  assert.deepEqual(await runner.closeGame('tool', 'emulator', AbortSignal.timeout(5000)), ['已关闭模拟器里的测试游戏（com.example.game），模拟器还开着'])
  assert.deepEqual(stopped, ['127.0.0.1:16384 com.example.game'])
  assert.deepEqual(await runner.closeGame('tool', 'emulator', AbortSignal.timeout(5000)), ['测试游戏（com.example.game）没有在模拟器里运行'])
  address = undefined
  assert.deepEqual(await runner.closeGame('tool', 'emulator', AbortSignal.timeout(5000)), ['模拟器没有在运行，游戏也就没开着'])

  const release = runner.locks.acquire(['desktop'], { runId: 'run-x', label: '三月七 · 日常' })
  await assert.rejects(runner.closeGame('tool', 'pc', AbortSignal.timeout(5000)), /desktop|三月七/)
  release()
  assert.deepEqual(await runner.closeGame('tool', 'pc', AbortSignal.timeout(5000)), ['已关闭测试游戏（Game.exe）'])
  assert.deepEqual(ended, ['Game.exe'], 'asked to close, no force needed')
  pcUp = true
  stubborn = true
  assert.deepEqual(await runner.closeGame('tool', 'pc', AbortSignal.timeout(5000)), ['测试游戏（Game.exe）没有自己退出，已强制结束'])
  assert.deepEqual(ended, ['Game.exe', 'Game.exe', 'Game.exe /F'])
  assert.deepEqual(await runner.closeGame('tool', 'pc', AbortSignal.timeout(5000)), ['测试游戏（Game.exe）没有在运行'])
  assert.equal(runner.locks.held().size, 0, 'no lock left behind')
})

test('MaaEnd standalone launch uses its pretask without a program path and keeps desktop locking', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-maaend-'))
  const manifest = parseManifest('id: maaend\nname: MaaEnd\nlaunch: { exe: MaaEnd.exe }\ngame:\n  pc: { process: Endfield.exe }\n  startupSeconds: 0\n')
  let running = false
  let fail = false
  let calls = 0
  const runner = new Runner({
    library: { get: id => ({ id, name: 'MaaEnd', source: { kind: 'local', path: dir }, dir, versions: [], addedAt: 0 }) as ScriptInfo, packOf: () => ({ manifest }) },
    dataDir: mkdtempSync(join(tmpdir(), 'adg-maaend-data-')),
    onState: () => {}, onLog: () => {}, log: { info() {}, warn() {} },
    game: {
      processRunning: async () => running,
      startProgram: () => { assert.fail('must not start the game executable directly') },
      launchMaaEnd: async start => {
        calls++
        assert.equal(start.scriptDir, dir)
        assert.equal(start.settings.pcRegion, 'CN')
        if (fail) throw new Error('pretask failed')
        running = true
      },
    },
  })
  await runner.launch.set('maaend', { pcLaunch: 'maaend', pcRegion: 'CN' })
  const release = runner.locks.acquire(['desktop'], { runId: 'busy', label: 'busy' })
  await assert.rejects(runner.startGame('maaend', 'pc', AbortSignal.timeout(5000)), /desktop|busy/)
  assert.equal(calls, 0)
  release()
  await runner.startGame('maaend', 'pc', AbortSignal.timeout(5000))
  assert.equal(calls, 1)
  await runner.startGame('maaend', 'pc', AbortSignal.timeout(5000))
  assert.equal(calls, 1, 'already running: do not launch twice')
  running = false
  fail = true
  await assert.rejects(runner.startGame('maaend', 'pc', AbortSignal.timeout(5000)), /pretask failed/)
  assert.equal(runner.locks.held().size, 0, 'failed launches release the desktop')
})
