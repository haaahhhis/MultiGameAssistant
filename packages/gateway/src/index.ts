/**
 * @adg/gateway — Cordis host plugin serving the custom UI protocol.
 *
 * Mounted by `@adg/bundle` next to the upstream host services. It is
 * the only code that touches dsh internals: it calls `ctx.sessionController`,
 * answers the `approval/request` waterfall, forwards `api-session/*` list
 * events, and exposes everything as protocol v1 over one WebSocket.
 *
 * Other plugins extend the protocol with `ctx.adgGateway.register()`; the
 * registration is an effect on the caller's fiber, so unloading that plugin
 * removes its capability and methods.
 */
import { randomBytes } from 'node:crypto'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-api-settings-controller'
import type {} from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import { credentialsCapability } from './credentials.ts'
import { providersCapability } from './providers.ts'
import type { NotificationMethod, NotificationParams, RequestParams } from '@adg/protocol'
import { ApprovalBroker, type ApprovalAnswerer } from './approvals.ts'
import { builtinCapabilities, toSessionItem, toSessionModel } from './builtin.ts'
import { Peer } from './peer.ts'
import { CapabilityRegistry, type CapabilityRegistration } from './registry.ts'
import { startServer } from './server.ts'

export type { CapabilityRegistration, MethodContext, MethodHandler } from './registry.ts'
export type { ApprovalAnswerer, ApprovalOutcome } from './approvals.ts'
export { convertRecord } from './convert.ts'
export { convertEvent, convertLiveFrame, streamFacts } from './convert.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Custom UI protocol gateway and its capability registry. */
    adgGateway: AdgGateway
  }
}

export interface Config {
  /** Listen address; loopback by default. */
  readonly host?: string
  /** Listen port; 0 picks a free port. @default 3290 */
  readonly port?: number
  /** Connection token; a random one is generated (and printed) when omitted. */
  readonly token?: string
  /** Built UI directory to serve at `/`. */
  readonly staticDir?: string
  /** Extra `host[:port]` authorities accepted beyond loopback. */
  readonly trustedHosts?: readonly string[]
  /** Log protocol violations in handler results. @default false */
  readonly validateResults?: boolean
  /** Settings namespace (Loader entry id) of the pi-ai adapter that serves custom providers. @default 'llm-pi-ai' */
  readonly providersNamespace?: string
  /** Settings namespace of the default-model entry. @default 'agent-default-model' */
  readonly defaultModelNamespace?: string
}

export class AdgGateway extends Service {
  static inject = ['sessionController']

