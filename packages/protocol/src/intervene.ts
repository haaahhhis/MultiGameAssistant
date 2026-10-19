/**
 * `intervene@1`: the agent looking at the screen and handling what L0 could
 * not (docs/PLAN.zh.md §5.4 L1/L2), and the user taking over from it.
 * Served by `@adg/intervene`.
 */
import { z } from 'zod'

export const INTERVENE_CAPABILITY = 'intervene'

export const InterventionState = z.enum([
  /** The agent is working on it. */
  'running',
  /** Fixed; the script was resumed. */
  'resolved',
  /** Fixed; the script was run again. */
  'retried',
  /** The agent could not handle it; passed on to the user. */
  'gave-up',
  /** The user took over. */
  'taken-over',
  /** Took too long. */
  'timeout',
  /** Could not start (no image-capable model, the run had ended …). */
  'failed',
])
export type InterventionState = z.infer<typeof InterventionState>

export const Intervention = z.object({
  id: z.string(),
  incidentId: z.string().optional(),
  runId: z.string().optional(),
  title: z.string(),
  /** `diagnose`: look and explain only; `act`: may also click and type. */
  mode: z.enum(['diagnose', 'act']),
  state: InterventionState,
  /** The agent session doing it (open it to watch). */
  sessionId: z.string().optional(),
  /** The script is suspended while the agent works. */
  paused: z.boolean(),
  /** The agent's own account of what happened and what it did. */
  summary: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
})
export type Intervention = z.infer<typeof Intervention>

export const InterveneRequests = {
  'intervene/list': {
    capability: INTERVENE_CAPABILITY,
    params: z.object({ limit: z.number().int().min(1).max(100).optional() }),
    result: z.object({ items: z.array(Intervention) }),
  },
  /** Stop the agent; the script stays paused until `intervene/release`. */
  'intervene/takeover': {
    capability: INTERVENE_CAPABILITY,
    params: z.object({ id: z.string() }),
    result: Intervention,
  },
  /** Done by hand: carry on, run the task again, or stop it. */
  'intervene/release': {
    capability: INTERVENE_CAPABILITY,
    params: z.object({ id: z.string(), then: z.enum(['resume', 'restart', 'stop']) }),
    result: Intervention,
  },
} as const

export const InterveneNotifications = {
  'intervene/changed': Intervention,
} as const
