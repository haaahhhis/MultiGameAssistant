import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { fileURLToPath } from 'node:url'
import { parseManifest, type ScriptManifest } from '@adg/pack-schema'
import { Pipeline, type PipelineInput, type PipelineRun, type ScriptInfo } from '@adg/protocol'
import { Runner } from '@adg/runner'
import { checkPipeline } from '../src/check.ts'
import { Engine, type EngineNotice } from '../src/engine.ts'

const CLI = fileURLToPath(new URL('../../test-kit/src/fake-script-cli.ts', import.meta.url))

/** A script directory whose pack has the given tasks; each task plays `<task>.json`. */
function script(id: string, input: 'adb' | 'desktop' | 'none', scenarios: Record<string, unknown[]>, extra = ''): { id: string; dir: string; manifest: ScriptManifest } {
  const dir = mkdtempSync(join(tmpdir(), `adg-orch-${id}-`))
  writeFileSync(join(dir, 'tool.exe'), 'MZ')
  mkdirSync(join(dir, 'debug'))
  for (const [task, steps] of Object.entries(scenarios)) writeFileSync(join(dir, `${task}.json`), JSON.stringify({ steps }))
  const tasks = Object.keys(scenarios).map(task => `  - { id: ${task}, title: ${task}, args: ['${task}.json'], resources: { input: ${input} }, expectedDuration: 10m }`).join('\n')
  const manifest = parseManifest(`id: ${id}\nname: ${id.toUpperCase()}\nlaunch: { exe: tool.exe }\ntasks:\n${tasks}\n${extra}`)
  return { id, dir, manifest }
}

const ok = (ms = 300) => [{ log: 'working' }, { sleepMs: ms }, { exit: 0 }]
const fail = (ms = 100) => [{ log: 'boom' }, { sleepMs: ms }, { exit: 2 }]

function setup(scripts: ReturnType<typeof script>[]) {
  const byId = new Map(scripts.map(s => [s.id, s]))
  const library = {
    get: (id: string) => {
      const s = byId.get(id)
      if (s === undefined) throw new Error(`no script ${id}`)
      return { id, name: id.toUpperCase(), source: { kind: 'local', path: s.dir }, dir: s.dir, versions: [], addedAt: 0 } as ScriptInfo
    },
    packOf: (id: string) => { const s = byId.get(id); return s === undefined ? undefined : { manifest: s.manifest } },
  }
  const runner = new Runner({
    library,
    dataDir: mkdtempSync(join(tmpdir(), 'adg-orch-data-')),
    emulators: () => ({ prepare: async () => ({ address: '127.0.0.1:16384', label: 'MuMu 0' }), expectedAddress: async () => '127.0.0.1:16384' }),
    onState: () => {},
    onLog: () => {},
    command: (_exe, args) => ({ file: process.execPath, args: [CLI, ...args] }),
    log: { info() {}, warn() {} },
    pollMs: 50,
  })
  const notices: EngineNotice[] = []
  const updates: string[] = []
  const runs: PipelineRun[] = []
  let emulatorStops = 0
  const engine = new Engine({
    runner,
    library,
    notices: () => ({ send: async n => { notices.push(n); return ['飞书'] }, update: async (id, p) => { updates.push(`${id}:${p.done}`) } }),
    conversations: () => ({ create: async () => 's-1', exists: async () => true, ask: async (_s, text) => `agent 看了：${text}` }),
    emulators: () => ({ stop: async () => { emulatorStops++ } }),
    onRun: run => runs.push(run),
    retryWaitingMs: 100,
    log: { info() {}, warn() {} },
  })
  return { runner, engine, library, notices, updates, runs, emulatorStops: () => emulatorStops }
}

const pipeline = (input: Omit<PipelineInput, 'id' | 'name'> & { id?: string; name?: string }) => Pipeline.parse({ id: 'p', name: '测试流水线', ...input })
const window = (runner: Runner, run: PipelineRun, nodeId: string) => {
  const info = runner.get(run.nodes[nodeId]!.runIds.at(-1)!)
  return [info.startedAt, info.endedAt!] as const
}

