import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { gzipSync } from 'node:zlib'
import { parseManifest } from '@adg/pack-schema'
import type { RunLogLine, ScriptInfo } from '@adg/protocol'
import { KEEP_DAYS, PACK_AFTER_MS, packLog, readRunLog, tidyRuns } from '../src/retention.ts'
import { Runner } from '../src/runs.ts'

const CLI = fileURLToPath(new URL('../../test-kit/src/fake-script-cli.ts', import.meta.url))
const DAY = 86_400_000
const NOW = Date.UTC(2026, 10, 16, 6)

const line = (n: number, at = NOW): RunLogLine => ({ at: at + n, source: 'stdout', text: `line ${n} ${'x'.repeat(60)}` })
const jsonl = (lines: readonly RunLogLine[]) => lines.map(l => `${JSON.stringify(l)}\n`).join('')

/** A saved run as older versions left it: run.json, log.jsonl and the same lines again in log.txt. */
function savedRun(root: string, id: string, scriptId: string, endedAt: number | undefined, lines = 200): string {
  const dir = join(root, id)
  mkdirSync(dir, { recursive: true })
  const startedAt = (endedAt ?? NOW) - 60_000
  writeFileSync(join(dir, 'run.json'), JSON.stringify({ id, scriptId, scriptName: scriptId, taskId: 't', taskTitle: 't', params: {}, state: endedAt === undefined ? 'running' : 'succeeded', startedAt, ...(endedAt === undefined ? {} : { endedAt }), command: [], resources: [], tags: [], warnings: [] }))
  const all = Array.from({ length: lines }, (_, i) => line(i + 1, startedAt))
  writeFileSync(join(dir, 'log.jsonl'), jsonl(all))
  writeFileSync(join(dir, 'log.txt'), all.map(l => `${new Date(l.at).toISOString()} [${l.source}] ${l.text}\n`).join(''))
  return dir
}

test('old runs: folders past 30 days go, the text copy goes, logs over 10 minutes old are gzipped and read back the same', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-retention-'))
  const expired = savedRun(root, 'run-old', 'maa', NOW - (KEEP_DAYS + 1) * DAY)
  const done = savedRun(root, 'run-done', 'maa', NOW - 2 * DAY)
  const recent = savedRun(root, 'run-recent', 'maa', NOW - PACK_AFTER_MS + 60_000)
  const going = savedRun(root, 'run-going', 'maa', undefined)
  const held = savedRun(root, 'run-held', 'maa', NOW - DAY)
  const before = await readRunLog(done)

  const result = await tidyRuns(root, { now: NOW, busy: id => id === 'run-held' })
  assert.equal(existsSync(expired), false, 'a run folder past 30 days is deleted')
  assert.deepEqual(readdirSync(done).sort(), ['log.jsonl.gz', 'run.json'], 'a finished run keeps one gzipped log')
  assert.deepEqual(await readRunLog(done), before, 'the gzipped log reads back line for line')
  assert.deepEqual(readdirSync(recent).sort(), ['log.jsonl', 'run.json'], 'just ended: only the duplicate text copy goes, the log waits to be gzipped')
  assert.deepEqual(readdirSync(going).sort(), ['log.jsonl', 'log.txt', 'run.json'], 'a run still going is left alone')
  assert.deepEqual(readdirSync(held).sort(), ['log.jsonl', 'log.txt', 'run.json'], 'a run someone is handling is left alone')
  assert.equal(result.expired, 1)
  assert.equal(result.packed, 1)
  assert.ok(result.freed > 0)
})

test("each script's logs stay within its budget, newest first; the records stay, and a script's newest log always stays", async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-retention-'))
  // Incompressible text, so the sizes are known after gzip.
  const noise = (n: number) => Array.from({ length: n }, () => Math.random().toString(36).slice(2)).join('')
  const run = (id: string, scriptId: string, daysAgo: number, bytes: number) => {
    const dir = join(root, id)
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'run.json'), JSON.stringify({ id, scriptId, startedAt: NOW - daysAgo * DAY - 60_000, endedAt: NOW - daysAgo * DAY, state: 'succeeded' }))
    writeFileSync(join(dir, 'log.jsonl'), `${JSON.stringify({ at: NOW, source: 'stdout', text: noise(bytes / 11) })}\n`)
    return dir
  }
  const big = run('end-1', 'maaend', 1, 450_000) // over the budget on its own, also gzipped
  const end2 = run('end-2', 'maaend', 2, 50_000)
  const end3 = run('end-3', 'maaend', 3, 50_000)
  const maa = run('maa-1', 'maa', 4, 50_000)

  const result = await tidyRuns(root, { now: NOW, busy: () => false, budget: 200_000 })
  assert.ok(existsSync(join(big, 'log.jsonl.gz')), "the script's newest run keeps its log even over the budget")
  for (const dir of [end2, end3]) assert.deepEqual(readdirSync(dir), ['run.json'], 'older logs past the budget are deleted, the record stays')
  assert.ok(existsSync(join(maa, 'log.jsonl.gz')), "another script's logs have a budget of their own")
  assert.equal(result.trimmed, 2)
  assert.equal(await readRunLog(end2), undefined)
})

