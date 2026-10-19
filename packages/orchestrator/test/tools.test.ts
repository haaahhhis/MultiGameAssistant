import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseManifest } from '@adg/pack-schema'
import { Pipeline, type ScriptInfo } from '@adg/protocol'
import { runnerTools, type Runner } from '@adg/runner'
import { schemaProblems } from '../../test-kit/src/schema-lint.ts'
import type { Engine } from '../src/engine.ts'
import type { Pipelines } from '../src/pipelines.ts'
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
  assert.ok(tools.some(t => t.name === 'pipeline_draft') && tools.some(t => t.name === 'script_config_set'))
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
  const maa = pipeline.nodes[0]!
  assert.equal(maa.kind, 'script-task')
  assert.deepEqual(maa.kind === 'script-task' ? maa.params : {}, { stage: 'CE-6', medicine: 2, stone: true })
  assert.deepEqual(maa.onFailure, { retries: 1, then: 'continue' })
  assert.deepEqual(pipeline.nodes[1], { id: 'w', kind: 'wait', until: '05:00' })
  assert.deepEqual(pipeline.edges.map(e => e.when), ['always', 'success'])
  assert.deepEqual(pipeline.onFailure, { retries: 0, then: 'stop' })
})
