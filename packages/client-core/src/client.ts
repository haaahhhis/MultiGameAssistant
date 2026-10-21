/**
 * AdgClient: everything a UI shell needs, framework-free.
 *
 *   const client = new AdgClient({ url })
 *   client.start()
 *   client.sessions.subscribe(...)          // list, kept live
 *   const s = client.openSession(id)        // ref-counted handle
 *   s.state.subscribe(...); await s.prompt('hi')
 *   client.release(s)
 */
import type {
  ApprovalRequested, CredentialInfo, ModelCatalog, ModelSelection, QuestionAnswerItem, QuestionRequested, RequestInput, RequestResult, SessionItem, SessionModel,
} from '@adg/protocol'
import { RpcConnection, type RpcConnectionOptions } from './rpc.ts'
import { SessionHandle } from './session.ts'
import { Store } from './store.ts'

export interface SessionsState {
  /** Most recently updated first. */
  readonly items: readonly SessionItem[]
  readonly loaded: boolean
  readonly error: string | null
}

export interface AdgClientOptions extends Omit<RpcConnectionOptions, 'clientInfo'> {
  readonly clientInfo?: RpcConnectionOptions['clientInfo']
}

const byRecency = (a: SessionItem, b: SessionItem) => b.updatedAt - a.updatedAt

export class AdgClient {
  readonly connection: RpcConnection
  readonly sessions = new Store<SessionsState>({ items: [], loaded: false, error: null })
  readonly approvals = new Store<readonly ApprovalRequested[]>([])
  /** Questions the agent is waiting for an answer to (dsh's ask_user_question). */
  readonly questions = new Store<readonly QuestionRequested[]>([])
  /** Capability ids the gateway reported in the current generation. */
  readonly capabilities = new Store<ReadonlySet<string>>(new Set())
  /** Bumped whenever a stored credential changes; re-describe on change. */
  readonly credentialRevision = new Store<number>(0)
  /** Bumped whenever provider routes change; re-read providers and the model catalog. */
  readonly providersRevision = new Store<number>(0)
  /** Latest known model selection per session, fed by `session/model` notifications. */
  readonly sessionModels = new Store<ReadonlyMap<string, SessionModel>>(new Map())

  #handles = new Map<string, { handle: SessionHandle; refs: number }>()
  #bySubscription = new Map<string, SessionHandle>()
  #refreshQueued = false

