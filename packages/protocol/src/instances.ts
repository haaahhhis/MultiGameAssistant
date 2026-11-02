/**
 * `instances@1`: other copies of this app running on the same computer, such
 * as the desktop app and the dsh plugin open at the same time. Each one runs
 * its own scripts, schedules and Feishu bot without knowing about the other,
 * so the UI warns about what clashes.
 */
import { z } from 'zod'

export const INSTANCES_CAPABILITY = 'instances'

export const OtherCopy = z.object({
  pid: z.number().int(),
  /** What it is, in words: 「桌面版」, 「dsh 插件版」 … */
  label: z.string(),
  /** Where its data lives. */
  dataDir: z.string().optional(),
  startedAt: z.number(),
  /** What clashes with this copy, one sentence each; the first is the general one. */
  warnings: z.array(z.string()),
})
export type OtherCopy = z.infer<typeof OtherCopy>

export const OtherCopies = z.object({ others: z.array(OtherCopy) })
export type OtherCopies = z.infer<typeof OtherCopies>

export const InstancesRequests = {
  'instances/others': {
    capability: INSTANCES_CAPABILITY,
    params: z.object({}),
    result: OtherCopies,
  },
} as const

export const InstancesNotifications = {
  /** Another copy started or stopped, or what it uses changed. */
  'instances/changed': OtherCopies,
} as const
