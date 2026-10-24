/**
 * Agent tools for pipelines. The agent drafts (the user saves it in the
 * 编排 page before it runs on a schedule), runs, and reads status; schedules
 * it may set when the user asks ("每天四点半跑").
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ClockTime, Pipeline, PipelineId, PowerAction, withStartEnd, type PipelineInput, type PipelineRun } from '@adg/protocol'
import { systemInfo } from './system.ts'
import { PARAMS_SCHEMA, taskParams } from '@adg/runner'
import { z } from 'zod'
import type { CheckLibrary } from './check.ts'
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

const DRAFT_HELP = `先按 pipeline-planning 技能：调用 system_info 看电脑带不带得动，默认一次只跑一个游戏（串行），串行的连线用 always，这样一个游戏失败不影响后面的。
流水线是一个 DAG：nodes 是步骤，edges 是先后关系（from 完成后才运行 to；同一个节点的多个下游并行）。
节点 kind：script-task（填 script_id、task_id、params，script_tasks 可查任务和参数）、agent（填 prompt）、wait（填 minutes，或 until 写 HH:MM）、notify（填 text，发飞书）、gate（填 text，等用户确认）。
连线 when：success（默认）/ failure / always。失败处理：节点或整条流水线的 retries（重试次数）和 then（continue 继续其他分支 / stop 停止流水线），默认不重试、继续。
需要同一资源（桌面鼠标键盘、同一台模拟器、同一账号）的并行节点会自动排队，不用自己串起来；只在有真正的先后依赖时才连线。
例：MAA（模拟器）和三月七（桌面）并行，都完成后发飞书——nodes：maa（script-task，script_id maa，task_id daily）、m7（script-task，script_id march7th，task_id main）、done（notify，text「日常都跑完了」）；edges：maa→done（always）、m7→done（always）。`

/** Every field typed: a free-form object here makes some models stall emitting whitespace. */
const DRAFT_SCHEMA: Record<string, JsonSchemaNode> = {
  id: { type: 'string', description: '流水线 id：小写字母、数字、短横线，例如 daily-routine。' },
  name: { type: 'string', description: '给人看的名字。' },
  description: { type: 'string', description: '一句话说明（可选）。' },
  nodes: {
    type: 'array',
    description: '步骤。',
    items: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '节点 id（字母数字）。' },
        kind: { type: 'string', enum: ['script-task', 'agent', 'wait', 'notify', 'gate'] },
        title: { type: 'string', description: '名称（可选）。' },
        script_id: { type: 'string', description: 'script-task：脚本 id。' },
        task_id: { type: 'string', description: 'script-task：任务 id。' },
        params: { ...PARAMS_SCHEMA, description: 'script-task：任务参数。' },
        prompt: { type: 'string', description: 'agent：要 agent 做的事。' },
        minutes: { type: 'integer', description: 'wait：等几分钟。' },
        until: { type: 'string', description: 'wait：等到 HH:MM。' },
        text: { type: 'string', description: 'notify / gate：文字。' },
        retries: { type: 'integer', description: '失败后重试几次（可选）。' },
        then: { type: 'string', enum: ['continue', 'stop'], description: '仍失败时（可选）。' },
        wait_for_all: { type: 'boolean', description: '等前面（不在它之后）的节点全部结束再开始，不只看连进来的线；用来让并行的几条分支汇合（可选）。' },
      },
      required: ['id', 'kind'],
      additionalProperties: false,
    },
  } as JsonSchemaNode,
  edges: {
    type: 'array',
    description: '先后关系。',
    items: {
      type: 'object',
      properties: { from: { type: 'string' }, to: { type: 'string' }, when: { type: 'string', enum: ['success', 'failure', 'always'] } },
      required: ['from', 'to'],
      additionalProperties: false,
    },
  } as JsonSchemaNode,
  retries: { type: 'integer', description: '整条流水线的默认重试次数（可选）。' },
  then: { type: 'string', enum: ['continue', 'stop'], description: '整条流水线的默认失败处理（可选）。' },
  stop_emulator_after: { type: 'boolean', description: '结束后关闭模拟器（可选）。' },
  close_game_after: { type: 'boolean', description: '结束后关闭这些任务玩过的游戏（可选）。' },
  power_after: { type: 'string', enum: ['none', 'sleep', 'hibernate', 'shutdown'], description: '结束后（且没有别的任务在跑时）电脑睡眠 / 休眠 / 关机，先倒计时、可以取消；界面里手动运行时不执行。只有用户明确要求时才设置（可选）。' },
}

const DraftArgs = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().nullish(),
  nodes: z.array(z.object({
    id: z.string(),
    kind: z.enum(['script-task', 'agent', 'wait', 'notify', 'gate']),
    title: z.string().nullish(),
    script_id: z.string().nullish(),
    task_id: z.string().nullish(),
    params: z.array(z.object({ name: z.string(), value: z.string() })).nullish(),
    prompt: z.string().nullish(),
    minutes: z.number().int().nullish(),
    until: z.string().nullish(),
    text: z.string().nullish(),
    retries: z.number().int().nullish(),
    then: z.enum(['continue', 'stop']).nullish(),
    wait_for_all: z.boolean().nullish(),
  })).max(60),
  edges: z.array(z.object({ from: z.string(), to: z.string(), when: z.enum(['success', 'failure', 'always']).nullish() })).max(200).nullish(),
  retries: z.number().int().nullish(),
  then: z.enum(['continue', 'stop']).nullish(),
  stop_emulator_after: z.boolean().nullish(),
  close_game_after: z.boolean().nullish(),
  power_after: PowerAction.nullish(),
})