  constructor(options: AdgClientOptions) {
    this.connection = new RpcConnection({
      ...options,
      clientInfo: options.clientInfo ?? { name: 'adg-client', version: '0.1.0' },
    })
    const c = this.connection

    c.onReady(() => {
      this.capabilities.set(new Set(c.server.get()?.capabilities.map(x => x.id) ?? []))
      // The gateway replays still-pending approvals and questions after initialize.
      this.approvals.set([])
      this.questions.set([])
      void this.refreshSessions()
    })

    c.on('sessions/changed', change => {
      if (change.kind === 'removed') {
        this.sessions.set(s => ({ ...s, items: s.items.filter(i => i.id !== change.sessionId) }))
        return
      }
      const known = this.sessions.get().items.some(i => i.id === change.item.id)
      if (!known) {
        // A partial delta for a session we have not listed yet: fetch the full row.
        this.#queueRefresh()
        return
      }
      this.sessions.set(s => ({
        ...s,
        items: s.items.map(i => (i.id === change.item.id ? { ...i, ...stripUndefined(change.item) } : i)).sort(byRecency),
      }))
    })
    c.on('session/title', ({ sessionId, title }) => {
      this.#handles.get(sessionId)?.handle.receiveTitle(title)
    })
    c.on('session/event', ({ subscriptionId, event }) => this.#bySubscription.get(subscriptionId)?.receiveEvent(event))
    c.on('session/live', ({ subscriptionId, frame }) => this.#bySubscription.get(subscriptionId)?.receiveLive(frame))
    c.on('session/closed', ({ subscriptionId, reason }) => {
      const handle = this.#bySubscription.get(subscriptionId)
      if (handle !== undefined && handle.subscriptionId === subscriptionId) handle.receiveClosed(reason)
    })
    c.on('approval/requested', request => {
      this.approvals.set(list => (list.some(a => a.approvalId === request.approvalId) ? list : [...list, request]))
    })
    c.on('approval/resolved', ({ approvalId }) => {
      this.approvals.set(list => list.filter(a => a.approvalId !== approvalId))
    })
    c.on('question/requested', request => {
      this.questions.set(list => (list.some(q => q.questionId === request.questionId) ? list : [...list, request]))
    })
    c.on('question/resolved', ({ questionId }) => {
      this.questions.set(list => list.filter(q => q.questionId !== questionId))
    })
    c.on('credentials/changed', () => this.credentialRevision.set(n => n + 1))
    c.on('providers/changed', () => this.providersRevision.set(n => n + 1))
    c.on('session/model', ({ sessionId, lastUsed, next }) => this.#setSessionModel(sessionId, { lastUsed, next }))
  }

  /** Whether each credential is configured, where from, and whether it can be written. Never values. */
  async describeCredentials(refs: readonly string[]): Promise<Readonly<Record<string, CredentialInfo>>> {
    const { items } = await this.connection.call('credentials/describe', { refs: [...refs] })
    return items
  }

  /** Store a credential on the host (persisted by dsh's credential provider). */
  async setCredential(ref: string, value: string): Promise<void> {
    await this.connection.call('credentials/set', { ref, value })
    this.credentialRevision.set(n => n + 1)
  }

  async unsetCredential(ref: string): Promise<void> {
    await this.connection.call('credentials/unset', { ref })
    this.credentialRevision.set(n => n + 1)
  }

  start(): void {
    this.connection.start()
  }

  stop(): void {
    for (const { handle } of this.#handles.values()) handle.close()
    this.#handles.clear()
    this.#bySubscription.clear()
    this.connection.stop()
  }

  has(capability: string): boolean {
    return this.capabilities.get().has(capability)
  }

  async refreshSessions(): Promise<void> {
    try {
      const { items } = await this.connection.call('sessions/list', {})
      this.sessions.set({ items: [...items].sort(byRecency), loaded: true, error: null })
    } catch (error) {
      this.sessions.set(s => ({ ...s, error: error instanceof Error ? error.message : String(error) }))
    }
  }

  async createSession(cwd?: string): Promise<string> {
    const { sessionId } = await this.connection.call('sessions/create', cwd === undefined ? {} : { cwd })
    await this.refreshSessions()
    return sessionId
  }

  async renameSession(sessionId: string, title: string): Promise<void> {
    const renamed = await this.connection.call('sessions/rename', { sessionId, title })
    this.sessions.set(s => ({ ...s, items: s.items.map(i => (i.id === sessionId ? { ...i, title: renamed.title } : i)) }))
    this.#handles.get(sessionId)?.handle.receiveTitle(renamed.title)
  }

  modelCatalog(): Promise<ModelCatalog> {
    return this.connection.call('models/catalog', {})
  }

  /** Read a session's model selection and cache it in `sessionModels`. */
  async sessionModel(sessionId: string): Promise<SessionModel> {
    const value = await this.connection.call('session/model', { sessionId })
    this.#setSessionModel(sessionId, value)
    return value
  }

  /** Choose the model the session's next request uses. */
  async selectModel(sessionId: string, selection: ModelSelection): Promise<ModelSelection> {
    const { selected } = await this.connection.call('session/selectModel', { sessionId, ...selection })
    const lastUsed = this.sessionModels.get().get(sessionId)?.lastUsed ?? null
    this.#setSessionModel(sessionId, { lastUsed, next: selected })
    return selected
  }

  listProviders(): Promise<RequestResult<'providers/list'>> {
    return this.connection.call('providers/list', {})
  }

  /** Ask an endpoint which models it serves. A key, if given, is used for this request only. */
  async discoverModels(params: RequestInput<'providers/discover'>, signal?: AbortSignal): Promise<RequestResult<'providers/discover'>['models']> {
    const { models } = await this.connection.call('providers/discover', params, signal)
    return models
  }

  async saveProvider(params: RequestInput<'providers/save'>): Promise<RequestResult<'providers/save'>> {
    const result = await this.connection.call('providers/save', params)
    this.providersRevision.set(n => n + 1)
    if (params.apiKey !== undefined) this.credentialRevision.set(n => n + 1)
    return result
  }

  async removeProvider(params: RequestInput<'providers/remove'>): Promise<RequestResult<'providers/remove'>> {
    const result = await this.connection.call('providers/remove', params)
    this.providersRevision.set(n => n + 1)
    if (params.removeKey === true) this.credentialRevision.set(n => n + 1)
    return result
  }

  async respondApproval(approvalId: string, decision: 'allow-once' | 'reject'): Promise<void> {
    await this.connection.call('approval/respond', { approvalId, decision })
    this.approvals.set(list => list.filter(a => a.approvalId !== approvalId))
  }

  /** Answer the agent's question; questions left out count as skipped. */
  async answerQuestion(questionId: string, answers: readonly QuestionAnswerItem[]): Promise<void> {
    await this.connection.call('question/respond', { questionId, answers: [...answers] })
    this.questions.set(list => list.filter(q => q.questionId !== questionId))
  }

  /** Get (or open) the handle for a session; pair every call with `release`. */
  openSession(sessionId: string): SessionHandle {
    const entry = this.#handles.get(sessionId)
    if (entry !== undefined) {
      entry.refs += 1
      return entry.handle
    }
    const handle = new SessionHandle(sessionId, this.connection, {
      bindSubscription: (h, subscriptionId) => {
        for (const [id, owner] of this.#bySubscription) if (owner === h) this.#bySubscription.delete(id)
        if (subscriptionId !== null) this.#bySubscription.set(subscriptionId, h)
      },
    })
    this.#handles.set(sessionId, { handle, refs: 1 })
    return handle
  }

  release(handle: SessionHandle): void {
    const entry = this.#handles.get(handle.id)
    if (entry === undefined || entry.handle !== handle) return
    entry.refs -= 1
    if (entry.refs > 0) return
    this.#handles.delete(handle.id)
    handle.close()
  }

  #setSessionModel(sessionId: string, value: SessionModel): void {
    this.sessionModels.set(map => new Map(map).set(sessionId, value))
  }

  #queueRefresh(): void {
    if (this.#refreshQueued) return
    this.#refreshQueued = true
    setTimeout(() => {
      this.#refreshQueued = false
      void this.refreshSessions()
    }, 150)
  }
}

/** Keep only the fields a partial delta actually carries. */
function stripUndefined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never
}
