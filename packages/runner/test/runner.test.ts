import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '@adg/pack-schema'
import type { RunInfo, ScriptInfo } from '@adg/protocol'
import { Runner, type EmulatorBridge } from '../src/runs.ts'

const CLI = fileURLToPath(new URL('../../test-kit/src/fake-script-cli.ts', import.meta.url))

const PACK = `
id: tool
name: Tool
config:
  files:
    - { path: config/gui.json, format: json }
launch:
  exe: tool.exe
  stopAfterDone: true
  stopGraceSeconds: 0
  settings: { exe: tool.exe, args: ['settings.json'] }
tasks:
  - id: cli
    title: 命令行任务
    params:
      scenario: { type: string, default: ok.json }
    args: ['{scenario}']
  - id: gui
    title: 配置驱动任务
    args: ['gui.json']
    patches:
      - file: config/gui.json
        set:
          - path: [Configurations, Default, Start.RunDirectly]
            value: 'True'
          - path: [Configurations, Default, Connect.Address]
            value: '{adb}'
    resources: { input: adb, emulator: mumu }
    success: done-log
  - id: desk
    title: 前台任务
    args: ['slow.json']
    resources: { input: desktop }
logs:
  sources:
    - stdout: true
    - path: debug/gui.log
  rules:
    - { match: '任务已全部完成', level: done }
    - { match: '任务出错', level: error, tag: task-error }
`

function scriptDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'adg-run-'))
  mkdirSync(join(dir, 'config'))
  mkdirSync(join(dir, 'debug'))
  writeFileSync(join(dir, 'tool.exe'), 'MZ')
  const scenario = (name: string, steps: unknown[]) => writeFileSync(join(dir, name), JSON.stringify({ steps }))
  scenario('ok.json', [{ log: 'hello' }, { exit: 0 }])
  scenario('bad.json', [{ log: '任务出错: 刷理智' }, { exit: 0 }])
  scenario('crash.json', [{ log: 'boom' }, { exit: 3 }])
  // The script's settings window: the user changes the stage, the script saves, the window closes.
  scenario('settings.json', [{ writeFile: 'config/gui.json', content: '{"Configurations": {"Default": {"Stage": "H8-4"}}}' }, { exit: 0 }])
  scenario('slow.json', [{ log: 'working' }, { sleepMs: 30_000 }, { exit: 0 }])
  // A GUI that writes its log file, reports done, then stays open until stopped.
  scenario('gui.json', [
    { logFile: 'debug/gui.log', line: '开始任务' },
    { sleepMs: 1500 },
    { logFile: 'debug/gui.log', line: '任务已全部完成！' },
    { sleepMs: 60_000 },
  ])
  writeFileSync(join(dir, 'config', 'gui.json'), '{\n  "Configurations": {\n    "Default": {\n      "Start.RunDirectly": "False",\n      "Keep": 1\n    }\n  }\n}\n')
  return dir
}

function setup(dirs: Record<string, string>, bridge?: EmulatorBridge, pack = PACK, dataDir = mkdtempSync(join(tmpdir(), 'adg-run-data-'))) {
  const manifest = parseManifest(pack)
  const states: RunInfo[] = []
  const runner = new Runner({
    library: {
      get: id => ({ id, name: id, source: { kind: 'local', path: dirs[id]! }, dir: dirs[id], versions: [], addedAt: 0 }) as ScriptInfo,
      packOf: () => ({ manifest }),
    },
    dataDir,
    ...(bridge === undefined ? {} : { emulators: () => bridge }),
    onState: run => states.push(run),
    onLog: () => {},
    command: (_exe, args) => ({ file: process.execPath, args: [CLI, ...args] }),
    log: { info() {}, warn() {} },
    pollMs: 100,
  })
  return { runner, states }
}

const bridge: EmulatorBridge = { prepare: async ({ onStatus }) => { onStatus('启动 MuMu 实例 0'); return { address: '127.0.0.1:16384', label: 'MuMu 0' } } }