test('an emulator task and a desktop task run in parallel; the message waits for both', async () => {
  const maa = script('maa', 'adb', { daily: ok(600) })
  const m7 = script('m7', 'desktop', { main: ok(600) })
  const { runner, engine, notices, emulatorStops } = setup([maa, m7])
  const p = pipeline({
    nodes: [
      { id: 'maa', kind: 'script-task', scriptId: 'maa', taskId: 'daily' },
      { id: 'm7', kind: 'script-task', scriptId: 'm7', taskId: 'main' },
      { id: 'done', kind: 'notify', text: '日常都跑完了' },
    ],
    edges: [{ from: 'maa', to: 'done', when: 'always' }, { from: 'm7', to: 'done', when: 'always' }],
    stopEmulatorAfter: true,
  })
  const run = await engine.finished(engine.start(p, { kind: 'schedule' }).id)
  assert.equal(run.state, 'succeeded', run.outcome)
  const [aStart, aEnd] = window(runner, run, 'maa')
  const [bStart, bEnd] = window(runner, run, 'm7')
  assert.ok(aStart < bEnd && bStart < aEnd, 'the two runs overlapped')
  assert.equal(notices[0]?.text, '日常都跑完了')
  assert.match(notices.at(-1)!.title, /测试流水线：已完成/, 'an unattended run sends a summary')
  assert.equal(emulatorStops(), 1, 'the emulator is shut down afterwards')
  engine.dispose()
})

test('two desktop tasks drawn in parallel take turns: the check says so, the second waits for the resource', async () => {
  const a = script('a', 'desktop', { t: ok(500) })
  const b = script('b', 'desktop', { t: ok(300) })
  const { runner, engine, library, runs } = setup([a, b])
  const p = pipeline({ nodes: [{ id: 'a', kind: 'script-task', scriptId: 'a', taskId: 't' }, { id: 'b', kind: 'script-task', scriptId: 'b', taskId: 't' }] })
  const check = checkPipeline(p, library)
  assert.deepEqual(check.serialized.map(s => s.resource), ['桌面鼠标键盘'])
  assert.match(check.issues[0]!.message, /会自动排队依次运行/)
  assert.equal(check.estimateMinutes, 20, 'two 10-minute tasks on one resource')

  const run = await engine.finished(engine.start(p, { kind: 'manual' }).id)
  assert.equal(run.state, 'succeeded', run.outcome)
  const [aStart, aEnd] = window(runner, run, 'a')
  const [bStart, bEnd] = window(runner, run, 'b')
  assert.ok(aEnd <= bStart || bEnd <= aStart, 'no overlap')
  assert.ok(runs.some(r => Object.values(r.nodes).some(n => n.state === 'waiting' && /等待资源：桌面鼠标键盘/.test(n.detail ?? ''))), 'one of them showed it was waiting for the desktop')
  engine.dispose()
})

test('a failing node is retried, then the pipeline carries on: success edges skip, failure edges run, other branches finish', async () => {
  const bad = script('bad', 'none', { t: fail() })
  const good = script('good', 'none', { t: ok(200) })
  const { engine } = setup([bad, good])
  const p = pipeline({
    nodes: [
      { id: 'bad', kind: 'script-task', scriptId: 'bad', taskId: 't', onFailure: { retries: 1, then: 'continue' } },
      { id: 'after', kind: 'notify', text: '成功后' },
      { id: 'rescue', kind: 'notify', text: '失败后' },
      { id: 'good', kind: 'script-task', scriptId: 'good', taskId: 't' },
    ],
    edges: [{ from: 'bad', to: 'after' }, { from: 'bad', to: 'rescue', when: 'failure' }],
  })
  const run = await engine.finished(engine.start(p, { kind: 'manual' }).id)
  assert.equal(run.state, 'failed')
  assert.equal(run.nodes['bad']!.attempts, 2)
  assert.equal(run.nodes['bad']!.runIds.length, 2)
  assert.equal(run.nodes['after']!.state, 'skipped')
  assert.match(run.nodes['after']!.detail ?? '', /失败了，按连线条件跳过/)
  assert.equal(run.nodes['rescue']!.state, 'succeeded')
  assert.equal(run.nodes['good']!.state, 'succeeded')
  assert.match(run.outcome ?? '', /2 个成功，1 个失败，1 个跳过/)
  engine.dispose()
})

