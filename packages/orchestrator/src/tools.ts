/**
 * Agent tools for pipelines. The agent drafts (the user saves it in the
 * 编排 page before it runs on a schedule), runs, and reads status; schedules
 * it may set when the user asks ("每天四点半跑").
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ClockTime, Pipeline, PipelineId, type PipelineRun } from '@adg/protocol'
import { z } from 'zod'
import type { Engine } from './engine.ts'
import type { Pipelines } from './pipelines.ts'

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
    execute: async (args, exec) => JSON.parse(JSON.stringify(await spec.execute(args, exec) ?? null)) as never,
    presentCall: args => ({ card: 'generic', title: spec.title((args ?? {}) as Record<string, unknown>), kind: spec.kind }),
  }
}

const brief = (run: PipelineRun, pipelines: Pipelines) => {
  const pipeline = pipelines.has(run.pipelineId) ? pipelines.get(run.pipelineId) : undefined
  return {
    run_id: run.id, pipeline: run.pipelineName, state: run.state, outcome: run.outcome, trigger: run.trigger.kind,
    started: new Date(run.startedAt).toISOString(),
    nodes: Object.entries(run.nodes).map(([id, n]) => ({ id, title: pipeline?.nodes.find(x => x.id === id)?.title, state: n.state, detail: n.detail, runs: n.runIds })),
  }
}

const DRAFT_HELP = `流水线是一个 DAG：nodes 是步骤，edges 是先后关系（from 完成后才运行 to；同一个节点的多个下游并行）。
节点（id 用字母数字，title 给人看）：
- {"id":"maa","kind":"script-task","scriptId":"maa","taskId":"daily","params":{}}  脚本任务（script_tasks 查任务和参数）
- {"id":"ask","kind":"agent","prompt":"检查活动还剩几天"}  交给 agent 的一步
- {"id":"w","kind":"wait","minutes":10} 或 {"kind":"wait","until":"05:00"}
- {"id":"n","kind":"notify","text":"日常跑完了"}  发飞书
- {"id":"g","kind":"gate","text":"确认要继续吗"}  等用户确认
连线 {"from":"maa","to":"n","when":"success"}，when 可为 success（默认）/ failure / always。
失败策略 onFailure：{"retries":1,"then":"continue"|"stop"}，写在节点上或整条流水线上（默认不重试、继续其他分支）。
需要同一资源（桌面鼠标键盘、同一台模拟器、同一账号）的并行节点会自动排队，不用自己串起来；只在有真正的先后依赖时才连线。
例：MAA（模拟器）和三月七（桌面）并行，都完成后发飞书：
{"id":"daily","name":"每日日常","nodes":[{"id":"maa","kind":"script-task","scriptId":"maa","taskId":"daily"},{"id":"m7","kind":"script-task","scriptId":"march7th","taskId":"main"},{"id":"done","kind":"notify","text":"日常都跑完了"}],"edges":[{"from":"maa","to":"done","when":"always"},{"from":"m7","to":"done","when":"always"}]}`

export function pipelineTools(pipelines: Pipelines, engine: Engine): ToolDefinition[] {
  const id = { type: 'string', description: '流水线 id（pipeline_list 可查）。' } as const
  return [
    tool({
      name: 'pipeline_list',
      description: '列出已有的流水线（编排好的多脚本任务组合）：名称、节点数、定时设置、最近一次运行。用户说「跑一下每日日常」这类名字时先在这里找。',
      properties: {},
      readOnly: true,
      kind: 'read',
      title: () => '查看流水线',
      execute: async () => ({ pipelines: pipelines.list() }),
    }),
    tool({
      name: 'pipeline_get',
      description: '读取一条流水线的完整定义（节点、连线、失败策略、定时），以及运行前检查的结果（会排队的并行分支、预计时长）。',
      properties: { id },
      required: ['id'],
      readOnly: true,
      kind: 'read',
      title: a => `读取流水线：${String(a['id'] ?? '')}`,
      execute: async args => {
        const pipeline = pipelines.get(parse(z.object({ id: PipelineId }), args).id)
        return { pipeline, check: pipelines.check(pipeline) }
      },
    }),
    tool({
      name: 'pipeline_draft',
      description: `按用户的描述生成一条流水线草稿并保存，用户会在「编排」页看到、可以拖拽修改；草稿可以立即用 pipeline_run 运行，但用户在界面里保存之前不会按定时运行。不能覆盖用户保存过的流水线（换个 id）。返回运行前检查的结果，有 error 要修正后重新提交。\n${DRAFT_HELP}`,
      properties: { pipeline: { type: 'object', description: '流水线定义：{id, name, description?, nodes, edges, onFailure?, stopEmulatorAfter?}。' } },
      required: ['pipeline'],
      kind: 'other',
      title: a => `生成流水线草稿：${String((a['pipeline'] as { name?: unknown } | undefined)?.name ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ pipeline: Pipeline }), args)
        const { pipeline, check } = await pipelines.save(a.pipeline, 'agent')
        return { ok: check.ok, id: pipeline.id, check, next: check.ok ? '告诉用户草稿已保存在「编排」页，可以直接运行或先看看' : '修正 check.issues 里的 error 后重新提交' }
      },
    }),
    tool({
      name: 'pipeline_run',
      description: '运行一条流水线。立即返回 run_id；wait 为 true 时等到结束（最长 6 小时）。同一条流水线正在运行时会拒绝。',
      properties: { id, wait: { type: 'boolean', description: '等运行结束再返回。' } },
      required: ['id'],
      timeoutMs: 6 * 60 * 60_000,
      kind: 'execute',
      title: a => `运行流水线：${String(a['id'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: PipelineId, wait: z.boolean().nullish() }), args)
        const run = pipelines.run(a.id, { kind: 'agent' })
        if (a.wait !== true) return brief(run, pipelines)
        const onAbort = () => { try { engine.cancel(run.id, 'agent 取消') } catch { /* already over */ } }
        exec.signal.addEventListener('abort', onAbort, { once: true })
        try {
          return brief(await engine.finished(run.id), pipelines)
        } finally {
          exec.signal.removeEventListener('abort', onAbort)
        }
      },
    }),
    tool({
      name: 'pipeline_status',
      description: '查看流水线的运行情况：每个节点的状态（等待资源、运行中、成功、失败、跳过）和对应的脚本运行 id（用 script_runs 看日志）。不带参数时列出最近的运行。',
      properties: { run_id: { type: 'string', description: 'pipeline_run 返回的 run_id。' }, id: { ...id, description: '只看这条流水线的运行。' } },
      readOnly: true,
      kind: 'read',
      title: () => '查看流水线运行',
      execute: async args => {
        const a = parse(z.object({ run_id: z.string().nullish(), id: PipelineId.nullish() }), args)
        const runs = pipelines.runs(a.id ?? undefined, a.run_id === undefined || a.run_id === null ? 5 : 100)
        if (a.run_id !== undefined && a.run_id !== null) {
          const run = runs.find(r => r.id === a.run_id)
          if (run === undefined) throw new Error(`没有流水线运行 ${a.run_id}`)
          return brief(run, pipelines)
        }
        return { runs: runs.map(r => brief(r, pipelines)) }
      },
    }),
    tool({
      name: 'schedule_set',
      description: '设置一条流水线的定时：每天（或指定星期几）的几个时间点自动运行；错过不超过 catch_up_minutes 分钟（电脑睡眠、刚开机）会补跑。用户说「每天四点半跑日常」时使用。草稿要用户在界面保存后才会按定时运行。',
      properties: {
        id,
        enabled: { type: 'boolean', description: '开启或关闭定时。' },
        times: { type: 'array', items: { type: 'string' }, description: '时间点，HH:MM，例如 ["04:30", "16:30"]。' },
        days: { type: 'array', items: { type: 'integer' }, description: '星期几：0 周日 … 6 周六；空数组表示每天。' },
        catch_up_minutes: { type: 'integer', description: '补跑宽限（分钟，默认 10）。' },
      },
      required: ['id'],
      kind: 'other',
      title: a => `设置定时：${String(a['id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: PipelineId, enabled: z.boolean().nullish(), times: z.array(ClockTime).max(12).nullish(), days: z.array(z.number().int().min(0).max(6)).nullish(), catch_up_minutes: z.number().int().min(0).max(720).nullish() }), args)
        const current = pipelines.get(a.id)
        const schedule = {
          ...current.schedule,
          ...(a.enabled == null ? {} : { enabled: a.enabled }),
          ...(a.times == null ? {} : { times: a.times }),
          ...(a.days == null ? {} : { days: a.days }),
          ...(a.catch_up_minutes == null ? {} : { catchUpMinutes: a.catch_up_minutes }),
        }
        const { pipeline } = await pipelines.save({ ...current, schedule }, current.draft === true ? 'agent' : 'user')
        return { ok: true, schedule: pipeline.schedule, note: pipeline.draft === true ? '这是草稿：用户在「编排」页保存后才会按定时运行' : undefined }
      },
    }),
  ]
}
