/**
 * Approval broker: answers upstream `approval/request` waterfalls through
 * connected protocol clients.
 *
 * The broker claims a request only while at least one initialized client is
 * connected; otherwise the gateway delegates with `next()` so other answerers
 * (the official Web UI, policy hooks) keep working. Pending requests are
 * replayed to clients that connect later, and withdrawn when the agent aborts.
 */
import type { ApprovalRequested } from '@adg/protocol'

/** Upstream approval outcomes (`@deepseek-ai/dsh-user-approval`). */
export type ApprovalOutcome = 'allowed-once' | 'rejected' | 'cancelled' | 'unavailable'

export interface ApprovalAsk {
  readonly sessionId: string
  readonly toolName: string
  readonly callId?: string
  readonly reason?: string
  readonly displayReason?: Readonly<Record<string, string>>
  readonly signal?: AbortSignal
}

interface Pending {
  readonly request: ApprovalRequested
  readonly settle: (outcome: ApprovalOutcome) => void
}

export interface ApprovalBrokerOptions {
  readonly broadcastRequested: (request: ApprovalRequested) => void
  readonly broadcastResolved: (approvalId: string, outcome: ApprovalOutcome) => void
}

export class ApprovalBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly options: ApprovalBrokerOptions

  constructor(options: ApprovalBrokerOptions) {
    this.options = options
  }

  /** Put one question to the connected clients and wait for the first answer. */
  ask(ask: ApprovalAsk): Promise<ApprovalOutcome> {
    if (ask.signal?.aborted === true) return Promise.resolve('cancelled')
    const approvalId = crypto.randomUUID()
    const request: ApprovalRequested = {
      approvalId,
      sessionId: ask.sessionId,
      toolName: ask.toolName,
      ...(ask.callId === undefined ? {} : { callId: ask.callId }),
      ...(ask.reason === undefined ? {} : { reason: ask.reason }),
      ...(ask.displayReason === undefined ? {} : { displayReason: { ...ask.displayReason } }),
    }
    return new Promise<ApprovalOutcome>(resolve => {
      const onAbort = () => this.settle(approvalId, 'cancelled')
      this.pending.set(approvalId, {
        request,
        settle: outcome => {
          ask.signal?.removeEventListener('abort', onAbort)
          resolve(outcome)
        },
      })
      ask.signal?.addEventListener('abort', onAbort, { once: true })
      this.options.broadcastRequested(request)
    })
  }

  /** Apply a client's decision. @returns false when the request is unknown or already settled. */
  respond(approvalId: string, decision: 'allow-once' | 'reject'): boolean {
    return this.settle(approvalId, decision === 'allow-once' ? 'allowed-once' : 'rejected')
  }

  /** Requests still waiting, for replay to a newly connected client. */
  open(): readonly ApprovalRequested[] {
    return [...this.pending.values()].map(p => p.request)
  }

  /** Fail every pending request closed (gateway unloading). */
  dispose(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, 'unavailable')
  }

  private settle(approvalId: string, outcome: ApprovalOutcome): boolean {
    const entry = this.pending.get(approvalId)
    if (entry === undefined) return false
    this.pending.delete(approvalId)
    entry.settle(outcome)
    this.options.broadcastResolved(approvalId, outcome)
    return true
  }
}
