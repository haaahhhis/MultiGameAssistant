/**
 * Built-in capabilities over the upstream Session Controller.
 *
 * Typed against the real `SessionController` so an upstream signature change
 * fails `pnpm typecheck` here instead of surfacing as a runtime bug in a UI.
 */
import type {
  SessionController, SessionFollowFrame, SessionRequestId, SessionSummary,
} from '@deepseek-ai/dsh-api-session-controller'
import {
  ErrorCode, RpcError,
  type ModelCatalog, type ModelSelection, type SessionModel, type NotificationMethod, type NotificationParams, type RequestMethod, type RequestParams,
  type QueuedPrompt, type RequestResult, type SessionItem,
} from '@adg/protocol'
import { convertLiveBaseline, convertLiveFrame, convertRecord, convertRecords } from './convert.ts'
import type { CapabilityRegistration, MethodContext } from './registry.ts'

export type HostSessions = Pick<SessionController,
  'list' | 'create' | 'rename' | 'follow' | 'page' | 'prompt' | 'cancel' | 'updateQueue' | 'modelCatalog' | 'selectModel' | 'projections'>

/** Protocol method → handler, typed by the method's params and result schemas. */
type ProtocolHandlers = {
  readonly [M in RequestMethod]?: (params: RequestParams<M>, call: MethodContext) => RequestResult<M> | Promise<RequestResult<M>>
}

function handlers(map: ProtocolHandlers): CapabilityRegistration['methods'] {
  return map as CapabilityRegistration['methods']
}

type SessionId = SessionSummary['sessionId']

/** Brand casts at the protocol boundary: protocol ids are plain strings. */
const sid = (id: string) => id as SessionId

/**
 * The people's messages still waiting in dsh's `inbox` projection, in the
 * order they will run: `next-step` ones go into the running turn first.
 * Other inbox entries (a subagent's report, a reminder) are not shown.
 */
export function toQueue(inbox: unknown): QueuedPrompt[] {
  const items: QueuedPrompt[] = []
  for (const placement of ['next-step', 'next-turn'] as const) {
    const list = (inbox as Record<string, unknown> | undefined)?.[placement]
    if (!Array.isArray(list)) continue
    for (const message of list as { id?: unknown; source?: { kind?: unknown; rpcId?: unknown }; content?: unknown }[]) {
      if (typeof message.id !== 'string' || message.source?.kind !== 'user') continue
      const content = Array.isArray(message.content) ? message.content as { type?: unknown; text?: unknown }[] : []
      const text = content.filter(c => c.type === 'text' && typeof c.text === 'string').map(c => c.text as string).join('\n')
      const images = content.filter(c => c.type === 'image').length
      items.push({
        id: message.id,
        ...(typeof message.source.rpcId === 'string' ? { requestId: message.source.rpcId } : {}),
        text,
        ...(images === 0 ? {} : { images }),
        placement,
      })
    }
  }
  return items
}

function titleOf(values: unknown): string | null {
  const title = (values as { title?: unknown } | undefined)?.title
  return typeof title === 'string' ? title : null
}

function toSelection(value: unknown): ModelSelection | null {
  if (typeof value !== 'object' || value === null) return null
  const { provider, model, reasoningEffort } = value as Record<string, unknown>
  if (typeof provider !== 'string' || typeof model !== 'string') return null
  return { provider, model, ...(typeof reasoningEffort === 'string' ? { reasoningEffort } : {}) }
}

/** The `modelSelection` projection value in protocol shape. */
export function toSessionModel(value: unknown): SessionModel {
  const v = (value ?? {}) as { lastUsed?: unknown; next?: unknown }
  return { lastUsed: toSelection(v.lastUsed), next: toSelection(v.next) }
}

export function toSessionItem(summary: SessionSummary): SessionItem {
  return {
    id: summary.sessionId,
    title: titleOf(summary.projections?.values),
    updatedAt: summary.updatedAt,
    running: summary.running,
    blank: summary.blank,
    live: summary.agentAvailable,
    ...(summary.cwd === undefined ? {} : { cwd: summary.cwd }),
    ...(summary.parentSessionId === undefined ? {} : { parentId: summary.parentSessionId }),
    ...(summary.origin === undefined ? {} : { origin: summary.origin }),
  }
}

