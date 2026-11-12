/**
 * `memory@1`: what the agents remember about the user across conversations —
 * not how to do a job (that is a skill), but who the user is, what they
 * prefer, what was agreed and what was done.
 *
 * Two kinds of entries:
 * - `profile` (资料): lasting facts — how to address the user, preferences,
 *   conventions, their machines and games. Every one goes into the agents'
 *   system prompt.
 * - `journal` (日记): what happened on a day — a decision, a job done, a
 *   problem solved. Only the recent ones go into the prompt; older ones are
 *   found with `memory_search`.
 *
 * Each entry is `shared` (every agent reads it) or one agent's own (`scope`
 * is that agent's id: only it reads it). Agents write them with
 * `memory_save` / `memory_forget`; the user reads, edits and deletes them on
 * 设置 → 记忆. Kept in `<dataDir>/memory.json`. Never passwords, codes or keys.
 *
 * With `auto` on (the default), a conversation that has been quiet for a while
 * is also read back by a model, which adds what the agent forgot to write
 * (entries `by: auto`). Only stretches where the user said something are read.
 * Low-context mode (compaction.ts) keeps it on, whatever `auto` says.
 */
import { z } from 'zod'

export const MEMORY_CAPABILITY = 'memory'

/** Everyone's: the scope of an entry every agent reads. */
export const SHARED_MEMORY = 'shared'

export const MemoryKind = z.enum(['profile', 'journal'])
export type MemoryKind = z.infer<typeof MemoryKind>

/** Longest entry: one fact or one event, not a document (a document is a skill or a file). */
export const MAX_MEMORY_TEXT = 600

export const MemoryEntry = z.object({
  id: z.string(),
  kind: MemoryKind,
  /** `shared`, or the id of the agent whose own it is. */
  scope: z.string(),
  text: z.string(),
  /** ISO time it was written, and last changed. */
  createdAt: z.string(),
  updatedAt: z.string(),
  /** Who wrote it: an agent id, `user` (设置 → 记忆), or `auto` (read back from a conversation). */
  by: z.string(),
})
export type MemoryEntry = z.infer<typeof MemoryEntry>

/** Automatic memory: on or off, and the model it uses (null: the default model). */
export const MemoryAutoSettings = z.object({
  auto: z.boolean(),
  /** Same shape as ModelSelection (methods.ts), which imports this file. */
  model: z.object({ provider: z.string(), model: z.string(), reasoningEffort: z.string().optional() }).nullable(),
})
export type MemoryAutoSettings = z.infer<typeof MemoryAutoSettings>

const MemoryText = z.string().trim().min(1).max(MAX_MEMORY_TEXT)

export const MemoryRequests = {
  'memory/list': {
    capability: MEMORY_CAPABILITY,
    params: z.object({}),
    /** Newest first. */
    result: z.object({ items: z.array(MemoryEntry) }),
  },
  'memory/add': {
    capability: MEMORY_CAPABILITY,
    params: z.object({ kind: MemoryKind, scope: z.string().min(1).max(64), text: MemoryText }),
    result: z.object({ item: MemoryEntry }),
  },
  'memory/update': {
    capability: MEMORY_CAPABILITY,
    params: z.object({ id: z.string(), text: MemoryText, kind: MemoryKind.optional(), scope: z.string().min(1).max(64).optional() }),
    result: z.object({ item: MemoryEntry }),
  },
  'memory/auto/get': {
    capability: MEMORY_CAPABILITY,
    params: z.object({}),
    /** `forced`: on whatever `auto` says, because low-context mode is on (compaction.ts). */
    result: MemoryAutoSettings.extend({ forced: z.boolean().optional() }),
  },
  'memory/auto/set': {
    capability: MEMORY_CAPABILITY,
    params: MemoryAutoSettings,
    result: MemoryAutoSettings,
  },
  'memory/remove': {
    capability: MEMORY_CAPABILITY,
    params: z.object({ id: z.string() }),
    result: z.object({ removed: z.boolean() }),
  },
} as const

export const MemoryNotifications = {
  /** An entry was written, changed or forgotten; re-read `memory/list`. */
  'memory/changed': z.object({}),
} as const
