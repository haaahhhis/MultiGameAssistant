/**
 * What of long-term memory (memory.ts) a conversation has been shown, so that
 * a change to the memory costs a short note, not the whole system prompt.
 *
 * dsh renders the system prompt again at every step and compares it with the
 * last one it sent. On a route that takes prompt changes in the history
 * (DeepSeek's), a changed prompt is appended whole, about 10,000 characters,
 * and stays in the context; once a compaction swallows those copies, dsh
 * writes the newest back at the head, and the next request misses the
 * provider's prompt cache from the changed line on: the rest of the prompt,
 * the tools after it and all of the history, some 18,000 tokens in a real
 * run. The memory section used to be rendered fresh each time, so every
 * memory_save, every automatic pass and every edit on 设置 → 记忆 did that.
 *
 * Now each conversation's memory section is pinned: the memory as it was when
 * the conversation began, rendered as of then, word for word the same at every
 * step. What changes after that goes in before a step as a short note after
 * the step's messages (`+` new, `~` changed, `-` gone), the way the time
 * reminder and recalled memory do (time-context.ts, recall.ts): another
 * agent's write, the automatic pass's, the user's edit. An agent's own
 * memory_save and memory_forget need no note, as their results say it. So:
 * - the core entries, the profile and the recent journal are in the pinned
 *   section, and what came since is in the notes: all of it in the context;
 * - an agent sees its own write at once (its tool's result), others' at its
 *   next step;
 * - a compaction that swallows notes (or tool results) gets what they said
 *   back in one note, from what is still in the conversation;
 * - the pinned section changes only when a compaction starts a new request
 *   series anyway and the notes would be long (`REPIN_CHARS`): then dsh
 *   rewrites the head once instead of the notes being sent after every
 *   compaction.
 *
 * A new conversation takes the newest pin of the same agent made that day, if
 * little has changed since, so its system prompt is the same as the others'
 * and the provider's cache already holds it. After a restart, a conversation's
 * pin is read back from the prompt it was last sent, and what its notes said
 * from the notes still in it: nothing is kept on disk, and the prompt stays
 * the same across restarts.
 */
import { randomUUID } from 'node:crypto'
import type { MemoryEntry, MemoryKind } from '@adg/protocol'
import { entryLine, KIND_NAMES, MEMORY_HEADING, memoryPrompt, memoryTail, stamp, type MemoryStore } from './memory.ts'

/** The message source of the notes: how history.ts and memory-auto.ts know they are no one's words, and how a view finds them again. */
export const MEMORY_NOTE_SOURCE = 'adg-memory'
/** Notes this long are worth a new pin, when a compaction starts a new request series anyway. */
export const REPIN_CHARS = 6000
/** A new conversation takes the day's pin when the note it would need is no longer than this. */
export const SHARE_CHARS = 1500
/** The longest note; changes past it are counted, and found with memory_search. */
export const MAX_NOTE_CHARS = 4000
/** Conversations whose views are kept; one let go is read back from its prompt. */
const MAX_VIEWS = 500
/** A pin read back from a prompt is taken as made this long before the prompt was sent. */
const RESTORE_MARGIN_MS = 60_000

/** The slice of a dsh session the views read. */
export interface ViewSession {
  readonly id: string
  /** The number of records so far: the next one's seq. */
  readonly seq?: number
  readonly surface?: { readonly nodes?: readonly number[]; readonly contentGeneration?: number }
  eventAt?(seq: number): ViewEvent | undefined
}

export interface ViewEvent {
  readonly type: string
  readonly time?: number
  readonly data?: unknown
  /** A replacement (a summary, an archive pointer, a pruned tool result): `{ op: 'replace', … }`. */
  readonly surfaceOp?: unknown
}

/** The slice of dsh's agent loop a section reads: the conversation, and the content generation its last request was built on. */
export interface ViewAgent {
  readonly session: ViewSession
  readonly requestSurfaceGeneration?: unknown
}

