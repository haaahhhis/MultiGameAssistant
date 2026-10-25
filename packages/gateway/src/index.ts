/**
 * @adg/gateway — Cordis host plugin serving the custom UI protocol.
 *
 * Mounted by `@adg/bundle` next to the upstream host services. It is
 * the only code that touches dsh internals: it calls `ctx.sessionController`,
 * answers the `approval/request` and `user-questions/request` waterfalls, forwards `api-session/*` list
 * events, and exposes everything as protocol v1 over one WebSocket.
 *
 * Other plugins extend the protocol with `ctx.adgGateway.register()`; the
 * registration is an effect on the caller's fiber, so unloading that plugin
 * removes its capability and methods.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@deepseek-ai/dsh-api-settings-controller'
import type {} from '@deepseek-ai/dsh-credentials/types'
import type {} from '@deepseek-ai/dsh-settings'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-api-workspace-controller'
import { credentialsCapability } from './credentials.ts'
import { addRetryPolicies, providersCapability } from './providers.ts'
import type {} from '@deepseek-ai/dsh-user-questions/types'
import type { SkillSummary } from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import { ErrorCode, PERMISSIONS_CAPABILITY, PERSONA_CAPABILITY, QUESTIONS_CAPABILITY, RpcError, SKILLS_CAPABILITY, type NotificationMethod, type NotificationParams, type QuestionAnswerItem, type RequestParams, type SkillInfo } from '@adg/protocol'
import { ApprovalBroker, type ApprovalAnswerer } from './approvals.ts'
import { skillSaveTool, userSkills } from './skill-save.ts'
import { PersonaStore, personaPrompt } from './persona.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { QuestionBroker, type QuestionAnswerer } from './questions.ts'
import { builtinCapabilities, toQueue, toSessionItem, toSessionModel } from './builtin.ts'
import { Peer } from './peer.ts'
import { Permissions, PRESET } from './permissions.ts'
import { CapabilityRegistry, type CapabilityRegistration } from './registry.ts'
import { startServer } from './server.ts'

export type { CapabilityRegistration, MethodContext, MethodHandler } from './registry.ts'
export type { ApprovalAnswerer, ApprovalOutcome } from './approvals.ts'
export type { QuestionAnswerer } from './questions.ts'
export { convertRecord, convertRecords } from './convert.ts'
export { Permissions, PRESET } from './permissions.ts'
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
  /**
   * The working folder of sessions that do not name one (created if missing).
   * Kept apart from the app: dsh's Windows sandbox labels it low-integrity for good.
   */
  readonly workspaceDir?: string
  /** Where the gateway keeps its own state (the permission mode). */
  readonly dataDir?: string
  /** Where the skills the agent saves are kept (this app's data, e.g. `<data>/skills`). Absent: no `skill_save`. */
  readonly skillsDir?: string
}

/** The slice of dsh's session and permission-preset services the mode needs. */
interface PresetSession { readonly id: string }
interface PresetService {
  current(session: PresetSession): string
  set(session: PresetSession, name: string): void
}

export class AdgGateway extends Service {
  static inject = ['sessionController']

