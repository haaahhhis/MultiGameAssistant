/**
 * `pipelines@1`: pipelines (DAGs of script tasks and other steps), their
 * feasibility check and runs — served by `@adg/orchestrator`; `schedule@1`:
 * when pipelines run by themselves and what happens at logon — served by
 * `@adg/scheduler` (docs/PLAN.zh.md §5.3, §5.9).
 */
import { z } from 'zod'
import { ScriptId } from './scripts.ts'

export const PIPELINES_CAPABILITY = 'pipelines'
export const SCHEDULE_CAPABILITY = 'schedule'

export const PipelineId = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '小写字母、数字和短横线').max(64)
export const NodeId = z.string().regex(/^[A-Za-z0-9_-]{1,40}$/)
/** Local wall-clock time, 24-hour `HH:MM`. */
export const ClockTime = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '时间写成 HH:MM，例如 04:30')

/** What happens when a node fails: try again, then carry on with the other branches or stop the pipeline. */
export const FailurePolicy = z.object({
  retries: z.number().int().min(0).max(5).default(0),
  then: z.enum(['continue', 'stop']).default('continue'),
})
export type FailurePolicy = z.infer<typeof FailurePolicy>

const NodeBase = {
  id: NodeId,
  title: z.string().max(60).optional(),
  /** Canvas position. */
  position: z.object({ x: z.number(), y: z.number() }).optional(),
  onFailure: FailurePolicy.optional(),
}

export const PipelineNode = z.discriminatedUnion('kind', [
  /** A script's task with parameters (from its pack). */
  z.object({ ...NodeBase, kind: z.literal('script-task'), scriptId: ScriptId, taskId: z.string().min(1).max(64), params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).default({}) }),
  /** A step in plain words for the agent, e.g. "检查活动还剩几天，快结束的发飞书提醒我". */
  z.object({ ...NodeBase, kind: z.literal('agent'), prompt: z.string().min(1).max(4000) }),
  /** Wait some minutes, or until a time of day. */
  z.object({ ...NodeBase, kind: z.literal('wait'), minutes: z.number().int().min(1).max(1440).optional(), until: ClockTime.optional() })
    .refine(n => (n.minutes === undefined) !== (n.until === undefined), '等待节点写分钟数或时间其中一个'),
  /** Send a message to the chat channels (Feishu). */
  z.object({ ...NodeBase, kind: z.literal('notify'), text: z.string().min(1).max(2000) }),
  /** Ask the user to continue or stop (UI or a Feishu card). */
  z.object({ ...NodeBase, kind: z.literal('gate'), text: z.string().min(1).max(2000) }),
])
export type PipelineNode = z.infer<typeof PipelineNode>

export const PipelineEdge = z.object({
  from: NodeId,
  to: NodeId,
  /** Run `to` when `from` succeeded (default), failed, or either. */
  when: z.enum(['success', 'failure', 'always']).default('success'),
})
export type PipelineEdge = z.infer<typeof PipelineEdge>

export const PipelineSchedule = z.object({
  enabled: z.boolean().default(false),
  times: z.array(ClockTime).max(12).default([]),
  /** 0 = Sunday … 6 = Saturday; empty = every day. */
  days: z.array(z.number().int().min(0).max(6)).max(7).default([]),
  /** A time missed by at most this many minutes (sleep, the computer was off) still runs. */
  catchUpMinutes: z.number().int().min(0).max(720).default(10),
  /** Also run when this other pipeline finishes successfully. */
  after: PipelineId.optional(),
})
export type PipelineSchedule = z.infer<typeof PipelineSchedule>

export const Pipeline = z.object({
  id: PipelineId,
  name: z.string().min(1).max(60),
  description: z.string().max(500).optional(),
  nodes: z.array(PipelineNode).max(60),
  edges: z.array(PipelineEdge).max(200).default([]),
  /** Node default when a node sets none. */
  onFailure: FailurePolicy.default({ retries: 0, then: 'continue' }),
  schedule: PipelineSchedule.default({ enabled: false, times: [], days: [], catchUpMinutes: 10 }),
  /** Shut the emulator down when the pipeline ends (if it used one). */
  stopEmulatorAfter: z.boolean().default(false),
  /** Written by the agent and not yet saved by the user: never runs on a schedule. */
  draft: z.boolean().optional(),
  createdAt: z.number().optional(),
  updatedAt: z.number().optional(),
})
export type Pipeline = z.infer<typeof Pipeline>
export type PipelineInput = z.input<typeof Pipeline>

export const PipelineIssue = z.object({
  level: z.enum(['error', 'warning', 'info']),
  /** The node it is about, if any. */
  nodeId: z.string().optional(),
  message: z.string(),
})
export type PipelineIssue = z.infer<typeof PipelineIssue>

export const PipelineCheck = z.object({
  ok: z.boolean(),
  issues: z.array(PipelineIssue),
  /** Branches drawn in parallel that will take turns, and why. */
  serialized: z.array(z.object({ a: z.string(), b: z.string(), resource: z.string() })),
  /** Rough duration from the tasks' expected durations, when they say. */
  estimateMinutes: z.number().optional(),
})
export type PipelineCheck = z.infer<typeof PipelineCheck>

export const NodeRunState = z.enum(['pending', 'waiting', 'running', 'succeeded', 'failed', 'skipped', 'cancelled'])
export type NodeRunState = z.infer<typeof NodeRunState>

