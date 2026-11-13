import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseManifest } from '@adg/pack-schema'
import { Pipeline, type ScriptInfo } from '@adg/protocol'
import { runnerTools, type Runner } from '@adg/runner'
import { schemaProblems } from '../../test-kit/src/schema-lint.ts'
import { PIPELINE_ROLE, type Engine } from '../src/engine.ts'
import { Pipelines } from '../src/pipelines.ts'
import type { PipelineStore } from '../src/store.ts'
import { draftToPipeline, pipelineTools } from '../src/tools.ts'

const manifest = parseManifest(`id: maa
name: MAA
launch: { exe: MAA.exe }
tasks:
  - id: daily
    title: 日常
    params:
      stage: { type: string, default: '1-7' }
      medicine: { type: integer, default: 0 }
      stone: { type: boolean, default: false }
`)
const library = {
  get: (id: string) => ({ id, name: 'MAA', source: { kind: 'local', path: 'C:/maa' }, dir: 'C:/maa', versions: [], addedAt: 0 }) as ScriptInfo,
  packOf: () => ({ manifest }),
}

test('every runner and pipeline tool has a strict schema (no free-form values a model can stall on)', () => {
  const tools = [
    ...runnerTools({} as Runner, { library, dataDir: 'C:/data' }),
    ...pipelineTools({} as Pipelines, {} as Engine, library),
  ]
  for (const tool of tools) assert.deepEqual(schemaProblems(tool.parameters), [], tool.name)
  assert.ok(tools.some(t => t.name === 'pipeline_draft') && tools.some(t => t.name === 'pipeline_save') && tools.some(t => t.name === 'script_config_set'))
})

test('pipeline_draft arguments become a pipeline, parameter strings typed by the task', () => {
  const pipeline = Pipeline.parse(draftToPipeline({
    id: 'daily', name: '每日',
    nodes: [
      { id: 'maa', kind: 'script-task', script_id: 'maa', task_id: 'daily', params: [{ name: 'stage', value: 'CE-6' }, { name: 'medicine', value: '2' }, { name: 'stone', value: 'true' }], retries: 1 },
      { id: 'w', kind: 'wait', until: '05:00' },
      { id: 'n', kind: 'notify', text: '完成' },
    ],
    edges: [{ from: 'maa', to: 'n', when: 'always' }, { from: 'w', to: 'n' }],
    then: 'stop',
  }, library))
  assert.deepEqual(pipeline.nodes.map(n => n.kind), ['start', 'script-task', 'wait', 'notify', 'end'], 'with 开始 and 结束 added')
  const maa = pipeline.nodes[1]!
  assert.equal(maa.kind, 'script-task')
  assert.deepEqual(maa.kind === 'script-task' ? maa.params : {}, { stage: 'CE-6', medicine: 2, stone: true })
  assert.deepEqual(maa.onFailure, { retries: 1, then: 'continue' })
  assert.deepEqual(pipeline.nodes[2], { id: 'w', kind: 'wait', until: '05:00' })
  assert.deepEqual(pipeline.edges.map(e => `${e.from}>${e.to}:${e.when}`), ['maa>n:always', 'w>n:success', 'start>maa:success', 'start>w:success', 'n>end:always'],
    '开始 leads to the steps nothing leads to; the steps that lead nowhere lead to 结束')
  assert.deepEqual(pipeline.onFailure, { retries: 0, then: 'stop' })
})

