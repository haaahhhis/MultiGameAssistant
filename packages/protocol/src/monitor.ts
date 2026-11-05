/**
 * `monitor@1`: incidents raised while scripts run — error rules, failed runs,
 * stalls, overtime — and what was done about them (L0 recovery from the
 * Script Pack, the user's stop / retry). Served by `@adg/monitor`.
 */
import { z } from 'zod'

export const MONITOR_CAPABILITY = 'monitor'

export const IncidentKind = z.enum([
  /** An `error` log rule matched. */
  'error',
  /** A `warning` log rule matched (recorded; pushed only when the settings say so). */
  'warning',
  /** The run ended failed without an earlier error incident. */
  'failed',
  /** No new script log line for longer than the stall threshold. */
  'stalled',
  /** Running for more than twice the task's expected duration. */
  'overtime',
])
export type IncidentKind = z.infer<typeof IncidentKind>

export const IncidentStep = z.object({
  at: z.number(),
  action: z.enum(['reconnect-adb', 'restart', 'stop', 'screenshot', 'notify', 'resolve', 'intervene']),
  /** `rule`: L0 recovery from the pack; `user`: the UI or a chat channel. */
  by: z.enum(['rule', 'user', 'agent']),
  ok: z.boolean(),
  detail: z.string(),
})
export type IncidentStep = z.infer<typeof IncidentStep>

export const Incident = z.object({
  id: z.string(),
  runId: z.string(),
  scriptId: z.string(),
  scriptName: z.string(),
  taskId: z.string(),
  taskTitle: z.string(),
  kind: IncidentKind,
  severity: z.enum(['warning', 'error']),
  /** Log rule tag, or the kind. */
  tag: z.string(),
  /** One line for people, e.g. "MAA · 日常：重连失败，连接断开！". */
  title: z.string(),
  /** The matching log line or the run's outcome. */
  detail: z.string(),
  /** The run's last log lines when the incident was raised. */
  lines: z.array(z.string()),
  status: z.enum(['open', 'resolved']),
  resolution: z.string().optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
  steps: z.array(IncidentStep),
  /** A screenshot was taken (`monitor/screenshot`). */
  screenshot: z.boolean(),
})
export type Incident = z.infer<typeof Incident>

/**
 * How long one script may be quiet before it counts as stalled, as found on this computer: `learned` from its runs
 * that went through (1.5 × the longest quiet stretch of the last few), or set by the `agent` (monitor_stall_set) or the `user`.
 */
export const ScriptStall = z.object({
  seconds: z.number().int().min(5).max(24 * 3600),
  by: z.enum(['learned', 'agent', 'user']),
  /** Why (the agent's words), for people. */
  note: z.string().max(300).optional(),
  /** The longest quiet stretch (seconds) of each of the last runs that went through cleanly, newest last. */
  samples: z.array(z.number().min(0)).max(10).default([]),
  at: z.number(),
})
export type ScriptStall = z.infer<typeof ScriptStall>

export const MonitorSettings = z.object({
  /**
   * Seconds without a new script log line before a run counts as stalled and goes to the agent, for a script
   * with nothing of its own in `scriptStall` (nor `logs.stallAfter` in its pack); 0 turns it off. Applies only
   * once the run has written at least one log line.
   */
  defaultStallSeconds: z.number().int().min(0).max(24 * 3600),
  /** Script id → its own stall time (learned from its normal runs, or set by the agent or the user). */
  scriptStall: z.record(z.string(), ScriptStall),
  /** Also push `warning` incidents to chat channels. */
  notifyWarnings: z.boolean(),
  /** Take a screenshot (emulator or desktop) when an incident is raised. */
  screenshot: z.boolean(),
  /**
   * What L0 does not settle goes to the agent first: `off`, `diagnose` (it
   * looks and explains, then you decide), or `act` (it may also click and type
   * to fix it, with the script paused). Needs an image-capable model.
   */
  intervene: z.enum(['off', 'diagnose', 'act']),
  /** At most this many agent interventions a day (model cost). */
  interventionsPerDay: z.number().int().min(0).max(200),
})
export type MonitorSettings = z.infer<typeof MonitorSettings>

export const MonitorRequests = {
  'monitor/incidents': {
    capability: MONITOR_CAPABILITY,
    params: z.object({ status: z.enum(['open', 'all']).optional(), runId: z.string().optional(), limit: z.number().int().min(1).max(500).optional() }),
    result: z.object({ items: z.array(Incident) }),
  },
  /** Stop the incident's run, run its task again, mark the incident handled, or let the paused script carry on. */
  'monitor/act': {
    capability: MONITOR_CAPABILITY,
    params: z.object({ incidentId: z.string(), action: z.enum(['stop', 'retry', 'resolve', 'resume']) }),
    result: Incident,
  },
  'monitor/screenshot': {
    capability: MONITOR_CAPABILITY,
    params: z.object({ incidentId: z.string() }),
    result: z.object({ mime: z.literal('image/png'), data: z.string() }),
  },
  'monitor/settings': {
    capability: MONITOR_CAPABILITY,
    params: z.object({}),
    result: MonitorSettings,
  },
  'monitor/settings/set': {
    capability: MONITOR_CAPABILITY,
    params: MonitorSettings.partial(),
    result: MonitorSettings,
  },
} as const

export const MonitorNotifications = {
  /** An incident was raised or changed. */
  'monitor/incident': Incident,
} as const
