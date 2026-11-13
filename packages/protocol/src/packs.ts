/**
 * `packs@1`: Script Packs the agent writes. They are in use as soon as it
 * saves one, so the user gets the way back: the versions a pack replaced
 * (`packs/history`, `packs/restore`). Drafts are what is left from when each
 * waited for the user to accept or reject it. Served by `@adg/analyzer`.
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

/** A pack the user can go back to: a version that was replaced, or the built-in pack a user pack is used instead of. */
export const PackVersion = z.object({
  /** What `packs/restore` takes; `builtin` for the built-in pack. */
  id: z.string(),
  /** When it was replaced (absent for the built-in pack). */
  at: z.number().optional(),
  builtin: z.boolean().optional(),
  /** Tasks it declares. */
  tasks: z.array(z.object({ id: z.string(), title: z.string() })),
})
export type PackVersion = z.infer<typeof PackVersion>

/** `packs/restore`'s `version` for the built-in pack. */
export const BUILTIN_PACK_VERSION = 'builtin'

export const PackRequests = {
  /** What a pack can go back to, the last replaced first, the built-in pack (if a user pack is used instead of it) last. */
  'packs/history': {
    capability: PACKS_CAPABILITY,
    params: z.object({ packId: ScriptId }),
    result: z.object({ items: z.array(PackVersion) }),
  },
  /** Put that version back in use. The pack in use now goes into the history, so this can be undone. */
  'packs/restore': {
    capability: PACKS_CAPABILITY,
    params: z.object({ packId: ScriptId, version: z.string().min(1).max(64) }),
    result: z.object({}),
  },
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
