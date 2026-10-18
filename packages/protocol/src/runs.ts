/**
 * `runs@1`: running a script's task — what tasks exist, starting and
 * stopping runs, their state and log lines. Served by `@adg/runner`.
 */
import { z } from 'zod'
import { ScriptId } from './scripts.ts'

export const RUNS_CAPABILITY = 'runs'

export const RunState = z.enum(['starting', 'running', 'stopping', 'succeeded', 'failed', 'cancelled'])
export type RunState = z.infer<typeof RunState>

export const TaskParamInfo = z.object({
  type: z.enum(['string', 'integer', 'number', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  enum: z.array(z.union([z.string(), z.number()])).optional(),
  description: z.string().optional(),
})

export const TaskInfo = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string().optional(),
  utterances: z.array(z.string()),
  params: z.record(z.string(), TaskParamInfo),
  /** What the task occupies: `desktop` takes the mouse and keyboard; `adb` an emulator. */
  input: z.enum(['desktop', 'window', 'adb', 'none']),
  account: z.string().optional(),
  expectedDuration: z.string().optional(),
})
export type TaskInfo = z.infer<typeof TaskInfo>

export const RunInfo = z.object({
  id: z.string(),
  scriptId: z.string(),
  scriptName: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])),
  state: RunState,
  /** Why it ended the way it did, for people. */
  outcome: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
  exitCode: z.number().optional(),
  /** Program and arguments as started. */
  command: z.array(z.string()),
  /** Locks held while running, e.g. `desktop`, `adb:127.0.0.1:16384`, `account:main`. */
  resources: z.array(z.string()),
  /** Tags of the log rules that matched. */
  tags: z.array(z.string()),
  warnings: z.array(z.string()),
})
export type RunInfo = z.infer<typeof RunInfo>

export const RunLogLine = z.object({
  at: z.number(),
  /** `stdout`, `stderr`, or the log file's relative path. */
  source: z.string(),
  text: z.string(),
  /** Level of the log rule that matched this line, if any. */
  level: z.enum(['info', 'progress', 'done', 'error']).optional(),
})
export type RunLogLine = z.infer<typeof RunLogLine>

export const RunRequests = {
  /** Tasks a library script can run, from its Script Pack. */
  'runs/tasks': {
    capability: RUNS_CAPABILITY,
    params: z.object({ scriptId: ScriptId }),
    result: z.object({ tasks: z.array(TaskInfo), runnable: z.boolean(), problem: z.string().optional() }),
  },
  'runs/start': {
    capability: RUNS_CAPABILITY,
    params: z.object({
      scriptId: ScriptId,
      taskId: z.string().min(1).max(64),
      params: z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])).optional(),
    }),
    result: RunInfo,
  },
  'runs/stop': {
    capability: RUNS_CAPABILITY,
    params: z.object({ runId: z.string() }),
    result: z.object({}),
  },
  /** Recent runs, newest first. */
  'runs/list': {
    capability: RUNS_CAPABILITY,
    params: z.object({ scriptId: ScriptId.optional() }),
    result: z.object({ items: z.array(RunInfo) }),
  },
  /** The last lines of a run's log. */
  'runs/logs': {
    capability: RUNS_CAPABILITY,
    params: z.object({ runId: z.string(), limit: z.number().int().min(1).max(2000).optional() }),
    result: z.object({ lines: z.array(RunLogLine) }),
  },
} as const

export const RunNotifications = {
  'runs/state': RunInfo,
  'runs/log': z.object({ runId: z.string(), lines: z.array(RunLogLine) }),
} as const