test('"then: stop" stops the pipeline: a parallel run is stopped and the rest is cancelled', async () => {
  const bad = script('bad', 'none', { t: fail(200) })
  const slow = script('slow', 'none', { t: ok(30_000) })
  const { runner, engine } = setup([bad, slow])
  const p = pipeline({
    onFailure: { retries: 0, then: 'stop' },
    nodes: [
      { id: 'bad', kind: 'script-task', scriptId: 'bad', taskId: 't' },
      { id: 'slow', kind: 'script-task', scriptId: 'slow', taskId: 't' },
      { id: 'next', kind: 'notify', text: 'x' },
    ],
    edges: [{ from: 'slow', to: 'next' }],
  })
  const run = await engine.finished(engine.start(p, { kind: 'manual' }).id)
  assert.equal(run.state, 'failed')
  assert.equal(run.nodes['slow']!.state, 'cancelled')
  assert.equal(runner.get(run.nodes['slow']!.runIds[0]!).state, 'cancelled', 'the parallel script run was stopped')
  assert.equal(run.nodes['next']!.state, 'cancelled')
  assert.match(run.outcome ?? '', /按设置停止流水线/)
  engine.dispose()
})

test('a gate waits for the user; stop ends the pipeline, continue goes on', async () => {
  const { engine, notices, updates } = setup([])
  const p = pipeline({ nodes: [{ id: 'g', kind: 'gate', text: '要继续吗' }, { id: 'n', kind: 'notify', text: '继续了' }], edges: [{ from: 'g', to: 'n' }] })
  const first = engine.start(p, { kind: 'manual' })
  await delay(50)
  assert.deepEqual(notices[0]?.actions?.map(a => a.id), ['continue', 'stop'])
  engine.gate(first.id, 'g', 'continue')
  const done = await engine.finished(first.id)
  assert.equal(done.state, 'succeeded')
  assert.equal(updates[0], `pipeline:${first.id}:g:已继续`)
  assert.throws(() => engine.gate(first.id, 'g', 'stop'), /没有正在进行|没有在等/)

  const second = engine.start(p, { kind: 'manual' })
  await delay(50)
  engine.gate(second.id, 'g', 'stop')
  const stopped = await engine.finished(second.id)
  assert.equal(stopped.state, 'failed')
  assert.equal(stopped.nodes['n']!.state, 'cancelled')
  engine.dispose()
})

test('a run the monitor restarts is followed to its replacement', async () => {
  const flaky = script('flaky', 'none', { t: [{ once: 'debug/.once', steps: [{ log: 'stuck' }, { sleepMs: 30_000 }] }, { log: 'fine' }, { exit: 0 }] })
  const { runner, engine } = setup([flaky])
  const p = pipeline({ nodes: [{ id: 'f', kind: 'script-task', scriptId: 'flaky', taskId: 't' }] })
  const started = engine.start(p, { kind: 'manual' })
  let firstRun: string | undefined
  for (let i = 0; i < 50 && firstRun === undefined; i++) { await delay(50); firstRun = engine.active()[0]?.nodes['f']?.runIds[0] }
  await delay(200)
  await runner.restart(firstRun!, '测试：L0 重启')
  const run = await engine.finished(started.id)
  assert.equal(run.state, 'succeeded', run.outcome)
  assert.equal(run.nodes['f']!.runIds.length, 2)
  assert.equal(run.nodes['f']!.attempts, 1, 'a restart is not a retry')
  engine.dispose()
})

test('cancel stops what is running; agent and wait nodes work', async () => {
  const slow = script('slow', 'none', { t: ok(30_000) })
  const { runner, engine } = setup([slow])
  const p = pipeline({
    nodes: [{ id: 'ask', kind: 'agent', prompt: '活动还剩几天' }, { id: 'w', kind: 'wait', minutes: 1 }, { id: 's', kind: 'script-task', scriptId: 'slow', taskId: 't' }],
    edges: [{ from: 'ask', to: 's' }],
  })
  const started = engine.start(p, { kind: 'manual' })
  for (let i = 0; i < 50 && engine.active()[0]?.nodes['s']?.state !== 'running'; i++) await delay(50)
  assert.throws(() => engine.start(p, { kind: 'manual' }), /正在运行/)
  engine.cancel(started.id, '用户取消')
  const run = await engine.finished(started.id)
  assert.equal(run.state, 'cancelled')
  assert.match(run.nodes['ask']!.detail ?? '', /^agent 看了：活动还剩几天\n\n（这是编排里的自动步骤.*不要用 ask_user_question 提问/, 'the agent is told nobody may be there to answer')
  assert.equal(run.nodes['w']!.state, 'cancelled')
  assert.equal(runner.get(run.nodes['s']!.runIds[0]!).state, 'cancelled')
  engine.dispose()
})

