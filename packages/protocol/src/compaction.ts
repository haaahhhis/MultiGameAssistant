/**
 * `compaction@1`: when dsh compacts a long conversation by itself. Compacting
 * replaces the older part with a summary the model writes, so the agent loses
 * its details; automatically it happens when the conversation fills
 * `threshold`% of the model's context window. Read when the agent service
 * starts (packages/bundle/cordis.patch.yml, row preset-standard): a change
 * applies after a restart, until then `applied` differs from `settings`.
 * Compacting by hand (session/compact) works either way.
 */
import { z } from 'zod'

export const COMPACTION_CAPABILITY = 'compaction'

/** dsh's own default (dsh-compaction-basic). */
export const DEFAULT_COMPACTION_THRESHOLD = 80
/** Below this the verbatim tail (16% of the window) and the summary leave too little room. */
export const MIN_COMPACTION_THRESHOLD = 50
export const MAX_COMPACTION_THRESHOLD = 95

export const CompactionSettings = z.object({
  /** Compact by itself when the conversation is long; off: a too-long conversation fails until compacted by hand. */
  auto: z.boolean(),
  /** How full the context window gets before compacting, in percent. */
  threshold: z.number().int().min(MIN_COMPACTION_THRESHOLD).max(MAX_COMPACTION_THRESHOLD),
})
export type CompactionSettings = z.infer<typeof CompactionSettings>

const State = z.object({ settings: CompactionSettings, applied: CompactionSettings })

export const CompactionRequests = {
  'compaction/get': {
    capability: COMPACTION_CAPABILITY,
    params: z.object({}),
    result: State,
  },
  'compaction/set': {
    capability: COMPACTION_CAPABILITY,
    params: z.object({ settings: CompactionSettings }),
    result: State,
  },
} as const
