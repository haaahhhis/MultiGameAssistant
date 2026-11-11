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
  /** Who wrote it: an agent id, or `user` (设置 → 记忆). */
  by: z.string(),
})
export type MemoryEntry = z.infer<typeof MemoryEntry>

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
