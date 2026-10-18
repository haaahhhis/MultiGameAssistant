/** One connected client: JSON-RPC framing, dispatch, cancellation, subscriptions. */
import type { ZodType } from 'zod'
import {
  classify, ErrorCode, Requests, RpcError,
  type JsonRpcId, type NotificationMethod, type NotificationParams,
} from '@adg/protocol'
import type { CapabilityRegistry, MethodContext } from './registry.ts'

/** Minimal socket surface, so tests can drive a peer without a real WebSocket. */
export interface PeerSocket {
  send(text: string): void
  close(code?: number, reason?: string): void
}

export interface PeerOptions {
  readonly registry: CapabilityRegistry
  /** Validate handler results against protocol schemas (development aid). */
  readonly validateResults: boolean
  readonly log: { warn(message: string): void }
  /** Called once after `initialize` succeeds. */
  readonly onInitialized: (peer: Peer) => void
}

/** Client → gateway notification that aborts an in-flight request. */
export const CANCEL_REQUEST = '$/cancelRequest'

let nextPeerId = 0

export class Peer {
  readonly id = `peer-${++nextPeerId}`
  private initialized = false
  private closed = false
  private readonly inflight = new Map<JsonRpcId, AbortController>()
  private readonly subscriptions = new Map<string, AbortController>()
  private readonly socket: PeerSocket
  private readonly options: PeerOptions

  constructor(socket: PeerSocket, options: PeerOptions) {
    this.socket = socket
    this.options = options
  }

  get isInitialized(): boolean {
    return this.initialized && !this.closed
  }

  /** Handle one text frame from the socket. */
  receive(text: string): void {
    let message: unknown
    try {
      message = JSON.parse(text)
    } catch {
      this.write({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.ParseError, message: 'invalid JSON' } })
      return
    }
    switch (classify(message)) {
      case 'request': {
        const { id, method, params } = message as { id: JsonRpcId; method: string; params?: unknown }
        void this.dispatch(id, method, params)
        return
      }
      case 'notification': {
        const { method, params } = message as { method: string; params?: unknown }
        if (method === CANCEL_REQUEST && typeof params === 'object' && params !== null) {
          this.inflight.get((params as { id: JsonRpcId }).id)?.abort(new Error('cancelled by client'))
        }
        return
      }
      case 'response':
        return // the gateway sends no requests to clients in v1
      default:
        this.write({ jsonrpc: '2.0', id: null, error: { code: ErrorCode.InvalidRequest, message: 'not a JSON-RPC 2.0 frame' } })
    }
  }

  notify<M extends NotificationMethod>(method: M, params: NotificationParams<M>): void {
    if (this.isInitialized) this.write({ jsonrpc: '2.0', method, params })
  }

  /**
   * Track a long-lived server push owned by this peer.
   * @returns the subscription id and the signal that stops it.
   */
  openSubscription(prefix: string): { id: string; signal: AbortSignal } {
    const id = `${prefix}-${crypto.randomUUID()}`
    const controller = new AbortController()
    this.subscriptions.set(id, controller)
    return { id, signal: controller.signal }
  }

  closeSubscription(id: string, reason = 'closed'): boolean {
    const controller = this.subscriptions.get(id)
    if (controller === undefined) return false
    this.subscriptions.delete(id)
    controller.abort(new Error(reason))
    return true
  }

  /** Mark a subscription finished from the server side. */
  forgetSubscription(id: string): void {
    this.subscriptions.delete(id)
  }

  close(): void {
    if (this.closed) return
    this.closed = true
    for (const controller of this.inflight.values()) controller.abort(new Error('connection closed'))
    for (const controller of this.subscriptions.values()) controller.abort(new Error('connection closed'))
    this.inflight.clear()
    this.subscriptions.clear()
  }

  private async dispatch(id: JsonRpcId, method: string, params: unknown): Promise<void> {
    const controller = new AbortController()
    this.inflight.set(id, controller)
    const after: (() => void)[] = []
    try {
      const result = await this.invoke(method, params, {
        peer: this,
        signal: controller.signal,
        afterResponse: task => { after.push(task) },
      })
      this.write({ jsonrpc: '2.0', id, result: result ?? {} })
      if (method === 'initialize') {
        this.initialized = true
        this.options.onInitialized(this)
      }
      for (const task of after) task()
    } catch (error) {
      this.write({ jsonrpc: '2.0', id, error: toRpcError(error).toJSON() })
    } finally {
      this.inflight.delete(id)
    }
  }

  private async invoke(method: string, params: unknown, call: MethodContext): Promise<unknown> {
    if (method !== 'initialize' && !this.initialized) {
      throw new RpcError(ErrorCode.NotInitialized, 'call initialize first')
    }
    const entry = this.options.registry.method(method)
    if (entry === undefined) throw new RpcError(ErrorCode.MethodNotFound, `unknown method ${method}`)
    // Protocol methods validate here; plugin-contributed methods validate themselves.
    const spec = (Requests as Readonly<Record<string, { params: ZodType; result: ZodType }>>)[method]
    let input: unknown = params ?? {}
    if (spec !== undefined) {
      const parsed = spec.params.safeParse(input)
      if (!parsed.success) throw new RpcError(ErrorCode.InvalidParams, parsed.error.message)
      input = parsed.data
    }
    const result = await entry.handler(input, call)
    if (spec !== undefined && this.options.validateResults) {
      const checked = spec.result.safeParse(result)
      if (!checked.success) this.options.log.warn(`adg-gateway: ${method} result violates protocol: ${checked.error.message}`)
    }
    return result
  }

  private write(frame: unknown): void {
    if (this.closed) return
    try {
      this.socket.send(JSON.stringify(frame))
    } catch (error) {
      this.options.log.warn(`adg-gateway: send failed on ${this.id}: ${String(error)}`)
    }
  }
}

/** Map any thrown value to a JSON-RPC error; upstream `RemoteError` codes ride in `data.code`. */
export function toRpcError(error: unknown): RpcError {
  if (error instanceof RpcError) return error
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code
    const details = (error as { details?: unknown }).details
    return typeof code === 'string'
      ? new RpcError(ErrorCode.HostError, error.message, { code, ...(details === undefined ? {} : { details }) })
      : new RpcError(ErrorCode.InternalError, error.message)
  }
  return new RpcError(ErrorCode.InternalError, String(error))
}
