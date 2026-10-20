/**
 * `permissions@1`: how much the agent may do without asking. `ask` (default):
 * commands run in dsh's sandbox and every approval goes to the user; `full`:
 * no sandbox, and every approval is allowed at once. Served by the gateway.
 */
import { z } from 'zod'

export const PERMISSIONS_CAPABILITY = 'permissions'

export const PermissionMode = z.enum(['ask', 'full'])
export type PermissionMode = z.infer<typeof PermissionMode>

export const PermissionsState = z.object({
  mode: PermissionMode,
  /** When the mode last changed. */
  since: z.number().optional(),
  /** Approvals answered "allow" by full access, newest first (since the host started). */
  recent: z.array(z.object({
    at: z.number(),
    sessionId: z.string(),
    toolName: z.string(),
    reason: z.string().optional(),
  })),
})
export type PermissionsState = z.infer<typeof PermissionsState>

export const PermissionsRequests = {
  'permissions/get': {
    capability: PERMISSIONS_CAPABILITY,
    params: z.object({}),
    result: PermissionsState,
  },
  'permissions/set': {
    capability: PERMISSIONS_CAPABILITY,
    params: z.object({ mode: PermissionMode }),
    result: PermissionsState,
  },
} as const

export const PermissionsNotifications = {
  /** The mode changed, or full access allowed something. */
  'permissions/changed': PermissionsState,
} as const