test('the check finds cycles, unknown scripts and tasks, and bad parameters; a broken pipeline does not start', () => {
  const s = script('s', 'none', { t: ok() }, '')
  s.manifest.tasks[0]!.params = { stage: { type: 'string', enum: ['1-7', 'CE-6'] } } as never
  const { engine, library } = setup([s])
  const cyclic = pipeline({ nodes: [{ id: 'a', kind: 'notify', text: 'a' }, { id: 'b', kind: 'notify', text: 'b' }], edges: [{ from: 'a', to: 'b' }, { from: 'b', to: 'a' }] })
  assert.match(checkPipeline(cyclic, library).issues[0]!.message, /成环/)
  const wrong = pipeline({ nodes: [
    { id: 'x', kind: 'script-task', scriptId: 'nope', taskId: 't' },
    { id: 'y', kind: 'script-task', scriptId: 's', taskId: 'missing' },
    { id: 'z', kind: 'script-task', scriptId: 's', taskId: 't', params: { stage: 'H8-4' } },
  ] })
  const issues = checkPipeline(wrong, library).issues.map(i => `${i.nodeId}:${i.message}`)
  assert.ok(issues.some(i => i.startsWith('x:脚本库里没有 nope')))
  assert.ok(issues.some(i => i.startsWith('y:') && i.includes('没有任务 missing')))
  assert.ok(issues.some(i => i.startsWith('z:') && i.includes('stage')), issues.join('\n'))
  assert.throws(() => engine.start(wrong, { kind: 'manual' }), /流水线有问题/)
  assert.throws(() => Pipeline.parse({ id: 'w', name: 'w', nodes: [{ id: 'w', kind: 'wait' }] }), /写分钟数或时间其中一个/)
  engine.dispose()
})

test('开始 and 结束: 结束 waits for every step, is never skipped, and neither is counted', async () => {
  const bad = script('bad', 'none', { t: fail() })
  const slow = script('slow', 'none', { t: ok(600) })
  const { engine, library } = setup([bad, slow])
  const p = pipeline({
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'bad', kind: 'script-task', scriptId: 'bad', taskId: 't' },
      { id: 'loose', kind: 'script-task', scriptId: 'slow', taskId: 't' }, // drawn without edges: still waited for
      { id: 'end', kind: 'end' },
    ],
    edges: [{ from: 'start', to: 'bad' }, { from: 'bad', to: 'end' }],
  })
  const run = await engine.finished(engine.start(p, { kind: 'manual' }).id)
  assert.equal(run.nodes['start']!.state, 'succeeded')
  assert.equal(run.nodes['end']!.state, 'succeeded', 'a success edge from a failed step does not skip 结束')
  assert.equal(run.nodes['end']!.detail, '结束（1 个失败）')
  assert.ok(run.nodes['end']!.startedAt! >= run.nodes['loose']!.endedAt!, '结束 came after the unconnected step')
  assert.match(run.outcome ?? '', /^1 个成功，1 个失败$/)

  const twice = checkPipeline(pipeline({ nodes: [{ id: 'a', kind: 'start' }, { id: 'b', kind: 'start' }, { id: 'e', kind: 'end' }], edges: [{ from: 'e', to: 'a' }] }), library)
  assert.deepEqual(twice.issues.filter(i => i.level === 'error').map(i => i.message).sort(), [
    '「开始」前面不能再连别的节点', '「结束」后面不能再连别的节点', '只能有一个「开始」节点', '流水线里还没有步骤',
  ])
  engine.dispose()
})

