/**
 * `guard@1`: the user's explicit, time-limited permission for the agent to
 * change a script's own files. Granting is only
 * possible from the UI; the agent has no tool for it. Served by `@adg/guard`.
 */
import { z } from 'zod'
import { ScriptId } from './scripts.ts'

export const GUARD_CAPABILITY = 'guard'

export const GuardGrant = z.object({
  scriptId: z.string(),
  /** Directory the grant opens. */
  dir: z.string(),
  grantedAt: z.number(),
  expiresAt: z.number(),
})
export type GuardGrant = z.infer<typeof GuardGrant>

export const GuardRequests = {
  'guard/grants': {
    capability: GUARD_CAPABILITY,
    params: z.object({}),
    result: z.object({ items: z.array(GuardGrant), blocked: z.number() }),
  },
  /** Let the agent change this script's files for `minutes`. */
  'guard/grant': {
    capability: GUARD_CAPABILITY,
    params: z.object({ scriptId: ScriptId, minutes: z.number().int().min(1).max(240) }),
    result: GuardGrant,
  },
  'guard/revoke': {
    capability: GUARD_CAPABILITY,
    params: z.object({ scriptId: ScriptId }),
    result: z.object({}),
  },
} as const

export const GuardNotifications = {
  'guard/changed': z.object({}),
  /** The guard refused an agent tool call. */
  'guard/blocked': z.object({ toolName: z.string(), target: z.string(), sessionId: z.string().optional(), at: z.number() }),
} as const
