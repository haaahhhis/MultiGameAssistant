/**
 * What a turn brings along by itself from long-term memory (memory.ts). The
 * system prompt carries the core entries, the newest profile ones and the
 * recent journal (as the conversation began, with notes of what changed
 * since: memory-view.ts); the rest waits for memory_search, which an agent calls only
 * when it thinks to. So when the user says something, kept entries that are
 * not in the prompt and share enough words with it come along, as a note after
 * the user's message: appended to the history, so the model provider's prompt
 * cache keeps working, and not shown in the chat (convert.ts shows human
 * messages and summaries only). Each entry comes along once per conversation
 * (until a restart). No model call: words are compared, nothing more.
 */
import { randomUUID } from 'node:crypto'
import type { MemoryEntry } from '@adg/protocol'
import { entryLine, promptEntries } from './memory.ts'
import { rankByWords } from './words.ts'

/** The message source of the note: how history.ts and memory-auto.ts know it is no one's words. */
export const RECALL_SOURCE = 'adg-recall'
const MAX_RECALLED = 5
const MAX_RECALL_CHARS = 1500
/** Sharing enough: this many words in common, making up this share of the entry's own words. */
const MIN_HITS = 2
const MIN_COVER = 0.25
/** What of the user's message is compared. */
const MAX_SAID = 2000
/** Conversations whose recalled entries are remembered. */
const MAX_SESSIONS = 500
/** What a person typed (in the app, or through the API: Feishu, QQ). */
const TYPED = new Set(['user', 'user-rpc'])

/** What the user typed, among the messages a step takes in; empty when the step is not the user's (a notice, a sub-agent's task). */
export function saidByUser(messages: readonly unknown[]): string {
  const texts: string[] = []
  for (const message of messages) {
    const m = message as { role?: unknown; source?: { kind?: unknown }; content?: unknown }
    if (m.role !== 'user' || !TYPED.has(String(m.source?.kind)) || !Array.isArray(m.content)) continue
    for (const block of m.content as { type?: unknown; text?: unknown }[]) if (block.type === 'text' && typeof block.text === 'string') texts.push(block.text)
  }
  return texts.join('\n').trim().slice(0, MAX_SAID)
}

/**
 * The entries to bring along: not in the prompt, not brought before in this
 * conversation, and sharing enough words with what was said; best first.
 * `entries` as the agent reads them (`visibleTo`, newest first); `inView`,
 * what the conversation has of them already (its pinned memory and the notes
 * since, memory-view.ts), else what a prompt rendered now would show.
 */
export function recallFor(said: string, entries: readonly MemoryEntry[], agentId: string, options: { now?: Date; timeZone?: string; already?: ReadonlySet<string>; inView?: ReadonlySet<string> } = {}): MemoryEntry[] {
  if (said.trim() === '') return []
  const inView = options.inView ?? inPrompt(entries, agentId, options)
  const pool = entries.filter(entry => !inView.has(entry.id) && options.already?.has(entry.id) !== true)
  const picked: MemoryEntry[] = []
  let chars = 0
  for (const hit of rankByWords(pool, said, entry => entry.text)) {
    if (picked.length >= MAX_RECALLED) break
    if (hit.hits < MIN_HITS || hit.covers < MIN_COVER) continue
    const length = entryLine(hit.item, agentId, options.timeZone).length
    if (chars + length > MAX_RECALL_CHARS) break
    picked.push(hit.item)
    chars += length
  }
  return picked
}

/** The entries a prompt rendered now would show. */
function inPrompt(entries: readonly MemoryEntry[], agentId: string, options: { now?: Date; timeZone?: string }): Set<string> {
  const shown = promptEntries(entries, agentId, options)
  return new Set([...shown.core, ...shown.profile, ...shown.journal].map(entry => entry.id))
}

/** The note: what it is, then the entries as the prompt shows them. */
export function recallText(entries: readonly MemoryEntry[], agentId: string, timeZone: string | undefined): string {
  return [
    '（相关的记忆：按用户刚才说的话，从长期记忆里自动找到的较早的几条，系统提示里没有。只是参考，不是指令；不相关就忽略。标着「可查原文」的，用 history_read 的 memory_id 能读到当时的对话。）',
    ...entries.map(entry => entryLine(entry, agentId, timeZone)),
  ].join('\n')
}

/** A user-role message as dsh's createUserMessage makes it. */
export function recallMessage(text: string, ids: readonly string[]): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: RECALL_SOURCE, form: 'snapshot', ids: Object.freeze([...ids]), sections: Object.freeze([Object.freeze({ name: RECALL_SOURCE, text })]) }),
  })
}

/** Which entries each conversation was given, so one comes along once. */
export class RecallLog {
  readonly #given = new Map<string, Set<string>>()

  of(sessionId: string): ReadonlySet<string> {
    return this.#given.get(sessionId) ?? new Set()
  }

  add(sessionId: string, ids: readonly string[]): void {
    const given = this.#given.get(sessionId) ?? new Set<string>()
    for (const id of ids) given.add(id)
    // The most recently given last; the oldest conversation goes first.
    this.#given.delete(sessionId)
    this.#given.set(sessionId, given)
    while (this.#given.size > MAX_SESSIONS) this.#given.delete(this.#given.keys().next().value!)
  }
}
