/**
 * JSON-RPC 2.0 connection to the adg gateway with automatic reconnect.
 *
 * Each successful `initialize` starts a new generation; stores re-sync on
 * `onReady`. Calls fail fast while disconnected, and an aborted signal sends
 * `$/cancelRequest` so the gateway stops the work.
 */
import {
  classify, ErrorCode, PROTOCOL_VERSION, RpcError,
  type NotificationMethod, type NotificationParams, type RequestInput, type RequestMethod, type RequestResult,
} from '@adg/protocol'
import { Store } from './store.ts'

export type ConnectionState = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'stopped'

export interface ConnectionStatus {
  readonly state: ConnectionState
  /** Consecutive failed attempts since the last open connection. */
  readonly attempt: number
  readonly error?: string
}

/** The subset of the WebSocket API the connection uses (browser, Node 22+, Electron). */
export interface SocketLike {
  readonly readyState: number
  send(data: string): void
  close(code?: number, reason?: string): void
  addEventListener(type: 'open' | 'close' | 'error' | 'message', listener: (event: any) => void): void
}

export interface RpcConnectionOptions {
  /** Full `ws://…/rpc?token=…` endpoint. */
  readonly url: string
  readonly clientInfo: { readonly name: string; readonly version: string }
  /** Socket factory; defaults to the global `WebSocket`. */
  readonly createSocket?: (url: string) => SocketLike
  readonly backoffMs?: { readonly initial: number; readonly max: number }
  /** Per-call timeout; 0 disables. @default 60000 */
  readonly callTimeoutMs?: number
}

type InitializeResult = RequestResult<'initialize'>

interface PendingCall {
  readonly resolve: (value: unknown) => void
  readonly reject: (error: Error) => void
  readonly cleanup: () => void
}

const OPEN = 1

export class RpcConnection {
  readonly status = new Store<ConnectionStatus>({ state: 'idle', attempt: 0 })
  readonly server = new Store<InitializeResult | null>(null)

