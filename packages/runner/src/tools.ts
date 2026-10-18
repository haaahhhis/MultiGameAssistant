/**
 * Agent tools for running scripts. Running a library script's declared task is
 * what the user installed it for, so it needs no approval; what a task may
 * touch is fixed by its pack (config patches restored afterwards).
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ScriptId } from '@adg/protocol'
import { z } from 'zod'
import { readConfig, writeConfig } from './config.ts'
import type { LibraryView, Runner } from './runs.ts'

export const TOOL_NAMES = {
  tasks: 'script_tasks',
  run: 'script_run',
  stop: 'script_stop',
  runs: 'script_runs',
  configGet: 'script_config_get',
  configSet: 'script_config_set',
} as const

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
  return parsed.data
}

function tool(spec: {
  name: string
  description: string
  properties: Record<string, JsonSchemaNode>
  required?: string[]
  timeoutMs?: number
  readOnly?: boolean
  kind: 'read' | 'execute' | 'other'
  title(args: Record<string, unknown>): string
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties, ...(spec.required === undefined ? {} : { required: spec.required }), additionalProperties: false },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] },
    timeoutMs: spec.timeoutMs ?? 60_000,
    isConcurrencySafe: () => spec.readOnly === true,
    execute: async (args, exec) => json(await spec.execute(args, exec)),
    presentCall: args => ({ card: 'generic', title: spec.title((args ?? {}) as Record<string, unknown>), kind: spec.kind }),
  }
}

const brief = (runner: Runner, runId: string, lines = 15) => {
  const info = runner.get(runId)
  return {
    run_id: info.id, script: info.scriptId, task: info.taskId, state: info.state, outcome: info.outcome, params: info.params,
    resources: info.resources, tags: info.tags, warnings: info.warnings, exit_code: info.exitCode,
    last_lines: runner.logs(runId, lines).map(l => `[${l.source}] ${l.text}`),
  }
}

export function runnerTools(runner: Runner, config: { library: LibraryView; dataDir: string }): ToolDefinition[] {
  const id = { type: 'string', description: '脚本库里的脚本 id（script_list 可查）。' } as const
  const pathItem = { anyOf: [{ type: 'string' }, { type: 'integer' }] } as unknown as JsonSchemaNode
  return [
    tool({
      name: TOOL_NAMES.configGet,
      description: '读取脚本的一个配置文件（只能是脚本包声明的配置文件）。改设置前先读，弄清楚键的位置。',
      properties: { id, file: { type: 'string', description: '配置文件的相对路径，例如 config/gui.json。' } },
      required: ['id', 'file'],
      readOnly: true,
      kind: 'read',
      title: a => `读取配置：${String(a['id'] ?? '')} / ${String(a['file'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId, file: z.string().min(1).max(300) }), args)
        return readConfig(config.library, a.id, a.file)
      },
    }),
    tool({
      name: TOOL_NAMES.configSet,
      description: '修改脚本配置文件里的一个值（只能是脚本包声明的配置文件；JSON / YAML）。path 是键的数组，键里带点号时整体作为一个元素，例如 ["Configurations", "Default", "Start.RunDirectly"]。修改前会自动备份。这是修改脚本设置的唯一方式，不要直接写脚本目录里的文件。',
      properties: {
        id,
        file: { type: 'string', description: '配置文件的相对路径。' },
        path: { type: 'array', items: pathItem, description: '键路径。' },
        value: { description: '新的值（任意 JSON）。' },
      },
      required: ['id', 'file', 'path', 'value'],
      kind: 'other',
      title: a => `修改配置：${String(a['id'] ?? '')} / ${String(a['file'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId, file: z.string().min(1).max(300), path: z.array(z.union([z.string().min(1), z.number().int().min(0)])).min(1).max(20), value: z.unknown() }), args)
        const busy = runner.list(a.id).find(r => r.endedAt === undefined)
        if (busy !== undefined) throw new Error(`${a.id} 正在运行（${busy.taskTitle}），运行结束后再改配置，否则会被运行结束时的还原覆盖`)
        return { ok: true, ...(await writeConfig(config.library, config.dataDir, a.id, a.file, a.path, a.value)) }
      },
    }),
    tool({
      name: TOOL_NAMES.tasks,
      description: '列出一个脚本能运行的任务：任务 id、名称、用户可能的说法、参数（类型、默认值、可选值）、占用的资源（desktop 抢占鼠标键盘、adb 使用模拟器）。运行前先调用它把用户的话对应到任务和参数。',
      properties: { id },
      required: ['id'],
      readOnly: true,
      kind: 'read',
      title: a => `查看任务：${String(a['id'] ?? '')}`,
      execute: async args => runner.tasks(parse(z.object({ id: ScriptId }), args).id),
    }),
    tool({
      name: TOOL_NAMES.run,
      description: '运行脚本的一个任务。会按脚本包修改它的配置（结束后还原）、需要时先启动模拟器、启动脚本并跟踪日志。默认启动后立即返回 run_id；wait 为 true 时等到结束再返回结果。同一个脚本、同一台模拟器或桌面鼠标键盘被占用时会拒绝运行。',
      properties: {
        id,
        task: { type: 'string', description: '任务 id（script_tasks 可查）。' },
        params: { type: 'object', description: '任务参数，例如 {"stage": "1-7"}；省略的参数用默认值。' },
        wait: { type: 'boolean', description: '等运行结束再返回（最长 3 小时）。' },
      },
      required: ['id', 'task'],
      timeoutMs: 3 * 60 * 60_000,
      kind: 'execute',
      title: a => `运行：${String(a['id'] ?? '')} / ${String(a['task'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: ScriptId, task: z.string().min(1).max(64), params: z.record(z.string(), z.unknown()).nullish(), wait: z.boolean().nullish() }), args)
        const started = await runner.start(a.id, a.task, a.params ?? {})
        if (a.wait !== true || started.endedAt !== undefined) return brief(runner, started.id)
        const onAbort = () => void runner.stop(started.id)
        exec.signal.addEventListener('abort', onAbort, { once: true })
        try {
          await runner.finished(started.id)
        } finally {
          exec.signal.removeEventListener('abort', onAbort)
        }
        return brief(runner, started.id, 30)
      },
    }),
    tool({
      name: TOOL_NAMES.stop,
      description: '停止一个正在运行的任务（结束脚本进程并还原配置）。',
      properties: { run_id: { type: 'string', description: 'script_run 返回的 run_id。' } },
      required: ['run_id'],
      kind: 'other',
      title: a => `停止运行：${String(a['run_id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ run_id: z.string().min(1) }), args)
        await runner.stop(a.run_id)
        return brief(runner, a.run_id)
      },
    }),
    tool({
      name: TOOL_NAMES.runs,
      description: '查看最近的运行记录和它们最后几行日志；带 run_id 时返回这一次运行的详情和更多日志。',
      properties: { id: { ...id, description: '只看这个脚本的运行。' }, run_id: { type: 'string', description: '查看这一次运行。' } },
      readOnly: true,
      kind: 'read',
      title: () => '查看运行记录',
      execute: async args => {
        const a = parse(z.object({ id: ScriptId.nullish(), run_id: z.string().nullish() }), args)
        if (a.run_id !== undefined && a.run_id !== null) return brief(runner, a.run_id, 80)
        return { runs: runner.list(a.id ?? undefined).slice(0, 10).map(r => brief(runner, r.id, 5)) }
      },
    }),
  ]
}
