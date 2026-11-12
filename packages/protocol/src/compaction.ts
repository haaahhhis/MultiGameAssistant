/**
 * `compaction@1`: when dsh compacts a long conversation by itself. Compacting
 * replaces the older part with a summary the model writes, so the agent loses
 * its details; automatically it happens when the conversation fills
 * `threshold`% of the model's context window. Read when the agent service
 * starts (packages/bundle/cordis.patch.yml, row preset-standard): a change
 * applies after a restart, until then `applied` differs from `settings`.
 * Compacting by hand (session/compact) works either way.
 *
 * Low-context mode (`lowContext`) keeps the last 12 hours in the context: what
 * is older is compacted into the summary, and only once the agent's task is
 * over (its turn ends with nothing of it still going: no sub-agent, no
 * hand-off waiting for an answer). Never in the middle of a task, so the
 * model provider's prompt cache keeps working there. Only what was compacted
 * leaves the agent's context; the agent reads it back with history_search /
 * history_read. It is read each time, so it applies at once.
 */
import { z } from 'zod'

export const COMPACTION_CAPABILITY = 'compaction'

/** dsh's own default (dsh-compaction-basic). */
export const DEFAULT_COMPACTION_THRESHOLD = 80
/** Low: the system prompt and tools alone may come near it, and it compacts almost every step. */
export const MIN_COMPACTION_THRESHOLD = 5
/** dsh still keeps room for the reply: 100% compacts just before the context is full. */
export const MAX_COMPACTION_THRESHOLD = 100
/** Below this, compacting often: the settings page says so. */
export const LOW_COMPACTION_THRESHOLD = 30

/** Low-context mode: what is more recent than this stays word for word. */
export const LOW_CONTEXT_WINDOW_MS = 12 * 60 * 60_000

export const CompactionSettings = z.object({
  /** Compact by itself when the conversation is long; off: a too-long conversation fails until compacted by hand. */
  auto: z.boolean(),
  /** How full the context window gets before compacting, in percent. */
  threshold: z.number().int().min(MIN_COMPACTION_THRESHOLD).max(MAX_COMPACTION_THRESHOLD),
  /** Low-context mode: keep only the last 12 hours and the summary in the context. */
  lowContext: z.boolean(),
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