const given = <T>(v: T | null | undefined): v is T => v !== null && v !== undefined

/** The flat tool arguments → a pipeline (parameter strings converted to each task's types). */
export function draftToPipeline(args: z.infer<typeof DraftArgs>, library: CheckLibrary): PipelineInput {
  return withStartEnd({
    id: args.id,
    name: args.name,
    ...(given(args.description) ? { description: args.description } : {}),
    nodes: args.nodes.map(n => {
      const base = {
        id: n.id,
        ...(given(n.title) ? { title: n.title } : {}),
        ...(given(n.retries) || given(n.then) ? { onFailure: { retries: n.retries ?? 0, then: n.then ?? 'continue' } } : {}),
        ...(n.wait_for_all === true ? { waitForAll: true } : {}),
      }
      switch (n.kind) {
        case 'script-task': {
          const scriptId = n.script_id ?? ''
          const taskId = n.task_id ?? ''
          const spec = library.packOf(scriptId)?.manifest.tasks.find(t => t.id === taskId)?.params ?? {}
          return { ...base, kind: 'script-task' as const, scriptId, taskId, params: taskParams(n.params, spec) as Record<string, string | number | boolean> }
        }
        case 'agent': return { ...base, kind: 'agent' as const, prompt: n.prompt ?? '' }
        case 'wait': return { ...base, kind: 'wait' as const, ...(given(n.until) ? { until: n.until } : { minutes: n.minutes ?? 1 }) }
        case 'notify': return { ...base, kind: 'notify' as const, text: n.text ?? '' }
        case 'gate': return { ...base, kind: 'gate' as const, text: n.text ?? '' }
      }
    }),
    edges: (args.edges ?? []).map(e => ({ from: e.from, to: e.to, when: e.when ?? 'success' })),
    ...(given(args.retries) || given(args.then) ? { onFailure: { retries: args.retries ?? 0, then: args.then ?? 'continue' } } : {}),
    ...(given(args.stop_emulator_after) ? { stopEmulatorAfter: args.stop_emulator_after } : {}),
    ...(given(args.close_game_after) ? { closeGameAfter: args.close_game_after } : {}),
    ...(given(args.power_after) ? { powerAfter: args.power_after } : {}),
  })
}

export function pipelineTools(pipelines: Pipelines, engine: Engine, library: CheckLibrary, system: () => Promise<unknown> = systemInfo): ToolDefinition[] {
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
      properties: DRAFT_SCHEMA,
      required: ['id', 'name', 'nodes'],
      kind: 'other',
      title: a => `生成流水线草稿：${String(a['name'] ?? '')}`,
      execute: async args => {
        const draft = parse(Pipeline, draftToPipeline(parse(DraftArgs, args), library))
        const { pipeline, check } = await pipelines.save(draft, 'agent')
        const link = `#/p/pipelines/${encodeURIComponent(pipeline.id)}`
        return {
          ok: check.ok, id: pipeline.id, check, link,
          next: check.ok
            ? `告诉用户草稿已保存在「编排」页，可以直接运行或先看看；回复里附上链接 [在编排页打开](${link})。每天定时运行要在编排页保存后，在「定时与失败」里设置时间；开机自动运行在 [设置 → 定时与自启](#/settings/schedule)`
            : '修正 check.issues 里的 error 后重新提交',
        }
      },
    }),
    tool({
      name: 'pipeline_run',
      description: '运行一条流水线。立即返回 run_id；wait 为 true 时等到结束（最长 6 小时）。同一条流水线正在运行时会拒绝。用户说「从某一步开始」「前面的已经跑过了」时用 from_node：这个节点和它后面的会运行，前面的不运行。',
      properties: { id, wait: { type: 'boolean', description: '等运行结束再返回。' }, from_node: { type: 'string', description: '从这个节点开始（节点 id，pipeline_get 可查）；不填就从头运行。' } },
      required: ['id'],
      timeoutMs: 6 * 60 * 60_000,
      kind: 'execute',
      title: a => `运行流水线：${String(a['id'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: PipelineId, wait: z.boolean().nullish(), from_node: z.string().nullish() }), args)
        const run = pipelines.run(a.id, { kind: 'agent' }, a.from_node ?? undefined)
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
    tool({
      name: 'system_info',
      description: '查看这台电脑的配置和当前负载：CPU、内存、显卡（显存）、屏幕、系统盘剩余空间，以及「一次能跑几个游戏」的建议。编排多个游戏、判断能不能并行之前先调用；不需要 shell。',
      properties: {},
      readOnly: true,
      timeoutMs: 60_000,
      kind: 'read',
      title: () => '查看电脑配置',
      execute: () => system(),
    }),
  ]
}
