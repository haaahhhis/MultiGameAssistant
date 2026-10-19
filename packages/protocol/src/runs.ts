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
  /** Values read from the script's local config (e.g. MXU instances). */
  choices: z.array(z.object({ value: z.string(), label: z.string(), detail: z.string().optional() })).optional(),
  /** A new choice can be made with `runs/choices/create`. */
  canCreate: z.boolean().optional(),
})

/** Who starts the game before a run (docs: 脚本不会自己启动游戏时由本应用启动). */
export const LaunchSettings = z.object({
  /** `auto`: only when the script will not and the game is not running; `platform`: always unless running; `off`: never. */
  mode: z.enum(['auto', 'platform', 'off']),
  /** PC game program (for tasks that use the desktop). */
  pcExe: z.string().optional(),
  /** Its process name, when it differs from the program's file name. */
  pcProcess: z.string().optional(),
  /** Android package started in the emulator (for emulator tasks). */
  androidPackage: z.string().optional(),
})
export type LaunchSettings = z.infer<typeof LaunchSettings>

const LaunchView = z.object({
  settings: LaunchSettings,
  /** What the script pack says. */
  game: z.object({
    name: z.string().optional(),
    androidPackage: z.string().optional(),
    pcProcess: z.string().optional(),
    /** How the script starts the game itself, for people. */
    selfLaunch: z.string(),
  }),
  /** The script has tasks that use the emulator / the desktop. */
  uses: z.object({ adb: z.boolean(), desktop: z.boolean() }),
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
  /** A task run, or a settings session (the script's own window opened to change the local config). */
  kind: z.enum(['task', 'settings']),
  /** This run restarts that one (L0 recovery or the user's retry). */
  retryOf: z.string().optional(),
})
export type RunInfo = z.infer<typeof RunInfo>

export const RunLogLine = z.object({
  at: z.number(),
  /** `stdout`, `stderr`, or the log file's relative path. */
  source: z.string(),
  text: z.string(),
  /** Level of the log rule that matched this line, if any. */
  level: z.enum(['info', 'progress', 'done', 'warning', 'error']).optional(),
  /** Tag of that rule (its level when it has none). */
  tag: z.string().optional(),
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
  /** The script's local config copy and whether the original changed since it was imported. */
  'configs/status': {
    capability: RUNS_CAPABILITY,
    params: z.object({ scriptId: ScriptId }),
    result: z.object({
      importedAt: z.number().optional(),
      /** Where the local copy lives. */
      dir: z.string(),
      files: z.array(z.object({ file: z.string(), local: z.boolean(), original: z.boolean(), changed: z.boolean() })),
      drift: z.array(z.string()),
    }),
  },
  /** One declared config file of the local copy, as text (to look at). */
  'configs/read': {
    capability: RUNS_CAPABILITY,
    params: z.object({ scriptId: ScriptId, file: z.string().min(1) }),
    result: z.object({ file: z.string(), content: z.string(), truncated: z.boolean() }),
  },
  /** Replace the local copy with the original project's current config (the user's call). */
  'configs/import': {
    capability: RUNS_CAPABILITY,
    params: z.object({ scriptId: ScriptId }),
    result: z.object({ imported: z.array(z.string()) }),
  },
  /** Open the script's own settings window on the local copy; saved back when the user closes it. */
  'configs/open': {
    capability: RUNS_CAPABILITY,
    params: z.object({ scriptId: ScriptId }),
    result: RunInfo,
  },
  /** Make a new choice for a parameter (e.g. an MXU instance copied from an existing one) in the local config. */
  'runs/choices/create': {
    capability: RUNS_CAPABILITY,
    params: z.object({ scriptId: ScriptId, taskId: z.string().min(1), param: z.string().min(1), name: z.string().trim().min(1).max(40) }),
    result: z.object({ value: z.string() }),
  },
  'configs/launch': {
    capability: RUNS_CAPABILITY,
    params: z.object({ scriptId: ScriptId }),
    result: LaunchView,
  },
  'configs/launch/set': {
    capability: RUNS_CAPABILITY,
    params: z.object({
      scriptId: ScriptId,
      mode: z.enum(['auto', 'platform', 'off']).optional(),
      pcExe: z.string().trim().nullable().optional(),
      pcProcess: z.string().trim().nullable().optional(),
      androidPackage: z.string().trim().regex(/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/, '安卓包名像 com.example.game').nullable().optional(),
    }),
    result: LaunchView,
  },
  /** Look for the PC game's program (running process, installed programs, shortcuts, the usual folders). */
  'configs/launch/locate': {
    capability: RUNS_CAPABILITY,
    params: z.object({ scriptId: ScriptId }),
    result: z.object({
      /** The program looked for, e.g. Endfield.exe; absent when the pack does not name one. */
      exe: z.string().optional(),
      candidates: z.array(z.object({ path: z.string(), source: z.string() })),
    }),
  },
} as const

export const RunNotifications = {
  'runs/state': RunInfo,
  'runs/log': z.object({ runId: z.string(), lines: z.array(RunLogLine) }),
} as const