export const NodeRun = z.object({
  state: NodeRunState,
  /** For people: what it waits for, how it ended. */
  detail: z.string().optional(),
  /** Script runs started for this node (retries add more). */
  runIds: z.array(z.string()),
  attempts: z.number().int().min(0),
  startedAt: z.number().optional(),
  endedAt: z.number().optional(),
})
export type NodeRun = z.infer<typeof NodeRun>

export const PipelineTrigger = z.object({
  kind: z.enum(['manual', 'schedule', 'autostart', 'agent', 'after']),
  detail: z.string().optional(),
})
export type PipelineTrigger = z.infer<typeof PipelineTrigger>

export const PipelineRun = z.object({
  id: z.string(),
  pipelineId: z.string(),
  pipelineName: z.string(),
  trigger: PipelineTrigger,
  state: z.enum(['running', 'succeeded', 'failed', 'cancelled']),
  nodes: z.record(z.string(), NodeRun),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  outcome: z.string().optional(),
})
export type PipelineRun = z.infer<typeof PipelineRun>

export const PipelineSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  nodes: z.number(),
  draft: z.boolean(),
  schedule: PipelineSchedule,
  updatedAt: z.number().optional(),
  lastRun: PipelineRun.pick({ id: true, state: true, startedAt: true, endedAt: true }).optional(),
})
export type PipelineSummary = z.infer<typeof PipelineSummary>

export const ScheduleSettings = z.object({
  /** Start AutoDailyGamePlay when the user logs on to Windows (a Task Scheduler task). */
  autostart: z.boolean(),
  /** Pipelines run after an automatic start. */
  autostartPipelines: z.array(PipelineId),
  /** Seconds to wait after an automatic start (network, desktop, drivers). */
  autostartDelaySeconds: z.number().int().min(0).max(1800),
  /** Skip an autostart pipeline that already ran today. */
  skipIfRanToday: z.boolean(),
})
export type ScheduleSettings = z.infer<typeof ScheduleSettings>

export const ScheduleEntry = z.object({
  pipelineId: z.string(),
  pipelineName: z.string(),
  /** The planned local slot, `YYYY-MM-DD HH:MM`. */
  slot: z.string(),
  at: z.number(),
  outcome: z.enum(['fired', 'missed', 'skipped', 'failed']),
  detail: z.string().optional(),
})
export type ScheduleEntry = z.infer<typeof ScheduleEntry>

const ScheduleStatus = z.object({
  settings: ScheduleSettings,
  autostart: z.object({
    /** Only the desktop app can start itself at logon. */
    available: z.boolean(),
    registered: z.boolean(),
    detail: z.string().optional(),
  }),
  /** This start was an automatic one (at logon). */
  autostarted: z.boolean(),
  upcoming: z.array(z.object({ pipelineId: z.string(), pipelineName: z.string(), at: z.number() })),
  history: z.array(ScheduleEntry),
})

export const PipelineRequests = {
  'pipelines/list': {
    capability: PIPELINES_CAPABILITY,
    params: z.object({}),
    result: z.object({ items: z.array(PipelineSummary) }),
  },
  'pipelines/get': {
    capability: PIPELINES_CAPABILITY,
    params: z.object({ id: PipelineId }),
    result: Pipeline,
  },
  /** Create or replace; saving clears `draft`. */
  'pipelines/save': {
    capability: PIPELINES_CAPABILITY,
    params: z.object({ pipeline: Pipeline }),
    result: z.object({ pipeline: Pipeline, check: PipelineCheck }),
  },
  'pipelines/remove': {
    capability: PIPELINES_CAPABILITY,
    params: z.object({ id: PipelineId }),
    result: z.object({}),
  },
  /** Check without saving. */
  'pipelines/check': {
    capability: PIPELINES_CAPABILITY,
    params: z.object({ pipeline: Pipeline }),
    result: PipelineCheck,
  },
  'pipelines/run': {
    capability: PIPELINES_CAPABILITY,
    params: z.object({ id: PipelineId }),
    result: PipelineRun,
  },
  'pipelines/cancel': {
    capability: PIPELINES_CAPABILITY,
    params: z.object({ runId: z.string() }),
    result: z.object({}),
  },
  'pipelines/runs': {
    capability: PIPELINES_CAPABILITY,
    params: z.object({ pipelineId: PipelineId.optional(), limit: z.number().int().min(1).max(100).optional() }),
    result: z.object({ items: z.array(PipelineRun) }),
  },
  /** Answer a gate node. */
  'pipelines/gate': {
    capability: PIPELINES_CAPABILITY,
    params: z.object({ runId: z.string(), nodeId: NodeId, decision: z.enum(['continue', 'stop']) }),
    result: z.object({}),
  },
  'schedule/status': {
    capability: SCHEDULE_CAPABILITY,
    params: z.object({}),
    result: ScheduleStatus,
  },
  'schedule/settings/set': {
    capability: SCHEDULE_CAPABILITY,
    params: ScheduleSettings.partial(),
    result: ScheduleStatus,
  },
} as const

export const PipelineNotifications = {
  /** A pipeline was saved or removed. */
  'pipelines/changed': z.object({}),
  /** A pipeline run started or changed. */
  'pipelines/run': PipelineRun,
  'schedule/changed': z.object({}),
} as const
