/**
 * One opened session: the loaded event window, the streaming attempt, local
 * prompt echoes, and the operations a UI performs on it.
 *
 * The handle re-opens itself after every reconnect (new connection
 * generation) and after the gateway ends its subscription unexpectedly.
 */
import type { PromptImage,
  LiveFrame, RequestInput, RequestMethod, RequestResult, SessionEvent, SessionHeader,
} from '@adg/protocol'
import type { LiveAttemptView } from '@adg/trajectory'
import { Store } from './store.ts'

/** What a handle needs from the connection; lets tests run without a socket. */
export interface SessionTransport {
  readonly ready: boolean
  call<M extends RequestMethod>(method: M, params: RequestInput<M>, signal?: AbortSignal): Promise<RequestResult<M>>
  onReady(handler: (generation: number) => void): () => void
}

/** A prompt sent from this client but not yet visible in the log. */
export interface PendingPrompt {
  readonly requestId: string
  readonly text: string
  /** Images sent with it (for the echo). */
  readonly images?: number
  readonly mode: 'queue' | 'steer'
  readonly sentAt: number
  readonly failed?: string
}

export interface SessionState {
  readonly status: 'opening' | 'open' | 'closed' | 'error'
  readonly header: SessionHeader | null
  readonly title: string | null
  /** Loaded durable events, ascending and unique by seq. */
  readonly events: readonly SessionEvent[]
  /** Inclusive durable cut of the opening window (history paging anchor). */
  readonly cursor: number
  readonly hasMore: boolean
  readonly loadingOlder: boolean
  readonly live: LiveAttemptView | null
  readonly pending: readonly PendingPrompt[]
  /** A turn is open in the loaded window, or output is streaming. */
  readonly running: boolean
  /** Bumped on every change, including in-place live delta appends. */
  readonly version: number
  readonly error: string | null
}

const INITIAL: SessionState = {
  status: 'opening', header: null, title: null, events: [], cursor: -1, hasMore: false,
  loadingOlder: false, live: null, pending: [], running: false, version: 0, error: null,
}

type Delta = Extract<LiveFrame, { type: 'delta' }>
type MutableLive = { -readonly [K in keyof LiveAttemptView]: LiveAttemptView[K] } & { deltas: Delta[] }

export interface SessionHandleHooks {
  /** Called when the handle gains or loses a gateway subscription id. */
  readonly bindSubscription: (handle: SessionHandle, subscriptionId: string | null) => void
}

export class SessionHandle {
  readonly id: string
  readonly state = new Store<SessionState>(INITIAL)

  #transport: SessionTransport
  #hooks: SessionHandleHooks
  #subscriptionId: string | null = null
  #openedGeneration = -1
  #closed = false
  #opening: Promise<void> | null = null
  #disposeReady: () => void
  #reopenTimer: ReturnType<typeof setTimeout> | undefined

