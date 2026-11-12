/**
 * `compaction@1`: when dsh compacts a long conversation by itself. Compacting
 * replaces the older part with a summary the model writes, so the agent loses
 * its details; automatically it happens when the conversation fills
 * `threshold`% of the model's context window. Read when the agent service
 * starts (packages/bundle/cordis.patch.yml, row preset-standard): a change
 * applies after a restart, until then `applied` differs from `settings`.
 * Compacting by hand (session/compact) works either way.
 *
 * Low-context mode (`lowContext`) also compacts before each step: everything
 * but the latest `keepMessages` messages, and anything older than a day, is
 * replaced by the summary. Only what was compacted leaves the agent's context;
 * the agent reads the rest back with history_search / history_read. It is read
 * before every step, so it applies at once.
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

/** Low-context mode: how many of the latest messages stay word for word. */
export const DEFAULT_KEEP_MESSAGES = 5
export const MIN_KEEP_MESSAGES = 2
export const MAX_KEEP_MESSAGES = 20
/** Low-context mode: a message older than this is compacted, however few there are. */
export const LOW_CONTEXT_MAX_AGE_MS = 24 * 60 * 60_000

export const CompactionSettings = z.object({
  /** Compact by itself when the conversation is long; off: a too-long conversation fails until compacted by hand. */
  auto: z.boolean(),
  /** How full the context window gets before compacting, in percent. */
  threshold: z.number().int().min(MIN_COMPACTION_THRESHOLD).max(MAX_COMPACTION_THRESHOLD),
  /** Low-context mode: keep only the latest messages and the summary in the context. */
  lowContext: z.boolean(),
  /** Low-context mode: the latest messages kept word for word. */
  keepMessages: z.number().int().min(MIN_KEEP_MESSAGES).max(MAX_KEEP_MESSAGES),
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