  private readonly registry = new CapabilityRegistry()
  private readonly peers = new Set<Peer>()
  private readonly approvals: ApprovalBroker
  /** Resolved after the listener binds. */
  url: string | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'adgGateway')
    const log = ctx.logger('adg-gateway')
    const token = config.token ?? randomBytes(18).toString('base64url')

    this.approvals = new ApprovalBroker({
      broadcastRequested: request => this.broadcast('approval/requested', request),
      broadcastResolved: (approvalId, outcome) => this.broadcast('approval/resolved', { approvalId, outcome }),
    })

    for (const capability of builtinCapabilities({
      sessions: ctx.sessionController,
      approvals: this.approvals,
      serverInfo: { name: 'adg-gateway', version: '0.1.0' },
      capabilities: () => this.registry.list().filter(c => !c.id.startsWith('$')),
      notify: (call, method, params) => call.peer.notify(method, params),
    })) {
      ctx.effect(() => this.registry.register(capability), `adg-gateway capability ${capability.id}`)
    }

    // Claim approvals only while a protocol client or a chat channel can answer them. Prepended:
    // dsh's own remote bridge (dsh-api-remotes) holds a request for its browser
    // client even when none is attached, so answerers after it never run.
    ctx.on('approval/request', (request, next) => {
      if (!this.hasClients() && !this.approvals.hasActiveAnswerer()) return next()
      return this.approvals.ask({
        sessionId: request.agent.session.id,
        toolName: request.toolName,
        ...(request.callId === undefined ? {} : { callId: request.callId }),
        ...(request.reason === undefined ? {} : { reason: request.reason }),
        ...(request.displayReason === undefined ? {} : { displayReason: request.displayReason }),
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    }, true)
    ctx.effect(() => () => this.approvals.dispose(), 'adg-gateway approvals')

    // Optional capability: present exactly while the host mounts a credentials controller.
    ctx.inject(['credentialsController'], scoped => {
      scoped.effect(() => this.registry.register(credentialsCapability(scoped.credentialsController)), 'adg-gateway capability credentials')
      scoped.on('credentials/reference-updated', ref => this.broadcast('credentials/changed', { ref }))
    })

    // Optional capability: custom provider routes need both the settings forms and the LLM registry.
    ctx.inject(['settings', 'llm'], scoped => {
      let queued = false
      const providersChanged = () => {
        if (queued) return
        queued = true
        queueMicrotask(() => {
          queued = false
          this.broadcast('providers/changed', {})
        })
      }
      scoped.effect(() => this.registry.register(providersCapability({
        settings: scoped.settings,
        llm: scoped.llm,
        credentials: () => scoped.get('credentialsController'),
        namespace: config.providersNamespace ?? 'llm-pi-ai',
        changed: providersChanged,
        defaultModel: () => {
          const service = scoped.get('agentDefaultModel')
          if (service === undefined) return undefined
          return {
            provider: service.currentSelection().provider,
            reset: () => scoped.settings.replace(config.defaultModelNamespace ?? 'agent-default-model', {}),
          }
        },
      })), 'adg-gateway capability providers')
      // Routes registered or dropped from anywhere: this UI, dsh's own page, or a hand-edited profile.
      scoped.on('llm/adapters-updated', providersChanged)
    })

    // Optional capability: choosing the default model needs the default-model service.
    ctx.inject(['agentDefaultModel'], scoped => {
      scoped.effect(() => this.registry.register({
        id: 'model-default',
        version: 1,
        methods: {
          'models/setDefault': async params => {
            const p = params as RequestParams<'models/setDefault'>
            await scoped.agentDefaultModel.saveSelection({ provider: p.provider, model: p.model, ...(p.reasoningEffort === undefined ? {} : { reasoningEffort: p.reasoningEffort }) } as never)
            this.broadcast('providers/changed', {})
            return {}
          },
        },
      }), 'adg-gateway capability model-default')
    })

    // Session list deltas come from the controller's own lifecycle events.
    ctx.on('api-session/added', summary => {
      this.broadcast('sessions/changed', { kind: 'upsert', item: toSessionItem(summary) })
    })
    ctx.on('api-session/removed', sessionId => {
      this.broadcast('sessions/changed', { kind: 'removed', sessionId })
    })
    ctx.on('api-session/status', (sessionId, running) => {
      this.broadcast('sessions/changed', { kind: 'upsert', item: { id: sessionId, running } })
    })
    ctx.on('api-session/activity', (sessionId, updatedAt) => {
      this.broadcast('sessions/changed', { kind: 'upsert', item: { id: sessionId, updatedAt } })
    })
    ctx.on('api-session/error', (sessionId, message) => {
      this.broadcast('session/error', { sessionId, message })
    })

    // Titles change through projections, so follow the host-wide control stream.
    ctx.effect(() => {
      const controller = new AbortController()
      void this.followTitles(controller.signal, log)
      return () => controller.abort()
    }, 'adg-gateway title feed')

    ctx.effect(async () => {
      const server = await startServer({
        host: config.host ?? '127.0.0.1',
        port: config.port ?? 3290,
        token,
        ...(config.staticDir === undefined ? {} : { staticDir: config.staticDir }),
        trustedHosts: config.trustedHosts ?? [],
        onSocket: socket => {
          const peer = new Peer(socket, {
            registry: this.registry,
            validateResults: config.validateResults ?? false,
            log,
            onInitialized: ready => {
              for (const request of this.approvals.open()) ready.notify('approval/requested', request)
            },
          })
          this.peers.add(peer)
          socket.on('message', (data, isBinary) => {
            if (!isBinary) peer.receive(data.toString())
          })
          socket.on('close', () => {
            this.peers.delete(peer)
            peer.close()
          })
          socket.on('error', error => log.warn(`socket error: ${error.message}`))
        },
      })
      const host = (config.host ?? '127.0.0.1').includes(':') ? `[${config.host}]` : (config.host ?? '127.0.0.1')
      this.url = `http://${host}:${server.port}/?token=${token}`
      // stderr, like the launcher's own URL line: stdout may belong to another protocol.
      process.stderr.write(`adg gateway: ${this.url}\n`)
      log.info(`protocol endpoint: ws://${host}:${server.port}/rpc?token=${token}`)
      return async () => {
        for (const peer of this.peers) peer.close()
        this.peers.clear()
        await server.close()
      }
    }, 'adg-gateway server')
  }

  /**
   * Add a capability. The registration belongs to the calling plugin's fiber.
   * @returns a disposer that removes it early.
   */
  register(registration: CapabilityRegistration): () => void {
    let dispose: () => void = () => {}
    this.ctx.effect(() => {
      dispose = this.registry.register(registration)
      return dispose
    }, `adg-gateway capability ${registration.id}`)
    return () => dispose()
  }

  /**
   * Let another place answer approvals too (first answer wins). The
   * registration belongs to the calling plugin's fiber.
   */
  addApprovalAnswerer(answerer: ApprovalAnswerer): () => void {
    let dispose: () => void = () => {}
    this.ctx.effect(() => {
      dispose = this.approvals.addAnswerer(answerer)
      return dispose
    }, 'adg-gateway approval answerer')
    return () => dispose()
  }

  /** Answer an approval from an answerer. @returns false when it is unknown or already answered. */
  respondApproval(approvalId: string, decision: 'allow-once' | 'reject'): boolean {
    return this.approvals.respond(approvalId, decision)
  }

  /** Send one notification to every initialized client. */
  broadcast<M extends NotificationMethod>(method: M, params: NotificationParams<M>): void {
    for (const peer of this.peers) peer.notify(method, params)
  }

  private hasClients(): boolean {
    for (const peer of this.peers) if (peer.isInitialized) return true
    return false
  }

  private async followTitles(signal: AbortSignal, log: { warn(message: string): void }): Promise<void> {
    while (!signal.aborted) {
      try {
        for await (const frame of this.ctx.sessionController.control(signal)) {
          if (frame.type !== 'projection') continue
          if (frame.key === 'title') {
            const title = typeof frame.value === 'string' ? frame.value : null
            this.broadcast('session/title', { sessionId: frame.sessionId, title })
            this.broadcast('sessions/changed', { kind: 'upsert', item: { id: frame.sessionId, title } })
          } else if (frame.key === 'modelSelection') {
            this.broadcast('session/model', { sessionId: frame.sessionId, ...toSessionModel(frame.value) })
          }
        }
      } catch (error) {
        if (signal.aborted) return
        log.warn(`title feed interrupted: ${error instanceof Error ? error.message : String(error)}`)
      }
      await new Promise(resolve => setTimeout(resolve, 1000))
    }
  }
}

export default AdgGateway