/** One change a note told: an entry's line as the prompt shows it, null when it is gone. */
export interface MemoryChange {
  readonly id: string
  readonly line: string | null
}

/** The memory section as pinned. */
interface Pin {
  /** When it was rendered (ms): an entry changed later than this is news. */
  readonly at: number
  /** That day, in the user's time zone. */
  readonly day: string
  readonly text: string
  /** The entries the text shows: id → line. */
  readonly lines: ReadonlyMap<string, string>
}

interface View {
  readonly owner: string
  readonly lead: string | undefined
  pin: Pin
  /** Notes recorded before this seq are about an earlier pin. */
  since: number
  /** What the notes still in the conversation said. */
  noted: Map<string, string | null>
  /** The agent's own writes, by the record its call was made at: their results said them. */
  own: Map<string, { readonly line: string | null; readonly seq: number }>
  /** The conversation's content generation when `noted` and `own` were last checked against it. */
  gen: number | undefined
  /** The memory's version when the changes were last worked out. */
  version: number
}

export interface MemoryDiff {
  readonly added: readonly MemoryEntry[]
  readonly changed: readonly MemoryEntry[]
  readonly gone: readonly { readonly id: string; readonly was: string }[]
}

/** The entries a memory section shows (its `- [id] …` lines): id → line. */
export function shownLines(section: string): Map<string, string> {
  const lines = new Map<string, string>()
  for (const line of section.split('\n')) {
    const id = /^- \[([A-Za-z0-9_-]+)\] /.exec(line)?.[1]
    if (id !== undefined) lines.set(id, line)
  }
  return lines
}

/** A conversation's memory section, as it is in the system prompt it was sent; undefined when it has none of this shape. */
export function memorySectionIn(prompt: string, lead: string | undefined): string | undefined {
  const open = `${MEMORY_HEADING}\n\n`
  const inside = prompt.indexOf(`\n\n${open}`)
  const start = prompt.startsWith(open) ? 0 : inside < 0 ? -1 : inside + 2
  if (start < 0) return undefined
  const tail = memoryTail(lead)
  const end = prompt.indexOf(tail, start)
  if (end < 0) return undefined
  const after = prompt.slice(end + tail.length)
  return after === '' || after.startsWith('\n\n') ? prompt.slice(start, end + tail.length) : undefined
}

/**
 * What changed among the entries an agent reads, against what it was shown
 * (`known`: id → line, null when told it is gone). An entry it was never shown
 * is news only when it changed since the pin (`since`, the same millisecond
 * counting: it may have come just after); older ones were left out of the
 * prompt for room, and memory_search finds them.
 */
export function diffOf(entries: readonly MemoryEntry[], known: ReadonlyMap<string, string | null>, since: number, owner: string, timeZone: string | undefined): MemoryDiff {
  const added: MemoryEntry[] = []
  const changed: MemoryEntry[] = []
  const present = new Set<string>()
  for (const entry of entries) {
    present.add(entry.id)
    const was = known.get(entry.id)
    if (was === undefined || was === null) {
      if (was === null || Date.parse(entry.updatedAt) >= since) added.push(entry)
    } else if (was !== entryLine(entry, owner, timeZone)) {
      changed.push(entry)
    }
  }
  const gone = [...known].flatMap(([id, was]) => (was === null || present.has(id) ? [] : [{ id, was }]))
  return { added, changed, gone }
}

const isEmpty = (diff: MemoryDiff) => diff.added.length === 0 && diff.changed.length === 0 && diff.gone.length === 0

const KIND_ORDER: Record<MemoryKind, number> = { core: 0, profile: 1, journal: 2 }
const NOTE_HEAD = '（记忆更新：这个对话开始以后长期记忆的变化，以这里为准。+ 新记的，~ 改过的（换掉同一 id 的那条），- 删掉的）'
/** An entry's words, without the id and the time in front. */
const wordsOf = (line: string) => line.replace(/^- \[[^\]]+\] (\([^()]*\) )?/, '')
const clip = (text: string, max: number) => (text.length > max ? `${text.slice(0, max)}…` : text)