  private readonly registry = new CapabilityRegistry()
  private readonly workspace: string | undefined
  private archived = new Set<string>()
  private readonly peers = new Set<Peer>()
  private readonly approvals: ApprovalBroker
  private readonly questions: QuestionBroker
  private readonly permissions: Permissions
  private readonly permissionsReady: Promise<void>
  /** Resolved after the listener binds. */
  url: string | undefined

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'adgGateway')
    const log = ctx.logger('adg-gateway')
    this.workspace = config.workspaceDir
    const token = config.token ?? randomBytes(18).toString('base64url')

    this.approvals = new ApprovalBroker({
      broadcastRequested: request => this.broadcast('approval/requested', request),
      broadcastResolved: (approvalId, outcome) => this.broadcast('approval/resolved', { approvalId, outcome }),
    })
    this.questions = new QuestionBroker({
      broadcastRequested: request => this.broadcast('question/requested', request),
      broadcastResolved: (questionId, outcome, answers) => this.broadcast('question/resolved', { questionId, outcome, ...(answers === undefined ? {} : { answers }) }),
    })

    if (config.workspaceDir !== undefined) {
      try { mkdirSync(config.workspaceDir, { recursive: true }) } catch (error) { log.warn(`cannot create the workspace ${config.workspaceDir}: ${String(error)}`) }
    }
    for (const capability of builtinCapabilities({
      sessions: ctx.sessionController,
      ...(config.workspaceDir === undefined ? {} : { workspaceDir: config.workspaceDir }),
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
      // Full access (设置 → 权限): the user said yes to everything in advance.
      if (this.permissions.mode === 'full') {
        this.permissions.allowed({ at: Date.now(), sessionId: request.agent.session.id, toolName: request.toolName, ...(request.reason === undefined ? {} : { reason: request.reason }) })
        this.broadcast('permissions/changed', this.permissions.state())
        return Promise.resolve('allowed-once' as const)
      }
      if (!this.hasClients() && !this.approvals.hasActiveAnswerer(request.agent.session.id)) return next()
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

    // The agent's questions (dsh's ask_user_question), the same way: prepended,
    // and claimed only while someone here can answer them.
    ctx.on('user-questions/request', (request, next) => {
      const sessionId = request.agent?.session.id
      if (sessionId === undefined || (!this.hasClients() && !this.questions.hasActiveAnswerer(sessionId))) return next()
      return this.questions.ask({
        sessionId,
        ...(request.wait?.callId === undefined ? {} : { callId: request.wait.callId }),
        questions: request.questions,
        ...(request.signal === undefined ? {} : { signal: request.signal }),
      })
    }, true)
    ctx.effect(() => () => this.questions.dispose(), 'adg-gateway questions')
    ctx.effect(() => this.registry.register({
      id: QUESTIONS_CAPABILITY,
      version: 1,
      methods: {
        'question/respond': params => {
          const p = params as RequestParams<'question/respond'>
          if (!this.questions.respond(p.questionId, p.answers)) throw new RpcError(ErrorCode.NotFound, `no pending question ${p.questionId}`)
          return {}
        },
      },
    }), 'adg-gateway capability questions')

    // ── permissions: the sandbox preset of every session follows the mode ──
    this.permissions = new Permissions(config.dataDir === undefined ? undefined : join(config.dataDir, 'permissions.json'))
    const presetFor = (session: PresetSession) => {
      const presets = ctx.get('permissionPresets' as never) as PresetService | undefined
      if (presets === undefined) return
      try {
        if (presets.current(session) !== PRESET[this.permissions.mode]) presets.set(session, PRESET[this.permissions.mode])
      } catch (error) {
        log.warn(`permission preset for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const everySession = () => {
      for (const session of (ctx.get('sessions' as never) as { list(): PresetSession[] } | undefined)?.list() ?? []) presetFor(session)
    }
    this.permissionsReady = this.permissions.load().then(everySession)
    ctx.on('session/created' as never, ((session: PresetSession) => { void this.permissionsReady.then(() => presetFor(session)) }) as never)
    ctx.effect(() => this.registry.register({
      id: PERMISSIONS_CAPABILITY,
      version: 1,
      methods: {
        'permissions/get': async () => { await this.permissionsReady; return this.permissions.state() },
        'permissions/set': async params => {
          await this.permissionsReady
          await this.permissions.set((params as RequestParams<'permissions/set'>).mode)
          everySession()
          log.info(`permissions: ${this.permissions.mode}`)
          const state = this.permissions.state()
          this.broadcast('permissions/changed', state)
          return state
        },
      },
    }), 'adg-gateway capability permissions')

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
      // Routes saved before the retry policy existed get it once (see RETRY_POLICY).
      void addRetryPolicies(scoped.settings, config.providersNamespace ?? 'llm-pi-ai')
        .then(n => { if (n > 0) ctx.logger('adg-gateway').info(`added the retry policy to ${n} model route(s)`) })
        .catch(error => ctx.logger('adg-gateway').warn(`adding the retry policy failed: ${String(error)}`))
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

    // Archived sessions (dsh's workspace registry keeps the set; its own page shares it).
    ctx.inject(['workspaceController'], scoped => {
      const workspace = scoped.workspaceController
      const publish = (ids: readonly string[]) => {
        this.archived = new Set(ids)
        this.broadcast('sessions/archived', { sessionIds: [...ids] })
      }
      scoped.effect(() => {
        const controller = new AbortController()
        void (async () => {
          for (let attempt = 0; !controller.signal.aborted; attempt++) {
            try {
              for await (const frame of workspace.follow(controller.signal)) {
                if (frame.type === 'baseline') publish(frame.value.archivedSessionIds)
                else if (frame.type === 'archived') publish(frame.archivedSessionIds)
              }
            } catch { /* restarted below */ }
            await new Promise(resolve => setTimeout(resolve, Math.min(30_000, 1000 * 2 ** attempt)))
          }
        })()
        return () => controller.abort()
      }, 'adg-gateway archive follow')
      const archiveError = (error: unknown): Error => {
        const text = error instanceof Error ? error.message : String(error)
        return new Error(/session-active/.test(text) ? '这个会话还在运行（或有后台任务、定时），先停止再归档' : text)
      }
      scoped.effect(() => this.registry.register({
        id: 'archive',
        version: 1,
        methods: {
          'sessions/archived': () => ({ sessionIds: [...this.archived] }),
          'sessions/archive': async params => {
            const { sessionId } = params as RequestParams<'sessions/archive'>
            try {
              const value = await workspace.archiveSession({ sessionId: sessionId as never })
              publish(value.archivedSessionIds)
              return { sessionIds: [...value.archivedSessionIds] }
            } catch (error) { throw archiveError(error) }
          },
          'sessions/unarchive': async params => {
            const { sessionId } = params as RequestParams<'sessions/unarchive'>
            const value = await workspace.unarchiveSession({ sessionId: sessionId as never })
            publish(value.archivedSessionIds)
            return { sessionIds: [...value.archivedSessionIds] }
          },
        },
      }), 'adg-gateway capability archive')
    })

    // Images in sessions, for the UI to show (dsh keeps them by reference only).
    ctx.inject(['attachments'], scoped => {
      scoped.effect(() => this.registry.register({
        id: 'attachments',
        version: 1,
        methods: {
          'attachments/image': async params => {
            const p = params as RequestParams<'attachments/image'>
            const stored = await scoped.attachments.readImage({ attachmentId: p.attachmentId, mediaType: p.mediaType, bytes: p.bytes, width: p.width, height: p.height } as never)
            return { mediaType: stored.ref.mediaType, data: Buffer.from(stored.data).toString('base64') }
          },
        },
      }), 'adg-gateway capability attachments')
    })

    // The agent's skills, for people to look at (packs, game packs, the app's own, the user's folders).
    ctx.inject(['skills'], scoped => {
      const info = (s: SkillSummary): SkillInfo => ({
        name: s.name,
        description: s.description,
        ...(s.whenToUse === undefined ? {} : { whenToUse: s.whenToUse }),
        source: s.source,
        provider: s.provider,
        ...(s.path === undefined ? {} : { path: s.path }),
        modelInvocable: s.invocation.modelInvocable,
        userInvocable: s.invocation.userInvocable,
      })
      const options = (signal: AbortSignal) => ({ ...(this.workspace === undefined ? {} : { cwd: this.workspace }), signal })
      scoped.effect(() => this.registry.register({
        id: SKILLS_CAPABILITY,
        version: 1,
        methods: {
          'skills/list': async (_params, call) => ({ skills: (await scoped.skills.list(options(call.signal))).map(info) }),
          'skills/get': async (params, call) => {
            const { name } = params as RequestParams<'skills/get'>
            const skill = await scoped.skills.get(name, options(call.signal))
            if (skill === undefined) throw new RpcError(ErrorCode.NotFound, `no skill ${name}`)
            return { ...info(skill), content: skill.content }
          },
        },
      }), 'adg-gateway capability skills')
    })

    // The reply style (persona@1): one system-prompt section, read at every assembly, so a change applies from the next turn.
    if (config.dataDir !== undefined) {
      const persona = new PersonaStore(config.dataDir)
      const loaded = persona.load()
      const answer = () => ({ persona: persona.current, prompt: personaPrompt(persona.current) })
      ctx.effect(() => this.registry.register({
        id: PERSONA_CAPABILITY,
        version: 1,
        methods: {
          'persona/get': async () => { await loaded; return answer() },
          'persona/set': async params => { await loaded; await persona.set((params as RequestParams<'persona/set'>).persona); return answer() },
        },
      }), 'adg-gateway capability persona')
      ctx.inject(['systemPrompt'], scoped => {
        scoped.effect(() => scoped.systemPrompt.section({
          name: 'adg:persona',
          // After the harness's own guidance, before the deployment suffix (10200).
          order: 10_100,
          interpolate: false,
          text: () => personaPrompt(persona.current),
        }), 'adg-gateway persona section')
      })
    }

    // Skills the agent saved (the UI offers it after a new multi-step job): kept in this app's own data and
    // registered for its agents only, not in a skill folder other agents on the machine read.
    if (config.skillsDir !== undefined) {
      const dir = config.skillsDir
      ctx.inject(['tools', 'skills'], scoped => {
        const registered = new Map<string, () => void>()
        const register = async (name?: string) => {
          for (const skill of await userSkills(dir)) {
            if (name !== undefined && skill.name !== name) continue
            registered.get(skill.name)?.()
            try {
              registered.set(skill.name, scoped.skills.register({ name: skill.name, description: skill.description, content: skill.content, source: 'custom', path: skill.path, resourceBase: { kind: 'directory', path: dirname(skill.path) } }))
            } catch (error) {
              log.warn(`saved skill ${skill.name} not registered: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        void register().catch(error => log.warn(`saved skills not loaded: ${String(error)}`))
        scoped.effect(() => () => { for (const dispose of registered.values()) dispose(); registered.clear() }, 'adg-gateway saved skills')
        scoped.tools.register(skillSaveTool({
          dir,
          taken: async () => (await scoped.skills.list({ ...(this.workspace === undefined ? {} : { cwd: this.workspace }) })).filter(s => !registered.has(s.name)).map(s => s.name),
          saved: name => register(name),
        }))
      })
    }

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
              for (const request of this.questions.open()) ready.notify('question/requested', request)
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

  /** Let another place answer the agent's questions too (first answer wins), on the caller's fiber. */
  addQuestionAnswerer(answerer: QuestionAnswerer): () => void {
    let dispose: () => void = () => {}
    this.ctx.effect(() => {
      dispose = this.questions.addAnswerer(answerer)
      return dispose
    }, 'adg-gateway question answerer')
    return () => dispose()
  }

  /** Answer a question from an answerer. @returns false when it is unknown or already answered. */
  respondQuestion(questionId: string, answers: readonly QuestionAnswerItem[]): boolean {
    return this.questions.respond(questionId, answers)
  }

  /** Send one notification to every initialized client. */
  /** Where sessions work when they do not say (the agent's own folder, never the app's). */
  workspaceDir(): string | undefined {
    return this.workspace
  }

  /** The user turned on full access (设置 → 权限): no sandbox, no approvals, no guard. */
  fullAccess(): boolean {
    return this.permissions.mode === 'full'
  }

  /** Is this session archived? (A chat-channel conversation then starts a new one.) */
  isArchived(sessionId: string): boolean {
    return this.archived.has(sessionId)
  }

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
          } else if (frame.key === 'inbox') {
            this.broadcast('session/queue', { sessionId: frame.sessionId, items: toQueue(frame.value) })
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