export interface BuiltinDeps {
  readonly sessions: HostSessions
  readonly approvals: {
    respond(approvalId: string, decision: 'allow-once' | 'reject'): boolean
  }
  readonly serverInfo: { readonly name: string; readonly version: string; readonly dsh?: string }
  readonly capabilities: () => RequestResult<'initialize'>['capabilities']
  readonly notify: <M extends NotificationMethod>(call: MethodContext, method: M, params: NotificationParams<M>) => void
  /** Working folder for sessions created without one. */
  readonly workspaceDir?: string
  /** 「压缩对话」 (compact.ts). Absent: session/compact fails. */
  readonly compact?: (sessionId: string, signal: AbortSignal) => Promise<{ compacted: boolean; message: string }>
}

const DEFAULT_OPEN_MESSAGES = 60

export function builtinCapabilities(deps: BuiltinDeps): CapabilityRegistration[] {
  const { sessions } = deps

  const core: CapabilityRegistration = {
    id: '$core',
    version: 1,
    methods: handlers({
      'initialize': (params: RequestParams<'initialize'>) => {
        if (params.protocolVersion !== 1) {
          throw new RpcError(ErrorCode.InvalidRequest, `unsupported protocol version ${params.protocolVersion}; server speaks 1`)
        }
        return { protocolVersion: 1, server: deps.serverInfo, capabilities: deps.capabilities() }
      },
    }),
  }

  const sessionCapability: CapabilityRegistration = {
    id: 'sessions',
    version: 1,
    methods: handlers({
      'sessions/list': async (_params: RequestParams<'sessions/list'>, call: MethodContext) => {
        const value = await sessions.list({}, call.signal)
        return { items: value.items.map(toSessionItem) }
      },
      'sessions/create': async (params: RequestParams<'sessions/create'>) => {
        const cwd = params.cwd ?? deps.workspaceDir
        const created = await sessions.create(cwd === undefined ? {} : { cwd })
        return { sessionId: created.sessionId }
      },
      'sessions/rename': async (params: RequestParams<'sessions/rename'>) => {
        const renamed = await sessions.rename({ sessionId: sid(params.sessionId), title: params.title })
        return { title: renamed.title }
      },
      'session/open': async (params: RequestParams<'session/open'>, call: MethodContext) => {
        const subscription = call.peer.openSubscription('sub')
        // The follow stream outlives this request: it stops on session/close or disconnect.
        const iterator = sessions.follow({
          address: { kind: 'session', sessionId: sid(params.sessionId) },
          assistantStream: true,
          maxMessages: params.maxMessages ?? DEFAULT_OPEN_MESSAGES,
        }, subscription.signal)[Symbol.asyncIterator]()
        let first: IteratorResult<SessionFollowFrame>
        try {
          first = await iterator.next()
        } catch (error) {
          call.peer.forgetSubscription(subscription.id)
          throw error
        }
        if (first.done === true || first.value.type !== 'snapshot') {
          call.peer.closeSubscription(subscription.id)
          throw new RpcError(ErrorCode.InternalError, 'session follow did not open with a snapshot')
        }
        const snapshot = first.value
        call.afterResponse(() => {
          void pump(iterator, subscription.id, call)
        })
        return {
          subscriptionId: subscription.id,
          header: {
            id: snapshot.header.id,
            createdAt: snapshot.header.createdAt,
            ...(snapshot.header.cwd === undefined ? {} : { cwd: snapshot.header.cwd }),
            ...(snapshot.header.parentSession === undefined ? {} : { parentId: snapshot.header.parentSession }),
            ...(snapshot.header.agentPreset === undefined ? {} : { agentPreset: snapshot.header.agentPreset }),
          },
          cursor: snapshot.cursor,
          events: convertRecords(snapshot.records),
          hasMore: snapshot.hasMore,
          title: titleOf(snapshot.projections.values),
          live: convertLiveBaseline(snapshot.assistantStream),
          queue: toQueue((snapshot.projections.values as { inbox?: unknown }).inbox),
        }
      },
      'session/close': (params: RequestParams<'session/close'>, call: MethodContext) => {
        call.peer.closeSubscription(params.subscriptionId)
        return {}
      },
      'session/history': async (params: RequestParams<'session/history'>, call: MethodContext) => {
        const page = await sessions.page({
          address: { kind: 'session', sessionId: sid(params.sessionId) },
          throughSeq: params.throughSeq,
          beforeSeq: params.beforeSeq,
          maxMessages: params.maxMessages ?? DEFAULT_OPEN_MESSAGES,
        }, call.signal)
        return { events: convertRecords(page.records), hasMore: page.hasMore }
      },
    }),
  }

  async function pump(iterator: AsyncIterator<SessionFollowFrame>, subscriptionId: string, call: MethodContext): Promise<void> {
    let reason = 'ended'
    try {
      for (;;) {
        const next = await iterator.next()
        if (next.done === true) break
        const frame = next.value
        if (frame.type === 'event') {
          const event = convertRecord(frame)
          if (event !== null) deps.notify(call, 'session/event', { subscriptionId, event })
        } else if (frame.type === 'assistant-stream') {
          const live = convertLiveFrame(frame.frame)
          if (live !== null) deps.notify(call, 'session/live', { subscriptionId, frame: live })
        }
      }
    } catch (error) {
      reason = error instanceof Error ? error.message : String(error)
    } finally {
      call.peer.forgetSubscription(subscriptionId)
      deps.notify(call, 'session/closed', { subscriptionId, reason })
    }
  }

  const chat: CapabilityRegistration = {
    id: 'chat',
    version: 1,
    methods: handlers({
      'session/prompt': async (params: RequestParams<'session/prompt'>, call: MethodContext) => {
        await sessions.prompt({
          requestId: params.requestId as SessionRequestId,
          sessionId: sid(params.sessionId),
          mode: params.mode,
          content: [...(params.text.trim() === '' ? [] : [{ type: 'text' as const, text: params.text }]), ...(params.images ?? []).map(i => ({ type: 'image' as const, mediaType: i.mediaType, data: i.data, ...(i.name === undefined ? {} : { name: i.name }) }))],
          clientTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
        }, call.signal)
        return { accepted: true as const }
      },
      'session/cancel': (params: RequestParams<'session/cancel'>) => {
        sessions.cancel({ sessionId: sid(params.sessionId) })
        return { accepted: true as const }
      },
      'session/compact': async (params: RequestParams<'session/compact'>, call: MethodContext) => {
        if (deps.compact === undefined) throw new Error('这里不能压缩对话')
        return deps.compact(params.sessionId, call.signal)
      },
      'session/queue/update': async (params: RequestParams<'session/queue/update'>) => {
        await sessions.updateQueue({ sessionId: sid(params.sessionId), itemId: params.itemId as never, action: { kind: params.action } })
        return { accepted: true as const }
      },
    }),
  }

  const models: CapabilityRegistration = {
    id: 'models',
    version: 1,
    methods: handlers({
      'models/catalog': async (): Promise<ModelCatalog> => {
        const catalog = await sessions.modelCatalog()
        return {
          default: {
            provider: catalog.default.provider,
            model: catalog.default.model,
            ...(catalog.default.reasoningEffort === undefined ? {} : { reasoningEffort: catalog.default.reasoningEffort }),
          },
          groups: catalog.groups.map(group => ({
            id: group.id,
            name: group.name,
            models: group.models.map(model => ({
              id: model.id,
              name: model.name,
              ...(model.description === undefined ? {} : { description: model.description }),
              efforts: (model.reasoning?.efforts ?? []).map(e => ({ id: e.id, name: e.name })),
              ...(model.reasoning?.defaultEffort === undefined ? {} : { defaultEffort: model.reasoning.defaultEffort }),
            })),
          })),
          failures: catalog.failures.map(f => ({ id: f.id, name: f.name, message: f.message })),
        }
      },
      'session/selectModel': async (params: RequestParams<'session/selectModel'>) => {
        const value = await sessions.selectModel({
          sessionId: sid(params.sessionId),
          provider: params.provider,
          model: params.model,
          ...(params.reasoningEffort === undefined ? {} : { reasoningEffort: params.reasoningEffort }),
        })
        return {
          selected: {
            provider: value.selected.provider,
            model: value.selected.model,
            ...(value.selected.reasoningEffort === undefined ? {} : { reasoningEffort: value.selected.reasoningEffort }),
          },
        }
      },
      'session/model': async (params: RequestParams<'session/model'>, call: MethodContext) => {
        const value = await sessions.projections({ sessionId: sid(params.sessionId) }, call.signal)
        if (value === null) throw new RpcError(ErrorCode.NotFound, `no session ${params.sessionId}`)
        return toSessionModel(value.values.modelSelection)
      },
    }),
  }

  const approval: CapabilityRegistration = {
    id: 'approval',
    version: 1,
    methods: handlers({
      'approval/respond': (params: RequestParams<'approval/respond'>) => {
        if (!deps.approvals.respond(params.approvalId, params.decision)) {
          throw new RpcError(ErrorCode.NotFound, `no pending approval ${params.approvalId}`)
        }
        return {}
      },
    }),
  }

  return [core, sessionCapability, chat, models, approval]
}
