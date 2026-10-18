/** Capability registry: the "assembly" seam of the gateway. */
import type { Capability } from '@adg/protocol'
import type { Peer } from './peer.ts'

/** Per-call facts handed to a method handler. */
export interface MethodContext {
  /** The connection that sent the request. */
  readonly peer: Peer
  /** Aborted when the client cancels the request or disconnects. */
  readonly signal: AbortSignal
  /** Run `task` after this request's response has been written. */
  afterResponse(task: () => void): void
}

export type MethodHandler = (params: unknown, call: MethodContext) => unknown

/** One capability contributed by the gateway or by another Cordis plugin. */
export interface CapabilityRegistration {
  readonly id: string
  readonly version: number
  /** Method name → handler. Names must be unique across all capabilities. */
  readonly methods: Readonly<Record<string, MethodHandler>>
}

interface MethodEntry {
  readonly capability: string
  readonly handler: MethodHandler
}

export class CapabilityRegistry {
  private readonly capabilities = new Map<string, CapabilityRegistration>()
  private readonly methods = new Map<string, MethodEntry>()

  /**
   * Add a capability and its methods.
   * @returns a disposer removing exactly this registration.
   * @throws when the capability id or a method name is already registered.
   */
  register(registration: CapabilityRegistration): () => void {
    if (this.capabilities.has(registration.id)) {
      throw new Error(`adg-gateway: capability "${registration.id}" is already registered`)
    }
    for (const method of Object.keys(registration.methods)) {
      if (this.methods.has(method)) throw new Error(`adg-gateway: method "${method}" is already registered`)
    }
    this.capabilities.set(registration.id, registration)
    for (const [method, handler] of Object.entries(registration.methods)) {
      this.methods.set(method, { capability: registration.id, handler })
    }
    return () => {
      if (this.capabilities.get(registration.id) !== registration) return
      this.capabilities.delete(registration.id)
      for (const method of Object.keys(registration.methods)) this.methods.delete(method)
    }
  }

  method(name: string): MethodEntry | undefined {
    return this.methods.get(name)
  }

  list(): Capability[] {
    return [...this.capabilities.values()].map(({ id, version }) => ({ id, version }))
  }
}