test('编排 saves a pipeline outright, over one the user saved; a draft from another agent cannot', async () => {
  const written: Pipeline[] = []
  const store = { load: async () => ({ pipelines: [], runs: [] }), save: async (p: Pipeline) => { written.push(p) }, remove: async () => {}, saveRuns: async () => {} } as unknown as PipelineStore
  let now = 1000
  const pipelines = new Pipelines({ store, library, engine: { isRunning: () => false, active: () => [] } as unknown as Engine, changed: () => {}, now: () => now++ })
  const tools = pipelineTools(pipelines, {} as Engine, library)
  const call = (name: string, args: unknown) => tools.find(t => t.name === name)!.execute(args as never, {} as never) as Promise<Record<string, unknown>>

  assert.ok(PIPELINE_ROLE.tools?.includes('pipeline_save') && PIPELINE_ROLE.tools.includes('pipeline_run') && PIPELINE_ROLE.tools.includes('schedule_set'), 'the role has the tools to change, time and start pipelines')
  assert.ok(!PIPELINE_ROLE.tools.includes('pipeline_draft') && !PIPELINE_ROLE.tools.includes('pipeline_*'), 'and no draft tool beside the one that saves')

  // The user's pipeline: placed on the canvas, timed, with its own options.
  await pipelines.save(Pipeline.parse({
    id: 'daily', name: '每日', description: '每天的日常',
    nodes: [
      { id: 'start', kind: 'start', position: { x: -200, y: 40 } },
      { id: 'maa', kind: 'script-task', scriptId: 'maa', taskId: 'daily', params: { stage: '1-7' }, position: { x: 40, y: 40 }, onFailure: { retries: 2, then: 'continue' } },
      { id: 'done', kind: 'notify', text: '完成', position: { x: 340, y: 40 } },
      { id: 'end', kind: 'end', position: { x: 640, y: 40 } },
    ],
    edges: [{ from: 'start', to: 'maa', when: 'success' }, { from: 'maa', to: 'done', when: 'success' }, { from: 'done', to: 'end', when: 'always' }],
    onFailure: { retries: 1, then: 'continue' },
    schedule: { enabled: true, times: ['04:30'], days: [], catchUpMinutes: 30 },
    stopEmulatorAfter: true, closeGameAfter: true, powerAfter: 'sleep',
  }), 'user')

  const change = {
    id: 'daily', name: '每日',
    nodes: [
      { id: 'maa', kind: 'script-task', script_id: 'maa', task_id: 'daily', params: [{ name: 'stage', value: '1-7' }], retries: 2 },
      { id: 'again', kind: 'script-task', script_id: 'maa', task_id: 'daily', title: '再跑一次' },
      { id: 'done', kind: 'notify', text: '完成' },
    ],
    edges: [{ from: 'maa', to: 'again', when: 'always' }, { from: 'again', to: 'done', when: 'always' }],
    close_game_after: false,
  }
  await assert.rejects(call('pipeline_draft', change), /草稿不能覆盖.*交给「编排」/, 'a draft does not replace a saved pipeline')
  assert.equal(pipelines.get('daily').nodes.length, 4, 'left as it was')

  const saved = await call('pipeline_save', change)
  assert.equal(saved['saved'], 'updated')
  assert.equal(saved['ok'], true, JSON.stringify(saved['check']))
  const daily = pipelines.get('daily')
  assert.deepEqual(written.at(-1), daily, 'written to disk')
  assert.equal(daily.draft, undefined, 'saved, not a draft')
  assert.deepEqual(daily.nodes.map(n => n.id), ['start', 'maa', 'again', 'done', 'end'])
  assert.deepEqual(daily.edges.map(e => `${e.from}>${e.to}:${e.when}`), ['maa>again:always', 'again>done:always', 'start>maa:success', 'done>end:always'], 'the old maa>done is gone')
  assert.deepEqual(daily.nodes.map(n => n.position), [{ x: -200, y: 40 }, { x: 40, y: 40 }, undefined, { x: 340, y: 40 }, { x: 640, y: 40 }], 'the nodes it kept stay where the user put them')
  assert.deepEqual(daily.nodes[1]!.onFailure, { retries: 2, then: 'continue' })
  assert.deepEqual(daily.schedule, { enabled: true, times: ['04:30'], days: [], catchUpMinutes: 30 }, 'still timed')
  assert.deepEqual([daily.description, daily.onFailure, daily.stopEmulatorAfter, daily.closeGameAfter, daily.powerAfter], ['每天的日常', { retries: 1, then: 'continue' }, true, false, 'sleep'], 'options left out keep their values; the one given changes')
  assert.equal(daily.createdAt, 1000)
  assert.ok((daily.updatedAt ?? 0) > 1000)

  // Copied back from pipeline_get with 开始 and 结束 in it: taken as they are.
  const whole = await call('pipeline_save', { ...change, nodes: [{ id: 'start', kind: 'start' }, ...change.nodes, { id: 'end', kind: 'end' }], edges: [{ from: 'start', to: 'maa' }, ...change.edges, { from: 'done', to: 'end', when: 'always' }] })
  assert.equal(whole['ok'], true, JSON.stringify(whole['check']))
  assert.deepEqual(pipelines.get('daily').nodes.map(n => n.kind), ['start', 'script-task', 'script-task', 'notify', 'end'])
  assert.deepEqual(pipelines.get('daily').nodes[0]!.position, { x: -200, y: 40 })

  // A new one is saved at once; a draft becomes a saved pipeline when 编排 saves it.
  const fresh = await call('pipeline_save', { id: 'weekly', name: '每周', nodes: [{ id: 'n', kind: 'notify', text: '周常' }] })
  assert.equal(fresh['saved'], 'created')
  assert.equal(pipelines.get('weekly').draft, undefined)
  await call('pipeline_draft', { id: 'idea', name: '想法', nodes: [{ id: 'n', kind: 'notify', text: '草稿' }] })
  assert.equal(pipelines.get('idea').draft, true)
  await call('pipeline_save', { id: 'idea', name: '想法', nodes: [{ id: 'n', kind: 'notify', text: '定了' }] })
  assert.equal(pipelines.get('idea').draft, undefined)
})

test('the planning skill parses; hardware advice goes serial unless the machine is clearly big enough', async () => {
  const { readFile } = await import('node:fs/promises')
  const { parseGuide } = await import('../src/index.ts')
  const { advise, systemInfo } = await import('../src/system.ts')
  const guide = parseGuide(await readFile(new URL('../skills/pipeline-planning.md', import.meta.url), 'utf8'))
  assert.equal(guide?.name, 'pipeline-planning')
  assert.match(guide?.content ?? '', /system_info/)
  assert.match(guide?.content ?? '', /when: always/)

  const small = advise({ memory: { totalGB: 15.9, freeGB: 6 }, gpus: [{ name: 'Intel(R) UHD Graphics 770' }], cpu: { name: 'i5', threads: 12 } })
  assert.match(small, /一次只跑一个游戏/)
  const big = advise({ memory: { totalGB: 63.8, freeGB: 40 }, gpus: [{ name: 'NVIDIA GeForce RTX 4070', memoryGB: 12 }], cpu: { name: 'i7', threads: 20 } })
  assert.match(big, /可以同时跑一个模拟器游戏和一个 PC 游戏/)

  const info = await systemInfo()
  assert.ok(info.memory.totalGB > 0 && info.cpu.threads > 0, JSON.stringify(info))
  assert.equal(typeof info.advice, 'string')
})
