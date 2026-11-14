import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { parseManifest } from '@adg/pack-schema'
import type { ScriptInfo } from '@adg/protocol'
import type { Runner } from '../src/runs.ts'
import { runnerTools, TOOL_NAMES } from '../src/tools.ts'

const MANIFEST = parseManifest(`
id: tool
name: 工具
config:
  files:
    - { path: config.json, format: json }
launch:
  exe: Tool.exe
tasks:
  - id: daily
    title: 日常
    description: 跑一遍日常
    patches:
      - file: config.json
        set:
          - { path: [Run], value: true, note: 启动后直接开始 }
guide:
  overview: 自动做日常。
  checks: [工具没有在别处打开]
`)

test('script_tasks gives the pack\'s user guide when asked, without repeating its tasks', async () => {
  const listed = { tasks: [{ id: 'daily', title: '日常', utterances: [], params: {}, input: 'none' as const }], runnable: true }
  const runner = { tasks: async () => listed, profiles: { list: async () => ({ current: 'default', items: [] }) } } as unknown as Runner
  const library = { get: () => ({ id: 'tool' }) as ScriptInfo, packOf: () => ({ manifest: MANIFEST }) }
  const tasks = runnerTools(runner, { library, dataDir: '' }).find(t => t.name === TOOL_NAMES.tasks)!
  const exec = {} as ToolRunContext
  const plain = await tasks.execute({ id: 'tool' }, exec) as Record<string, unknown>
  assert.equal(plain['guide'], undefined)
  const withGuide = await tasks.execute({ id: 'tool', guide: true }, exec) as { tasks: unknown[]; guide: Record<string, unknown> }
  assert.equal(withGuide.tasks.length, 1)
  assert.equal(withGuide.guide['overview'], '自动做日常。')
  assert.deepEqual(withGuide.guide['checks'], ['工具没有在别处打开'])
  assert.equal(withGuide.guide['tasks'], undefined)
  assert.deepEqual((withGuide.guide['config'] as { changes: unknown[] }[])[0]!.changes, [{ key: 'Run', value: 'true', note: '启动后直接开始', tasks: ['日常'] }])
})