test('starting from a node: it and what follows run, the rest is passed over and does not block a step after it', async () => {
  const a = script('a', 'none', { t: ok(100) })
  const { engine } = setup([a])
  const p = pipeline({
    nodes: [
      { id: 'start', kind: 'start' },
      { id: 'first', kind: 'script-task', scriptId: 'a', taskId: 't' },
      { id: 'second', kind: 'script-task', scriptId: 'a', taskId: 't', title: '第二步' },
      { id: 'other', kind: 'notify', text: '另一支' },
      { id: 'join', kind: 'notify', text: '都完了' },
      { id: 'end', kind: 'end' },
    ],
    edges: [
      { from: 'start', to: 'first' }, { from: 'first', to: 'second' }, { from: 'start', to: 'other' },
      { from: 'second', to: 'join' }, { from: 'other', to: 'join' }, { from: 'join', to: 'end', when: 'always' },
    ],
  })
  const run = await engine.finished(engine.start(p, { kind: 'manual' }, { from: 'second' }).id)
  assert.deepEqual(Object.fromEntries(Object.entries(run.nodes).map(([id, n]) => [id, n.state])), {
    start: 'skipped', first: 'skipped', second: 'succeeded', other: 'skipped', join: 'succeeded', end: 'succeeded',
  }, '「都完了」waits on a passed-over branch and still runs')
  assert.equal(run.nodes['first']!.detail, '从「第二步」开始，没有运行')
  assert.equal(run.from, 'second')
  assert.equal(run.state, 'succeeded')
  assert.equal(run.outcome, '2 个成功；从「第二步」开始')
  assert.throws(() => engine.start(p, { kind: 'manual' }, { from: 'end' }), /不能从「结束」开始/)
  assert.throws(() => engine.start(p, { kind: 'manual' }, { from: 'nope' }), /没有节点 nope/)
  engine.dispose()
})

test('a retried node holds back what follows until the retry ends', async () => {
  // Fails on the first run, succeeds (slowly) on the second.
  const flaky = script('flaky', 'none', { t: [{ once: 'debug/.once', steps: [{ log: 'boom' }, { exit: 2 }] }, { log: 'working' }, { sleepMs: 800 }, { exit: 0 }] })
  const { engine, runner } = setup([flaky])
  const p = pipeline({
    nodes: [
      { id: 'a', kind: 'script-task', scriptId: 'flaky', taskId: 't', onFailure: { retries: 1, then: 'continue' } },
      { id: 'b', kind: 'notify', text: '下一步' },
    ],
    edges: [{ from: 'a', to: 'b', when: 'always' }],
  })
  const run = await engine.finished(engine.start(p, { kind: 'manual' }).id)
  assert.equal(run.nodes['a']!.state, 'succeeded')
  assert.equal(run.nodes['a']!.runIds.length, 2)
  const second = runner.get(run.nodes['a']!.runIds[1]!)
  assert.ok(run.nodes['b']!.startedAt! >= second.endedAt!, `b started ${second.endedAt! - run.nodes['b']!.startedAt!} ms before the retry ended`)
  engine.dispose()
})

test('a run restarted after it failed (the monitor, the agent, 重试) is followed: the next node waits for the rerun', async () => {
  const flaky = script('flaky2', 'none', { t: [{ once: 'debug/.once', steps: [{ log: 'boom' }, { exit: 2 }] }, { log: 'working' }, { sleepMs: 500 }, { exit: 0 }] })
  const { engine, runner } = setup([flaky])
  // Like the monitor: hold a failed run, decide a while later to run it again.
  const off = runner.watch({ state: run => {
    if (run.state !== 'failed' || run.retryOf !== undefined) return
    const release = runner.hold(run.id)
    setTimeout(() => { void runner.restart(run.id, '监控重试').finally(release) }, 400)
  } })
  const p = pipeline({
    nodes: [{ id: 'a', kind: 'script-task', scriptId: 'flaky2', taskId: 't' }, { id: 'b', kind: 'notify', text: '下一步' }],
    edges: [{ from: 'a', to: 'b', when: 'always' }],
  })
  const run = await engine.finished(engine.start(p, { kind: 'manual' }).id)
  off()
  assert.equal(run.nodes['a']!.state, 'succeeded', run.nodes['a']!.detail)
  assert.equal(run.nodes['a']!.runIds.length, 2, 'followed to the rerun')
  const rerun = runner.get(run.nodes['a']!.runIds[1]!)
  assert.ok(run.nodes['b']!.startedAt! >= rerun.endedAt!, 'b waited for the rerun')
  engine.dispose()
})