/**
 * The note for a diff; the changes it tells (every one, those past its length
 * too: they are found with memory_search); and how long it would be with all
 * of them listed.
 */
export function noteOf(diff: MemoryDiff, owner: string, timeZone: string | undefined): { text: string; changes: MemoryChange[]; size: number } {
  const rows: { text: string; change: MemoryChange }[] = []
  const entries = [...diff.added.map(entry => ['+', entry] as const), ...diff.changed.map(entry => ['~', entry] as const)]
  for (const [mark, entry] of entries.sort((a, b) => KIND_ORDER[a[1].kind] - KIND_ORDER[b[1].kind])) {
    const line = entryLine(entry, owner, timeZone)
    const words = entry.kind === 'core' ? `：${entry.text}` : ` ${line.replace(/^- \[[^\]]+\] /, '')}`
    rows.push({ text: `${mark} [${entry.id}] ${KIND_NAMES[entry.kind]}${words}`, change: { id: entry.id, line } })
  }
  for (const { id, was } of diff.gone) rows.push({ text: `- [${id}] 已删除（原来是：${clip(wordsOf(was), 40)}）`, change: { id, line: null } })
  const lines = [NOTE_HEAD]
  let length = NOTE_HEAD.length
  let left = 0
  for (const row of rows) {
    if (left > 0 || length + row.text.length + 1 > MAX_NOTE_CHARS) { left++; continue }
    lines.push(row.text)
    length += row.text.length + 1
  }
  if (left > 0) lines.push(`（还有 ${left} 条变化没列出，要用时用 memory_search 查）`)
  const size = rows.reduce((sum, row) => sum + row.text.length + 1, NOTE_HEAD.length)
  return { text: lines.join('\n'), changes: rows.map(row => row.change), size }
}

/** A user-role message as dsh's createUserMessage makes it, carrying what it tells so a view can read it back. */
export function memoryNoteMessage(text: string, changes: readonly MemoryChange[]): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({
      kind: MEMORY_NOTE_SOURCE,
      form: 'snapshot',
      changes: Object.freeze(changes.map(change => Object.freeze({ id: change.id, line: change.line }))),
      sections: Object.freeze([Object.freeze({ name: MEMORY_NOTE_SOURCE, text })]),
    }),
  })
}

/** Each conversation's pinned memory section and what its notes have told. */
export class MemoryViews {
  readonly #store: MemoryStore
  readonly #timeZone: string | undefined
  readonly #now: () => number
  readonly #views = new Map<string, View>()
  /** The newest pin of each agent (and each lead's sub-agents): what a new conversation that day takes. */
  readonly #latest = new Map<string, Pin>()

  constructor(store: MemoryStore, options: { timeZone?: string; now?: () => number } = {}) {
    this.#store = store
    this.#timeZone = options.timeZone
    this.#now = options.now ?? Date.now
  }

