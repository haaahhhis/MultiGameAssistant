import { strict as assert } from 'node:assert'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseManifest } from '@adg/pack-schema'
import type { ScriptInfo } from '@adg/protocol'
import { Runner, type EmulatorBridge } from '../src/runs.ts'

const CLI = fileURLToPath(new URL('../../test-kit/src/fake-script-cli.ts', import.meta.url))

function setup(startupSeconds = 20) {
  const dir = mkdtempSync(join(tmpdir(), 'adg-halt-'))
  writeFileSync(join(dir, 'tool.exe'), 'MZ')
  writeFileSync(join(dir, 'long.json'), JSON.stringify({ steps: [{ log: 'working' }, { sleepMs: 30_000 }, { exit: 0 }] }))
  const manifest = parseManifest(`id: tool
name: Tool
launch: { exe: tool.exe }
game:
  android: { package: com.example.game }
  startupSeconds: ${startupSeconds}
tasks:
  - id: t
    title: T
    args: [long.json]
    resources: { input: adb }
`)
  const events: string[] = []
  let up = false
  const bridge: EmulatorBridge = {
    prepare: async () => ({ address: '127.0.0.1:16384', label: 'MuMu 0', managed: true }),
    expectedAddress: async () => '127.0.0.1:16384',
    appRunning: async () => up,
    launchApp: async (_a, pkg) => { events.push(`launch ${pkg}`); up = true },
    stopApp: async (_a, pkg) => { events.push(`close ${pkg}`); up = false },
  }
  const runner = new Runner({
    library: { get: id => ({ id, name: 'Tool', source: { kind: 'local', path: dir }, dir, versions: [], addedAt: 0 }) as ScriptInfo, packOf: () => ({ manifest }) },
    dataDir: mkdtempSync(join(tmpdir(), 'adg-halt-data-')),
    emulators: () => bridge,
    onState: () => {}, onLog: () => {},
    command: (_exe, args) => { events.push('script'); return { file: process.execPath, args: [CLI, ...args] } },
    log: { info() {}, warn() {} },
  })
  return { runner, events }
}

test('stopped while the game it started is still loading: no script, the game closed again, and nothing restarts it', async () => {
  const { runner, events } = setup()
  const pipeline = new AbortController()
  const starting = runner.start('tool', 't', {}, { signal: pipeline.signal })
  // The pipeline is stopped while the run waits for the game (20 s startup).
  while (!events.includes('launch com.example.game')) await delay(10)
  const before = Date.now()
  pipeline.abort(new Error('流水线已取消'))
  const run = await starting
  assert.ok(Date.now() - before < 5000, 'stopped at once, not after the game’s startup time')
  assert.equal(run.state, 'cancelled')
  assert.equal(run.outcome, '流水线已取消')
  assert.equal(run.halted, true)
  assert.deepEqual(events, ['launch com.example.game', 'close com.example.game'], 'the script never started; the game it opened was closed')

  await assert.rejects(runner.restart(run.id, '自动重启'), /不再重新运行/, 'recovery does not bring it back')
  // A person may still run it again (stopped here again before its game is up).
  const again = runner.restart(run.id, '你点了重试', { byUser: true })
  while (events.filter(e => e === 'launch com.example.game').length < 2) await delay(10)
  await runner.stop(run.id, '又停了')
  const second = await again
  assert.notEqual(second.id, run.id)
  assert.equal(second.state, 'cancelled')
})

test('a stop reaches a restart already on its way: the old run stopped for good, the new one never runs', async () => {
  const { runner, events } = setup(0)
  const first = await runner.start('tool', 't')
  assert.equal(first.state, 'running')
  // Recovery restarts it; the user stops the run before the new one is up.
  const restarting = runner.restart(first.id, '卡住了，自动重启').then(r => r, (e: Error) => e)
  await runner.stop(first.id, '你停止了流水线')
  const next = await restarting
  if (next instanceof Error) assert.match(next.message, /不再重新运行/)
  else assert.equal(next.state, 'cancelled', 'called off while starting')
  assert.equal(runner.get(first.id).halted, true)
  assert.equal(events.filter(e => e === 'script').length, 1, 'only the first run’s script ever started')
})