  constructor(id: string, transport: SessionTransport, hooks: SessionHandleHooks) {
    this.id = id
    this.#transport = transport
    this.#hooks = hooks
    this.#disposeReady = transport.onReady(generation => {
      if (generation !== this.#openedGeneration) void this.#open(generation)
    })
  }

  get subscriptionId(): string | null {
    return this.#subscriptionId
  }

  /** Send a prompt. `steer` injects it into the running turn; `queue` waits for the next. */
  async prompt(text: string, mode: 'queue' | 'steer' = 'queue', images: readonly PromptImage[] = []): Promise<void> {
    const requestId = crypto.randomUUID()
    const echo: PendingPrompt = { requestId, text, mode, sentAt: Date.now(), ...(images.length === 0 ? {} : { images: images.length }) }
    this.#update(s => ({ ...s, pending: [...s.pending, echo] }))
    try {
      await this.#transport.call('session/prompt', { sessionId: this.id, requestId, text, mode, ...(images.length === 0 ? {} : { images: [...images] }) })
    } catch (error) {
      const failed = error instanceof Error ? error.message : String(error)
      this.#update(s => ({ ...s, pending: s.pending.map(p => (p.requestId === requestId ? { ...p, failed } : p)) }))
      throw error
    }
  }

  /** Drop a failed echo from the transcript. */
  dismissPending(requestId: string): void {
    this.#update(s => ({ ...s, pending: s.pending.filter(p => p.requestId !== requestId) }))
  }

  async cancel(): Promise<void> {
    await this.#transport.call('session/cancel', { sessionId: this.id })
  }

  async loadOlder(): Promise<void> {
    const s = this.state.get()
    const first = s.events[0]
    if (!s.hasMore || s.loadingOlder || first === undefined) return
    this.#update(x => ({ ...x, loadingOlder: true }))
    try {
      const page = await this.#transport.call('session/history', {
        sessionId: this.id, throughSeq: s.cursor, beforeSeq: first.seq,
      })
      this.#update(x => {
        const head = x.events[0]?.seq ?? Number.POSITIVE_INFINITY
        const older = page.events.filter(e => e.seq < head)
        return { ...x, events: [...older, ...x.events], hasMore: page.hasMore, loadingOlder: false }
      })
    } catch (error) {
      this.#update(x => ({ ...x, loadingOlder: false, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    clearTimeout(this.#reopenTimer)
    this.#disposeReady()
    const subscriptionId = this.#subscriptionId
    this.#bind(null)
    if (subscriptionId !== null && this.#transport.ready) {
      void this.#transport.call('session/close', { subscriptionId }).catch(() => {})
    }
    this.#update(s => ({ ...s, status: 'closed' }))
  }

  // ── notifications routed by the client ──────────────────────────────────

  /** @internal */
  receiveEvent(event: SessionEvent): void {
    this.#update(s => {
      const last = s.events.at(-1)
      if (last !== undefined && event.seq <= last.seq) return s
      let pending = s.pending
      if (event.type === 'user/message' && event.requestId !== undefined) {
        pending = pending.filter(p => p.requestId !== event.requestId)
      }
      let live = s.live
      if ((event.type === 'assistant/message' || event.type === 'assistant/attempt')
        && live !== null && live.turn === event.turn && live.step === event.step) {
        live = null
      }
      const title = event.type === 'session/title' ? event.title : s.title
      const events = [...s.events, event]
      return { ...s, events, pending, live, title, running: computeRunning(events, live) }
    })
  }

  /** @internal */
  receiveLive(frame: LiveFrame): void {
    this.#update(s => {
      switch (frame.type) {
        case 'start': {
          const live: MutableLive = { attemptId: frame.attemptId, turn: frame.turn, step: frame.step, afterSeq: frame.afterSeq, deltas: [] }
          return { ...s, live, running: true }
        }
        case 'delta': {
          const live = s.live as MutableLive | null
          if (live === null || live.attemptId !== frame.attemptId) return s
          live.deltas.push(frame) // in place: streams can be long; `version` signals the change
          return { ...s, live: { ...live } }
        }
        case 'end': {
          if (s.live?.attemptId !== frame.attemptId) return s
          return { ...s, live: null, running: computeRunning(s.events, null) }
        }
      }
    })
  }

  /** @internal */
  receiveClosed(reason: string): void {
    this.#bind(null)
    if (this.#closed) return
    this.#update(s => ({ ...s, status: 'error', error: `stream ended: ${reason}` }))
    // Re-open on the live connection after a short pause; a reconnect re-opens anyway.
    this.#reopenTimer = setTimeout(() => {
      if (!this.#closed && this.#transport.ready) void this.#open(this.#openedGeneration)
    }, 1000)
  }

  /** Update the title from list-level notifications. @internal */
  receiveTitle(title: string | null): void {
    this.#update(s => (s.title === title ? s : { ...s, title }))
  }

  // ── internals ───────────────────────────────────────────────────────────

  async #open(generation: number): Promise<void> {
    if (this.#closed) return
    if (this.#opening !== null) return this.#opening
    this.#openedGeneration = generation
    this.#opening = (async () => {
      try {
        const opened = await this.#transport.call('session/open', { sessionId: this.id })
        if (this.#closed) {
          void this.#transport.call('session/close', { subscriptionId: opened.subscriptionId }).catch(() => {})
          return
        }
        this.#bind(opened.subscriptionId)
        const live: MutableLive | null = opened.live === null ? null : { ...opened.live, deltas: [...opened.live.deltas] }
        this.#update(s => {
          const echoed = new Set(opened.events.flatMap(e => (e.type === 'user/message' && e.requestId !== undefined ? [e.requestId] : [])))
          return {
            ...s,
            status: 'open',
            header: opened.header,
            title: opened.title,
            events: opened.events,
            cursor: opened.cursor,
            hasMore: opened.hasMore,
            live,
            pending: s.pending.filter(p => !echoed.has(p.requestId)),
            running: computeRunning(opened.events, live),
            loadingOlder: false,
            error: null,
          }
        })
      } catch (error) {
        this.#update(s => ({ ...s, status: 'error', error: error instanceof Error ? error.message : String(error) }))
      } finally {
        this.#opening = null
      }
    })()
    return this.#opening
  }

  #bind(subscriptionId: string | null): void {
    this.#subscriptionId = subscriptionId
    this.#hooks.bindSubscription(this, subscriptionId)
  }

  #update(next: (state: SessionState) => SessionState): void {
    this.state.set(previous => {
      const value = next(previous)
      return value === previous ? previous : { ...value, version: previous.version + 1 }
    })
  }
}

/** Whether the loaded window has an open turn or output is streaming. */
export function computeRunning(events: readonly SessionEvent[], live: LiveAttemptView | null): boolean {
  if (live !== null) return true
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const event = events[i] as SessionEvent
    if (event.type === 'turn/end') return false
    if (event.type === 'turn/start') return true
  }
  return false
}
