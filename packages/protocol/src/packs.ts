/**
 * `packs@1`: Script Pack drafts the agent proposed after analyzing a script,
 * waiting for the user to accept or reject them. Served by `@adg/analyzer`.
 */
import { z } from 'zod'
import { ScriptId } from './scripts.ts'

export const PACKS_CAPABILITY = 'packs'

export const PackDraft = z.object({
  packId: z.string(),
  /** Library script it was written for. */
  scriptId: z.string(),
  proposedAt: z.number(),
  sessionId: z.string().optional(),
  /** What the agent says it changed or found. */
  summary: z.string(),
  /** The project's documents it was written from (paths in the script's folder, or URLs), and what each told. */
  docs: z.array(z.object({ source: z.string(), used: z.string() })).optional(),
  /** Why it was written from the code alone: no documentation was found. */
  noDocs: z.string().optional(),
  manifest: z.string(),
  skill: z.string(),
  /** The pack in use now, for comparison. */
  current: z.object({ manifest: z.string(), skill: z.string().optional(), builtin: z.boolean() }).optional(),
  /** Tasks the draft declares. */
  tasks: z.array(z.object({ id: z.string(), title: z.string() })),
})
export type PackDraft = z.infer<typeof PackDraft>

export const PackRequests = {
  'packs/drafts': {
    capability: PACKS_CAPABILITY,
    params: z.object({ scriptId: ScriptId.optional() }),
    result: z.object({ items: z.array(PackDraft) }),
  },
  /** Install the draft as the user's pack for this id (replacing a built-in one by id) and attach it to the script. */
  'packs/accept': {
    capability: PACKS_CAPABILITY,
    params: z.object({ packId: ScriptId }),
    result: z.object({ packId: z.string(), dir: z.string() }),
  },
  'packs/reject': {
    capability: PACKS_CAPABILITY,
    params: z.object({ packId: ScriptId }),
    result: z.object({}),
  },
} as const

export const PackNotifications = {
  'packs/changed': z.object({ packId: z.string().optional() }),
} as const