test('lines written after a log was gzipped are added to it; a read caught while packing shows no line twice', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-retention-'))
  const first = Array.from({ length: 5 }, (_, i) => line(i))
  const later = Array.from({ length: 3 }, (_, i) => line(i + 100))
  writeFileSync(join(dir, 'log.prev.jsonl'), jsonl(first.slice(0, 2)))
  writeFileSync(join(dir, 'log.jsonl'), jsonl(first.slice(2)))
  assert.equal(await packLog(dir), true)
  assert.deepEqual(await readRunLog(dir), first, 'the part before a restart of the file comes first')
  writeFileSync(join(dir, 'log.jsonl'), jsonl(later))
  assert.deepEqual(await readRunLog(dir), [...first, ...later], 'a gzipped log and lines written after it')
  await packLog(dir)
  assert.deepEqual(readdirSync(dir), ['log.jsonl.gz'])
  assert.deepEqual(await readRunLog(dir), [...first, ...later], 'two gzip members read as one log')
  assert.equal(await packLog(dir), false, 'nothing left to pack')

  // Packed, but the plain file not removed yet.
  const racing = mkdtempSync(join(tmpdir(), 'adg-retention-'))
  writeFileSync(join(racing, 'log.jsonl.gz'), gzipSync(jsonl([...first, ...later])))
  writeFileSync(join(racing, 'log.jsonl'), jsonl(later))
  assert.deepEqual(await readRunLog(racing), [...first, ...later])
})

test('a run writes one log file; past the live limit it starts over and keeps the part before; tidied, it is still read whole', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-run-'))
  writeFileSync(join(dir, 'tool.exe'), 'MZ')
  // Three bursts, each written in its own flush and each past the live limit.
  const burst = (from: number) => [...Array.from({ length: 100 }, (_, i) => ({ log: `line ${from + i} ${'y'.repeat(80)}` })), { sleepMs: 400 }]
  writeFileSync(join(dir, 'long.json'), JSON.stringify({ steps: [...burst(1), ...burst(101), ...burst(201), { exit: 0 }] }))
  const manifest = parseManifest('id: tool\nname: Tool\nlaunch:\n  exe: tool.exe\ntasks:\n  - id: cli\n    title: 命令行任务\n    args: [long.json]\nlogs:\n  sources:\n    - stdout: true\n  rules: []\n')
  const dataDir = mkdtempSync(join(tmpdir(), 'adg-run-data-'))
  let now = Date.now()
  const make = (perScript?: number) => new Runner({
    library: { get: id => ({ id, name: id, source: { kind: 'local', path: dir }, dir, versions: [], addedAt: 0 }) as ScriptInfo, packOf: () => ({ manifest }) },
    dataDir,
    onState: () => {},
    onLog: () => {},
    command: (_exe, args) => ({ file: process.execPath, args: [CLI, ...args] }),
    log: { info() {}, warn() {} },
    now: () => now,
    logLimits: { live: 10 * 1024, ...(perScript === undefined ? {} : { perScript }) },
  })
  const runner = make()
  const run = await runner.finished((await runner.start('tool', 'cli')).id)
  assert.equal(run.state, 'succeeded', run.outcome)
  const runDir = join(dataDir, 'runs', run.id)
  assert.equal(existsSync(join(runDir, 'log.txt')), false, 'no second copy as text')
  assert.ok(existsSync(join(runDir, 'log.prev.jsonl')), 'past the live limit the log started over')
  const live = await runner.readLog(run.id, { limit: 2000 })
  assert.ok(live.lines.some(l => l.text.startsWith('line 300 ')), 'the end of the run is there')
  assert.ok(!live.lines.some(l => l.text.startsWith('line 1 ')) && live.total < 300, `older parts are dropped, as MAA drops its older backup (${live.total} lines kept)`)

  now += PACK_AFTER_MS + 1000
  const tidied = await runner.tidy()
  assert.equal(tidied.packed, 1)
  assert.deepEqual(readdirSync(runDir).filter(f => f.startsWith('log')), ['log.jsonl.gz'])
  const packed = await runner.readLog(run.id, { limit: 2000 })
  assert.deepEqual(packed.lines.map(l => l.text), live.lines.map(l => l.text), 'the agent reads the gzipped log as before')

  // A newer run of the script pushes this one's log out of a tiny budget; the run stays listed.
  const second = await runner.finished((await runner.start('tool', 'cli')).id)
  now += PACK_AFTER_MS + 1000
  await runner.dispose()
  const again = make(1)
  await again.loadHistory()
  assert.equal((await again.tidy()).trimmed, 1)
  assert.deepEqual(again.list().map(r => r.id).sort(), [run.id, second.id].sort())
  await assert.rejects(again.readLog(run.id), /日志已按保留规则清理/)
  assert.ok((await again.readLog(second.id)).total > 0, 'the newest run keeps its log')
  await again.dispose()
})
