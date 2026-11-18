/**
 * The person's messages that are not in the conversation yet: still waiting
 * in dsh's inbox, or taken from it for a step and not yet written to the log.
 *
 * dsh takes a step's messages out of the inbox first (`agent/inbox/claimed`)
 * and logs them as `user/message` only once the step has been assembled.
 * Whatever the app does before a step runs in between (a compaction after a
 * long silence calls the model), so on a slow or broken network a message can
 * be in neither place for a long time. `TakenInput` keeps those so the queue
 * still lists them (placement `taken`) and the chat shows them.
 */
import type { QueuedPrompt } from '@adg/protocol'

/** dsh's pending message (dsh-agent UserMessage), structurally. */
export interface InboxMessage {
  readonly id?: unknown
  readonly source?: { readonly kind?: unknown; readonly rpcId?: unknown }
  readonly content?: unknown
}

/** The sources a person sends from (convert.ts HUMAN_SOURCES). */
const HUMAN = new Set(['user', 'user-rpc'])

/** Whether a pending message is one the person sent. */
export function isHuman(message: InboxMessage): boolean {
  return typeof message.id === 'string' && typeof message.source?.kind === 'string' && HUMAN.has(message.source.kind)
}

/** One pending message as a queue item; undefined for what the person did not send (a sub-agent's report, a reminder). */
export function queuedPrompt(message: InboxMessage, placement: QueuedPrompt['placement']): QueuedPrompt | undefined {
  if (!isHuman(message)) return undefined
  const content = Array.isArray(message.content) ? message.content as { type?: unknown; text?: unknown }[] : []
  const text = content.filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text as string).join('\n')
  const images = content.filter(c => c.type === 'image').length
  return {
    id: message.id as string,
    ...(typeof message.source?.rpcId === 'string' ? { requestId: message.source.rpcId } : {}),
    text,
    ...(images === 0 ? {} : { images }),
    placement,
  }
}

/**
 * The people's messages still waiting in dsh's `inbox` projection, in the
 * order they will run: `next-step` ones go into the running turn first; then
 * the ones already taken for a step that is still being prepared.
 * Other inbox entries (a subagent's report, a reminder) are not shown.
 */
export function toQueue(inbox: unknown, taken: readonly QueuedPrompt[] = []): QueuedPrompt[] {
  const items: QueuedPrompt[] = []
  for (const placement of ['next-step', 'next-turn'] as const) {
    const list = (inbox as Record<string, unknown> | undefined)?.[placement]
    if (!Array.isArray(list)) continue
    for (const message of list as InboxMessage[]) {
      const item = queuedPrompt(message, placement)
      if (item !== undefined) items.push(item)
    }
  }
  const waiting = new Set(items.map(item => item.id))
  return [...taken.filter(item => !waiting.has(item.id)), ...items]
}

/** The person's messages dsh took for a step and has not logged yet, by session. */
export class TakenInput {
  readonly #taken = new Map<string, Map<string, { readonly message: InboxMessage; readonly item: QueuedPrompt }>>()
  /** Messages already handed back once (`lost`): a step that keeps failing before it logs them does not loop. */
  readonly #handedBack = new Set<string>()
  readonly #changed: (sessionId: string) => void

  /** @param changed - called when a session's taken messages change (to send its queue again). */
  constructor(changed: (sessionId: string) => void) {
    this.#changed = changed
  }

  /** dsh took `message` from the inbox for a step. */
  take(sessionId: string, message: InboxMessage): void {
    const item = queuedPrompt(message, 'taken')
    if (item === undefined) return
    let taken = this.#taken.get(sessionId)
    if (taken === undefined) this.#taken.set(sessionId, taken = new Map())
    taken.set(item.id, { message, item })
    this.#changed(sessionId)
  }

  /** A message was written to the log: it is in the conversation now. */
  logged(sessionId: string, messageId: string): void {
    this.#handedBack.delete(messageId)
    const taken = this.#taken.get(sessionId)
    if (taken === undefined || !taken.delete(messageId)) return
    if (taken.size === 0) this.#taken.delete(sessionId)
    this.#changed(sessionId)
  }

  /**
   * The agent stopped with taken messages it never logged (its step failed
   * before it got that far): they are no longer taken.
   * @returns the ones to hand back to the agent, each at most once.
   */
  lost(sessionId: string): InboxMessage[] {
    const taken = this.#taken.get(sessionId)
    if (taken === undefined) return []
    this.#taken.delete(sessionId)
    this.#changed(sessionId)
    const back: InboxMessage[] = []
    for (const [id, { message }] of taken) {
      if (this.#handedBack.has(id)) {
        this.#handedBack.delete(id)
        continue
      }
      this.#handedBack.add(id)
      back.push(message)
    }
    return back
  }

  /** The agent stopped: nothing it took is still on its way to the log. */
  clear(sessionId: string): void {
    if (this.#taken.delete(sessionId)) this.#changed(sessionId)
  }

  /** A session's taken messages as queue items, in the order taken. */
  items(sessionId: string): QueuedPrompt[] {
    return [...(this.#taken.get(sessionId)?.values() ?? [])].map(({ item }) => item)
  }
}

/** What `resumeAfterError` uses of a dsh agent (dsh-agent-loop ReactLoopAgent), structurally. */
export interface ResumableAgent {
  readonly status?: unknown
  readonly session: { readonly id: string }
  readonly lifetimeSignal?: AbortSignal
  readonly inbox: { readonly nextStep: readonly InboxMessage[]; remove(messageId: string): boolean }
  /** Queue for a new turn and wake the agent. */
  followup(message: InboxMessage): void
  /** Queue for the next step and wake the agent. */
  steer(message: InboxMessage): void
}

/**
 * The agent went idle after a turn that ended in an error (a model the
 * network could not reach). dsh starts a new turn only for what waits in
 * `next-turn`, so the person's 「插入当前轮次」 message would stay in the queue
 * until they sent something else, and a message taken for a step that failed
 * before logging it would be gone. Both go to the agent in a new turn.
 * @returns how many of the person's messages were handed on.
 */
export function resumeAfterError(agent: ResumableAgent, taken: TakenInput): number {
  if (agent.status !== 'idle' || agent.lifetimeSignal?.aborted === true) return 0
  const lost = taken.lost(agent.session.id)
  // Each wakes the agent; the turn it opens also takes everything waiting for the next step.
  for (const message of lost) agent.followup(message)
  const stuck = agent.inbox.nextStep.filter(isHuman)
  if (lost.length > 0) return lost.length + stuck.length
  const last = stuck.at(-1)
  // Sent again, with the wake-up the first sending did not need: the turn dsh opens takes the rest with it.
  if (last === undefined || !agent.inbox.remove(last.id as string)) return 0
  agent.steer(last)
  return stuck.length
}