  /**
   * The memory section of a conversation's system prompt, at each assembly:
   * its pin, made now for a new conversation, read back from the prompt after
   * a restart, and made anew only when a compaction starts a new request
   * series and the notes since the pin would be long.
   * @param lead - the agent a sub-agent works for; absent for a lead agent.
   */
  section(agent: ViewAgent, owner: string, lead: string | undefined): string {
    const session = agent.session
    const now = this.#now()
    // Not read yet: what the file holds is not known, so nothing is pinned.
    if (!this.#store.ready) return this.#render(owner, lead, now)
    let view = this.#views.get(session.id)
    if (view !== undefined && (view.owner !== owner || view.lead !== lead)) view = undefined
    const known = view ?? this.#restored(session, owner, lead)
    if (known !== undefined) {
      view = known
      if (startsSeries(agent) && this.#pending(view, session) > REPIN_CHARS) this.#repin(view, session, now)
    } else {
      view = this.#started(session, owner, lead, now)
    }
    this.#keep(session.id, view)
    return view.pin.text
  }

  /** The note for a step: what changed and the conversation has not been told; undefined when nothing. */
  note(session: ViewSession): unknown {
    const view = this.#views.get(session.id)
    if (view === undefined || !this.#store.ready) return undefined
    this.#look(view, session)
    if (view.version === this.#store.version) return undefined
    const diff = this.#diff(view)
    view.version = this.#store.version
    if (isEmpty(diff)) return undefined
    const { text, changes } = noteOf(diff, view.owner, this.#timeZone)
    for (const change of changes) {
      view.noted.set(change.id, change.line)
      view.own.delete(change.id)
    }
    return memoryNoteMessage(text, changes)
  }

  /** An agent wrote (`entry`) or forgot (undefined) one in a conversation, at record `seq`: its tool's result tells it. */
  wrote(sessionId: string, id: string, entry: MemoryEntry | undefined, seq = -1): void {
    const view = this.#views.get(sessionId)
    if (view === undefined) return
    view.own.set(id, { line: entry === undefined ? null : entryLine(entry, view.owner, this.#timeZone), seq })
  }

  /** The entries a conversation has in view (pinned or told since), so recall does not bring them again; undefined when it has no view. */
  inView(sessionId: string): ReadonlySet<string> | undefined {
    const view = this.#views.get(sessionId)
    if (view === undefined) return undefined
    const known = this.#known(view)
    return new Set([...known].flatMap(([id, line]) => (line === null ? [] : [id])))
  }

  #render(owner: string, lead: string | undefined, now: number): string {
    return memoryPrompt(this.#store.visibleTo(owner), owner, { now: new Date(now), ...(this.#timeZone === undefined ? {} : { timeZone: this.#timeZone }), ...(lead === undefined ? {} : { lead }) })
  }

  #pin(owner: string, lead: string | undefined, now: number): Pin {
    const text = this.#render(owner, lead, now)
    const pin = { at: now, day: this.#day(now), text, lines: shownLines(text) }
    this.#latest.set(keyOf(owner, lead), pin)
    return pin
  }

  #day(at: number): string {
    return stamp(new Date(at).toISOString(), this.#timeZone).slice(0, 10)
  }

  /** A conversation new to this view: the day's pin when little has changed since, else a new one. */
  #started(session: ViewSession, owner: string, lead: string | undefined, now: number): View {
    const since = typeof session.seq === 'number' ? session.seq : 0
    const latest = this.#latest.get(keyOf(owner, lead))
    if (latest !== undefined && latest.day === this.#day(now)) {
      const view = viewOf(owner, lead, latest, since)
      const diff = this.#diff(view)
      if (isEmpty(diff) || noteOf(diff, owner, this.#timeZone).size <= SHARE_CHARS) return view
    }
    return viewOf(owner, lead, this.#pin(owner, lead, now), since)
  }

  /** After a restart (or a view let go): the section as the conversation's newest prompt has it. */
  #restored(session: ViewSession, owner: string, lead: string | undefined): View | undefined {
    const head = latestPrompt(session)
    if (head === undefined) return undefined
    const text = memorySectionIn(head.text, lead)
    if (text === undefined) return undefined
    const at = head.time - RESTORE_MARGIN_MS
    return viewOf(owner, lead, { at, day: this.#day(at), text, lines: shownLines(text) }, head.seq)
  }

  #repin(view: View, session: ViewSession, now: number): void {
    view.pin = this.#pin(view.owner, view.lead, now)
    view.since = typeof session.seq === 'number' ? session.seq : 0
    view.noted = new Map()
    view.own.clear()
    view.version = -1
  }

  /** How long a note now would be, with every change listed. */
  #pending(view: View, session: ViewSession): number {
    this.#look(view, session)
    const diff = this.#diff(view)
    return isEmpty(diff) ? 0 : noteOf(diff, view.owner, this.#timeZone).size
  }

  /**
   * After the conversation changed other than at its end (a compaction, a
   * restart): what is told is what is still in it. Notes are read back; an
   * own write counts while its call is after every span compacted away.
   */
  #look(view: View, session: ViewSession): void {
    const gen = session.surface?.contentGeneration
    if (typeof gen !== 'number' || gen === view.gen) return
    view.gen = gen
    // What was told may be gone: the next note works it out again.
    view.version = -1
    const nodes = session.surface?.nodes ?? []
    view.noted = notesIn(session, nodes, view.since)
    const from = keptFrom(session, nodes)
    for (const [id, mark] of view.own) if (mark.seq < from) view.own.delete(id)
  }

  #known(view: View): Map<string, string | null> {
    const known = new Map<string, string | null>(view.pin.lines)
    for (const [id, line] of view.noted) known.set(id, line)
    for (const [id, mark] of view.own) known.set(id, mark.line)
    return known
  }

  #diff(view: View): MemoryDiff {
    return diffOf(this.#store.visibleTo(view.owner), this.#known(view), view.pin.at, view.owner, this.#timeZone)
  }

  #keep(sessionId: string, view: View): void {
    this.#views.delete(sessionId)
    this.#views.set(sessionId, view)
    while (this.#views.size > MAX_VIEWS) this.#views.delete(this.#views.keys().next().value!)
  }
}

const keyOf = (owner: string, lead: string | undefined) => `${owner}\u0000${lead ?? ''}`

function viewOf(owner: string, lead: string | undefined, pin: Pin, since: number): View {
  return { owner, lead, pin, since, noted: new Map(), own: new Map(), gen: undefined, version: -1 }
}

/** Will this step's request start a new series (dsh rewrites the prompt's head instead of appending a copy)? */
function startsSeries(agent: ViewAgent): boolean {
  const built = agent.requestSurfaceGeneration
  const now = agent.session.surface?.contentGeneration
  return typeof built === 'number' && typeof now === 'number' && built !== now
}

const isReplacement = (event: ViewEvent) => typeof event.surfaceOp === 'object' && event.surfaceOp !== null

/** The newest non-empty system prompt in the conversation: what dsh compares the next one with. */
function latestPrompt(session: ViewSession): { text: string; seq: number; time: number } | undefined {
  const nodes = session.surface?.nodes ?? []
  for (let i = nodes.length - 1; i >= 0; i--) {
    const seq = nodes[i]!
    const event = session.eventAt?.(seq)
    if (event?.type !== 'system/message' || typeof event.time !== 'number') continue
    const content = (event.data as { message?: { content?: unknown } } | undefined)?.message?.content
    const block = Array.isArray(content) && content.length === 1 ? (content[0] as { type?: unknown; text?: unknown }) : undefined
    if (block?.type === 'text' && typeof block.text === 'string' && block.text !== '') return { text: block.text, seq, time: event.time }
  }
  return undefined
}

/** What the memory notes still in the conversation told, oldest first, from record `since` on. */
function notesIn(session: ViewSession, nodes: readonly number[], since: number): Map<string, string | null> {
  const told = new Map<string, string | null>()
  for (const seq of nodes) {
    if (seq < since) continue
    const event = session.eventAt?.(seq)
    if (event?.type !== 'user/message') continue
    const source = (event.data as { source?: { kind?: unknown; changes?: unknown } } | undefined)?.source
    if (source?.kind !== MEMORY_NOTE_SOURCE || !Array.isArray(source.changes)) continue
    for (const change of source.changes as { id?: unknown; line?: unknown }[]) {
      if (typeof change.id === 'string' && (typeof change.line === 'string' || change.line === null)) told.set(change.id, change.line)
    }
  }
  return told
}

/**
 * The first record still in the conversation after the newest replacement in
 * it: compaction takes the oldest part, so everything from here on is there
 * word for word. -Infinity when nothing was replaced.
 */
function keptFrom(session: ViewSession, nodes: readonly number[]): number {
  let from = -Infinity
  for (const seq of nodes) {
    const event = session.eventAt?.(seq)
    if (event === undefined || event.type === 'system/message') continue
    if (isReplacement(event)) from = Infinity
    else if (from === Infinity) from = seq
  }
  return from
}
