/**
 * @adg/client-core — framework-free client for the adg protocol.
 *
 * Connection, session sync, and view models live here so any UI shell
 * (React, Vue, a TUI, an IDE panel) only renders.
 */
export { Store, type Listener } from './store.ts'
export { RpcConnection, type ConnectionState, type ConnectionStatus, type RpcConnectionOptions, type SocketLike } from './rpc.ts'
export { SessionHandle, computeRunning, type PendingPrompt, type SessionState, type SessionTransport } from './session.ts'
export { AdgClient, type SessionsState, type AdgClientOptions } from './client.ts'
export { buildChat, type ChatItem, type ToolStatus } from './chat.ts'