  #options: RpcConnectionOptions
  #socket: SocketLike | null = null
  #ready = false
  #generation = 0
  #nextId = 1
  #pending = new Map<number, PendingCall>()
  #handlers = new Map<string, Set<(params: unknown) => void>>()
  #readyHandlers = new Set<(generation: number) => void>()
  #retryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: RpcConnectionOptions) {
    this.#options = options
  }

  get generation(): number {
    return this.#generation
  }

  get ready(): boolean {
    return this.#ready
  }

  start(): void {
    if (this.status.get().state !== 'idle' && this.status.get().state !== 'stopped') return
    this.#connect()
  }

  stop(): void {
    clearTimeout(this.#retryTimer)
    this.status.set({ state: 'stopped', attempt: 0 })
    const socket = this.#socket
    this.#socket = null
    this.#teardown('connection stopped')
    socket?.close(1000, 'client stopped')
  }

  /** Subscribe to one notification method. */
  on<M extends NotificationMethod>(method: M, handler: (params: NotificationParams<M>) => void): () => void {
    let set = this.#handlers.get(method)
    if (set === undefined) this.#handlers.set(method, set = new Set())
    set.add(handler as (params: unknown) => void)
    return () => { set.delete(handler as (params: unknown) => void) }
  }

  /** Run after every successful initialize (first connect and each reconnect). */
  onReady(handler: (generation: number) => void): () => void {
    this.#readyHandlers.add(handler)
    if (this.#ready) queueMicrotask(() => handler(this.#generation))
    return () => { this.#readyHandlers.delete(handler) }
  }

  call<M extends RequestMethod>(method: M, params: RequestInput<M>, signal?: AbortSignal): Promise<RequestResult<M>> {
    if (!this.#ready && method !== 'initialize') {
      return Promise.reject(new RpcError(ErrorCode.NotInitialized, 'not connected to the gateway'))
    }
    return this.#send(method, params, signal) as Promise<RequestResult<M>>
  }

  #send(method: string, params: unknown, signal?: AbortSignal): Promise<unknown> {
    const socket = this.#socket
    if (socket === null || socket.readyState !== OPEN) {
      return Promise.reject(new RpcError(ErrorCode.NotInitialized, 'not connected to the gateway'))
    }
    if (signal?.aborted === true) return Promise.reject(signal.reason ?? new Error('aborted'))
    const id = this.#nextId++
    return new Promise((resolve, reject) => {
      const timeoutMs = this.#options.callTimeoutMs ?? 60_000
      const timer = timeoutMs > 0 ? setTimeout(() => {
        this.#pending.get(id)?.reject(new RpcError(ErrorCode.InternalError, `${method} timed out`))
      }, timeoutMs) : undefined
      const onAbort = () => {
        if (!this.#pending.has(id)) return
        this.#write({ jsonrpc: '2.0', method: '$/cancelRequest', params: { id } })
        this.#pending.get(id)?.reject(signal?.reason instanceof Error ? signal.reason : new Error('aborted'))
      }
      signal?.addEventListener('abort', onAbort, { once: true })
      const cleanup = () => {
        clearTimeout(timer)
        signal?.removeEventListener('abort', onAbort)
        this.#pending.delete(id)
      }
      this.#pending.set(id, {
        resolve: value => { cleanup(); resolve(value) },
        reject: error => { cleanup(); reject(error) },
        cleanup,
      })
      this.#write({ jsonrpc: '2.0', id, method, params })
    })
  }

  #write(frame: unknown): void {
    if (this.#socket?.readyState === OPEN) this.#socket.send(JSON.stringify(frame))
  }

  #connect(): void {
    const previous = this.status.get()
    this.status.set({ state: previous.attempt === 0 ? 'connecting' : 'reconnecting', attempt: previous.attempt, ...(previous.error === undefined ? {} : { error: previous.error }) })
    let socket: SocketLike
    try {
      socket = (this.#options.createSocket ?? (url => new WebSocket(url) as unknown as SocketLike))(this.#options.url)
    } catch (error) {
      this.#scheduleRetry(error instanceof Error ? error.message : String(error))
      return
    }
    this.#socket = socket
    socket.addEventListener('open', () => {
      if (this.#socket !== socket) return
      void this.#initialize(socket)
    })
    socket.addEventListener('message', event => {
      if (this.#socket === socket) this.#receive(String(event.data))
    })
    socket.addEventListener('close', event => {
      if (this.#socket !== socket) return
      this.#socket = null
      this.#teardown('connection lost')
      const reason = typeof event.reason === 'string' && event.reason !== '' ? event.reason : `closed (${event.code ?? '?'})`
      this.#scheduleRetry(reason)
    })
    socket.addEventListener('error', () => {
      // `close` always follows; it owns the retry.
    })
  }

  async #initialize(socket: SocketLike): Promise<void> {
    try {
      const result = await this.#send('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        client: this.#options.clientInfo,
      }) as InitializeResult
      if (this.#socket !== socket) return
      this.#ready = true
      this.#generation += 1
      this.server.set(result)
      this.status.set({ state: 'open', attempt: 0 })
      for (const handler of [...this.#readyHandlers]) handler(this.#generation)
    } catch (error) {
      socket.close(4000, error instanceof Error ? error.message : 'initialize failed')
    }
  }

  #receive(text: string): void {
    let message: any
    try {
      message = JSON.parse(text)
    } catch {
      return
    }
    const kind = classify(message)
    if (kind === 'response') {
      const pending = this.#pending.get(message.id)
      if (pending === undefined) return
      if ('error' in message) pending.reject(new RpcError(message.error.code, message.error.message, message.error.data))
      else pending.resolve(message.result)
    } else if (kind === 'notification') {
      for (const handler of [...(this.#handlers.get(message.method) ?? [])]) {
        try {
          handler(message.params)
        } catch (error) {
          console.error(`notification handler for ${message.method} failed`, error)
        }
      }
    }
  }

  #teardown(reason: string): void {
    this.#ready = false
    for (const pending of [...this.#pending.values()]) pending.reject(new RpcError(ErrorCode.InternalError, reason))
    this.#pending.clear()
  }

  #scheduleRetry(error: string): void {
    if (this.status.get().state === 'stopped') return
    const attempt = this.status.get().attempt + 1
    const { initial, max } = this.#options.backoffMs ?? { initial: 500, max: 10_000 }
    const delay = Math.min(max, initial * 2 ** Math.min(attempt - 1, 10)) * (0.8 + Math.random() * 0.4)
    this.status.set({ state: 'reconnecting', attempt, error })
    this.#retryTimer = setTimeout(() => this.#connect(), delay)
  }
}