test('a CLI task succeeds on exit code 0, fails on an error rule or a crash', async () => {
  const dir = scriptDir()
  const { runner } = setup({ tool: dir })
  const ok = await runner.finished((await runner.start('tool', 'cli')).id)
  assert.equal(ok.state, 'succeeded', ok.outcome)
  assert.ok(runner.logs(ok.id).some(l => l.source === 'stdout' && l.text === 'hello'))

  const bad = await runner.finished((await runner.start('tool', 'cli', { scenario: 'bad.json' })).id)
  assert.equal(bad.state, 'failed')
  assert.match(bad.outcome ?? '', /任务出错: 刷理智/)
  assert.deepEqual(bad.tags, ['task-error'])

  const crash = await runner.finished((await runner.start('tool', 'cli', { scenario: 'crash.json' })).id)
  assert.equal(crash.state, 'failed')
  assert.equal(crash.exitCode, 3)

  await assert.rejects(runner.start('tool', 'cli', { colour: 'red' }), /没有参数 colour/)
  await assert.rejects(runner.start('tool', 'nope'), /没有任务 nope/)
})

test('a config-driven task patches, follows the log file, stops after done, and restores the config', async () => {
  const dir = scriptDir()
  const original = readFileSync(join(dir, 'config', 'gui.json'), 'utf8')
  const { runner } = setup({ tool: dir }, bridge)
  const started = await runner.start('tool', 'gui')
  assert.equal(started.state, 'running', started.outcome)
  assert.ok(started.resources.includes('adb:127.0.0.1:16384'))
  const during = JSON.parse(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'))
  assert.equal(during.Configurations.Default['Start.RunDirectly'], 'True', 'keys containing dots are set as one key')
  assert.equal(during.Configurations.Default['Connect.Address'], '127.0.0.1:16384')
  assert.equal(during.Configurations.Default.Keep, 1, 'other settings are kept')
  assert.match(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'), /^\{\n {2}"Configurations"/, 'the file keeps its two-space indentation')

  const done = await runner.finished(started.id)
  assert.equal(done.state, 'succeeded', done.outcome)
  assert.equal(done.outcome, '脚本报告已完成')
  assert.equal(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'), original, 'config restored byte for byte')
  const lines = runner.logs(done.id, 100)
  assert.ok(lines.some(l => l.source === 'debug/gui.log' && l.level === 'done'))
  assert.ok(lines.some(l => l.source === 'adg' && /启动 MuMu 实例 0/.test(l.text)))
})

test('stop cancels a run; resources are exclusive while it runs', async () => {
  const one = scriptDir()
  const two = scriptDir()
  const { runner } = setup({ one, two }, bridge)
  const first = await runner.start('one', 'desk')
  await assert.rejects(runner.start('two', 'desk'), /桌面鼠标键盘.*正被「one · 前台任务」占用/)
  await assert.rejects(runner.start('one', 'cli'), /脚本 one.*正被/)
  const other = await runner.finished((await runner.start('two', 'cli')).id)
  assert.equal(other.state, 'succeeded', 'a task that needs nothing runs alongside')

  await delay(300)
  await runner.stop(first.id)
  const stopped = await runner.finished(first.id)
  assert.equal(stopped.state, 'cancelled')
  const third = await runner.start('two', 'desk')
  assert.equal(third.state, 'running', 'the desktop is free again after the stop')
  await runner.stop(third.id)
  assert.equal((await runner.finished(third.id)).state, 'cancelled')
})

test('an adb task without the emulator plugin fails before touching anything', async () => {
  const dir = scriptDir()
  const original = readFileSync(join(dir, 'config', 'gui.json'), 'utf8')
  const { runner } = setup({ tool: dir })
  const run = await runner.start('tool', 'gui')
  assert.equal(run.state, 'failed')
  assert.match(run.outcome ?? '', /模拟器插件没有加载/)
  assert.equal(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'), original)
  const next = await runner.finished((await runner.start('tool', 'cli')).id)
  assert.equal(next.state, 'succeeded', 'the failed start released its locks')
})

test('a settings session keeps what the script saved in the local copy; the next run uses it; the original never changes', async () => {
  const dir = scriptDir()
  const original = readFileSync(join(dir, 'config', 'gui.json'), 'utf8')
  const { runner } = setup({ tool: dir }, bridge)
  const session = await runner.finished((await runner.settings('tool')).id)
  assert.equal(session.kind, 'settings')
  assert.equal(session.state, 'succeeded', session.outcome)
  assert.ok(runner.logs(session.id).some(l => /已保存到本地配置：config\/gui\.json/.test(l.text)))
  assert.equal(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'), original, 'the original project config is back')
  assert.match(readFileSync(join(runner.profiles.filesDir('tool'), 'config', 'gui.json'), 'utf8'), /H8-4/)

  const started = await runner.start('tool', 'gui')
  const during = JSON.parse(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'))
  assert.equal(during.Configurations.Default.Stage, 'H8-4', 'the run sees the local copy')
  assert.equal(during.Configurations.Default['Start.RunDirectly'], 'True', 'plus the task patch')
  await runner.finished(started.id)
  assert.equal(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'), original)
  assert.doesNotMatch(readFileSync(join(runner.profiles.filesDir('tool'), 'config', 'gui.json'), 'utf8'), /RunDirectly/, 'task patches never leak into the local copy')
})

test('without a declared settings window, a settings session opens the main program with its base args', async () => {
  const dir = scriptDir()
  const original = readFileSync(join(dir, 'config', 'gui.json'), 'utf8')
  // The main program's base args play the "user saves in the GUI" scenario here.
  const pack = PACK.replace("  settings: { exe: tool.exe, args: ['settings.json'] }\n", '').replace('  exe: tool.exe\n', "  exe: tool.exe\n  args: ['settings.json']\n")
  assert.equal(parseManifest(pack).launch?.settings, undefined)
  const { runner } = setup({ tool: dir }, bridge, pack)
  const session = await runner.finished((await runner.settings('tool')).id)
  assert.equal(session.state, 'succeeded', session.outcome)
  assert.match(readFileSync(join(runner.profiles.filesDir('tool'), 'config', 'gui.json'), 'utf8'), /H8-4/)
  assert.equal(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'), original)
})

test('run logs are saved whole: searched and paged by the agent, and still there after a restart', async () => {
  const dir = scriptDir()
  writeFileSync(join(dir, 'long.json'), JSON.stringify({ steps: [...Array.from({ length: 2500 }, (_, i) => ({ log: `line ${i + 1}` })), { log: '任务出错: 识别失败' }, { exit: 0 }] }))
  const dataDir = mkdtempSync(join(tmpdir(), 'adg-run-data-'))
  const { runner } = setup({ tool: dir }, undefined, PACK, dataDir)
  const run = await runner.finished((await runner.start('tool', 'cli', { scenario: 'long.json' })).id)
  assert.equal(runner.logs(run.id, 5000).length, 2000, 'memory keeps the last 2000 lines')
  const all = await runner.readLog(run.id, { limit: 2000 })
  assert.ok(all.total > 2500, `the file has every line (${all.total})`)
  const first = await runner.readLog(run.id, { fromLine: 1, limit: 3 })
  assert.deepEqual(first.lines.map(l => l.n), [1, 2, 3], 'paging from the first line')
  assert.ok(first.lines.some(l => l.text === 'line 1'), 'the first lines are not lost')
  assert.deepEqual((await runner.readLog(run.id, { search: '/^line 1$/' })).lines.map(l => l.text), ['line 1'], 'early lines are searchable')
  const errors = await runner.readLog(run.id, { levels: ['error'] })
  assert.deepEqual(errors.lines.map(l => [l.text, l.level]), [['任务出错: 识别失败', 'error']])
  assert.equal((await runner.readLog(run.id, { search: '/line 24\\d\\d$/' })).matched, 100, 'a /regex/ search')

  // A run cut off by a crash: its record says running.
  const cut = join(dataDir, 'runs', 'run-cut')
  mkdirSync(cut, { recursive: true })
  writeFileSync(join(cut, 'run.json'), JSON.stringify({ ...run, id: 'run-cut', state: 'running', endedAt: undefined, startedAt: Date.now() }))
  await runner.dispose()

  const again = setup({ tool: dir }, undefined, PACK, dataDir).runner
  await again.loadHistory()
  assert.deepEqual(again.list().map(r => [r.id, r.state]).sort(), [[run.id, 'failed'], ['run-cut', 'failed']].sort())
  assert.equal(again.get('run-cut').outcome, '程序退出时中断')
  assert.equal((await again.readLog(run.id, { levels: ['error'] })).lines.length, 1, 'the log of a run from before the restart')
  await again.dispose()
})
