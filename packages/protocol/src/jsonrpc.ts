/** JSON-RPC 2.0 envelopes shared by every transport. */

export type JsonRpcId = number | string

export interface JsonRpcRequest {
  readonly jsonrpc: '2.0'
  readonly id: JsonRpcId
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcNotification {
  readonly jsonrpc: '2.0'
  readonly method: string
  readonly params?: unknown
}

export interface JsonRpcErrorObject {
  readonly code: number
  readonly message: string
  readonly data?: unknown
}

export type JsonRpcResponse =
  | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId; readonly result: unknown }
  | { readonly jsonrpc: '2.0'; readonly id: JsonRpcId | null; readonly error: JsonRpcErrorObject }

export type JsonRpcMessage = JsonRpcRequest | JsonRpcNotification | JsonRpcResponse

/** Error carrying a JSON-RPC code across the transport. */
export class RpcError extends Error {
  readonly code: number
  readonly data: unknown

  constructor(code: number, message: string, data?: unknown) {
    super(message)
    this.name = 'RpcError'
    this.code = code
    this.data = data
  }

  toJSON(): JsonRpcErrorObject {
    return this.data === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, data: this.data }
  }
}

/**
 * Classify one parsed frame.
 * @param value - any JSON value received on the wire.
 * @returns the message kind, or `invalid` when it is not a JSON-RPC 2.0 frame.
 */
export function classify(value: unknown): 'request' | 'notification' | 'response' | 'invalid' {
  if (typeof value !== 'object' || value === null || (value as { jsonrpc?: unknown }).jsonrpc !== '2.0') return 'invalid'
  const frame = value as Record<string, unknown>
  if (typeof frame.method === 'string') return 'id' in frame ? 'request' : 'notification'
  if ('result' in frame || 'error' in frame) return 'response'
  return 'invalid'
}
