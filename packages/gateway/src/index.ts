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
import { execFile } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import type { IncomingMessage, ServerResponse } from 'node:http'
import { dirname, join } from 'node:path'
import type { Duplex } from 'node:stream'
import { fileURLToPath } from 'node:url'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { WebSocket } from 'ws'
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
import { areaOf, COMPACTION_CAPABILITY, ErrorCode, INSTANCES_CAPABILITY, PERMISSIONS_CAPABILITY, PERSONA_CAPABILITY, QUESTIONS_CAPABILITY, RpcError, SKILLS_CAPABILITY, type ModelSelection, type NotificationMethod, type NotificationParams, type QuestionAnswerItem, type RequestParams, type SkillInfo } from '@adg/protocol'
import { ApprovalBroker, type ApprovalAnswerer } from './approvals.ts'
import { skillSaveTool, userSkills } from './skill-save.ts'
import { invokedSkills, SkillScope, type ScopedSkillInput, type SkillOwner } from './skill-scope.ts'
import { skillFocusTool } from './skill-focus-tool.ts'
import { IDENTITY_PROMPT, PersonaStore, personaPrompt } from './persona.ts'
import { timeFacts, timeMessage, timeNote, type TimedEvent } from './time-context.ts'
import { compactSession } from './compact.ts'
import { CompactionStore } from './compaction-settings.ts'
import type {} from '@deepseek-ai/dsh-system-prompt'
import { QuestionBroker, type QuestionAnswerer } from './questions.ts'
import { builtinCapabilities, toContext, toQueue, toSessionItem, toSessionModel } from './builtin.ts'
import { LastReplies } from './last-reply.ts'
import { RoleModel, SessionRoles, type RoleSpec } from './roles.ts'
import { Peer } from './peer.ts'
import { Permissions, PRESET } from './permissions.ts'
import { CapabilityRegistry, type CapabilityRegistration } from './registry.ts'
import { createSockets, MOUNT, serveMounted, startServer, type Sockets } from './server.ts'
import { copyLabel, Instances } from './instances.ts'
import { AGENT_PRESET, AgentParts, OwnSessions, type AgentPart } from './shared.ts'

export type { CapabilityRegistration, MethodContext, MethodHandler } from './registry.ts'
export type { ApprovalAnswerer, ApprovalOutcome } from './approvals.ts'
export type { QuestionAnswerer } from './questions.ts'
export { convertRecord, convertRecords } from './convert.ts'
export { Permissions, PRESET } from './permissions.ts'
export { convertEvent, convertLiveFrame, streamFacts } from './convert.ts'
export { SkillScope, type Focus, type ScopedSkillInput, type ScriptRelations, type SkillOwner } from './skill-scope.ts'
export { AGENT_PRESET, type AgentPart } from './shared.ts'
export { RoleModel, SessionRoles, type RoleSpec } from './roles.ts'
export { clashes, copyLabel, Instances, INSTANCES_DIR, type CopyRecord, type Fact } from './instances.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** Custom UI protocol gateway and its capability registry. */
    adgGateway: AdgGateway
  }
}

/**
 * The UI the dsh plugin package carries beside its code
 * (scripts/package-plugin.mjs); a checkout and the desktop app have none
 * here (the desktop app names its own).
 */
const BUNDLED_UI = fileURLToPath(new URL('../web/', import.meta.url))

/** Show the UI in the default browser; failing only costs the person a click on the printed address. */
function openInBrowser(url: string, log: { warn(message: string): void }): void {
  const [command, args] = process.platform === 'win32' ? ['rundll32', ['url.dll,FileProtocolHandler', url]]
    : process.platform === 'darwin' ? ['open', [url]] : ['xdg-open', [url]]
  execFile(command, args, { windowsHide: true }, error => { if (error !== null) log.warn(`could not open the browser: ${error.message}`) })
}

/** The token kept in the data folder, made the first time; a new random one when there is no folder or it cannot be kept. */
function keptToken(dataDir: string | undefined, log: { warn(message: string): void }): string {
  const fresh = () => randomBytes(18).toString('base64url')
  if (dataDir === undefined) return fresh()
  const file = join(dataDir, 'gateway-token')
  try {
    const saved = readFileSync(file, 'utf8').trim()
    if (/^[\w-]{16,}$/.test(saved)) return saved
  } catch { /* not made yet */ }
  const token = fresh()
  try {
    mkdirSync(dataDir, { recursive: true })
    writeFileSync(file, `${token}\n`)
  } catch (error) {
    log.warn(`the gateway token could not be kept in ${file}; the address changes on every start: ${String(error)}`)
  }
  return token
}

export interface Config {
  /** Listen address; loopback by default. */
  readonly host?: string
  /** Listen port; 0 picks a free port. @default 3290 */
  readonly port?: number
  /**
   * Connection token. Omitted: the one kept in `dataDir` (made the first
   * time), so the address stays the same between starts; without a data
   * folder, a new random one each start. It is printed either way.
   */
  readonly token?: string
  /** Built UI directory to serve at `/`; default: the UI a plugin install carries (`web/` beside `lib/`), if any. */
  readonly staticDir?: string
  /** Open the UI in the default browser once listening (the dsh plugin build: nothing else shows it). @default false */
  readonly openBrowser?: boolean
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
  /**
   * The dsh is shared with the person's other work (the plugin in a profile
   * of theirs, such as dsh desktop's): only the sessions this app created are
   * its concern, and what it gives its agents goes into its agent preset
   * (`@adg/gateway/agent`, shared.ts) instead of to every agent. @default false
   */
  readonly shared?: boolean
  /** Where the copies of the app running on this computer keep their heartbeats (instances.ts). @default INSTANCES_DIR */
  readonly instancesDir?: string
  /**
   * Listen on a port of its own (what the desktop app loads). Off: the UI is
   * only under dsh's own web server, at `/adg/`. @default true
   */
  readonly listen?: boolean
}

/** What a skill belongs to, as the 技能 page shows it. */
function ownerInfo(owner: SkillOwner | undefined): Pick<SkillInfo, 'owner'> {
  if (owner === undefined) return {}
  return { owner: { ...(owner.scripts === undefined ? {} : { scripts: [...owner.scripts] }), ...(owner.games === undefined ? {} : { games: [...owner.games] }) } }
}

/** The slice of dsh's web server (dsh-host-webserver) and its login (dsh-client-connection) the mount uses. */
interface WebServerSlice {
  register(route: { kind: 'prefix'; path: string; handler: (req: IncomingMessage, res: ServerResponse) => void }): () => void
  registerUpgrade(route: { path: string; handler: (req: IncomingMessage, socket: Duplex, head: Buffer) => void }): () => void
}
interface ConnectionSlice {
  requestRejection(request: { headers: Readonly<Record<string, string | readonly string[] | undefined>> }): 401 | 403 | undefined
}

/** The slice of dsh's session and permission-preset services the mode needs. */
interface PresetSession {
  readonly id: string
  /** Record a session event (how dsh's own preset service sets the sandbox and approval knobs). */
  append?(type: string, data: unknown): void
}
interface PresetService {
  current(session: PresetSession): string
  set(session: PresetSession, name: string): void
}

/** The slice of dsh's `agent/pre-step` waterfall (dsh-agent runtime-types) the stale-context reminder uses. */
interface PreStep {
  readonly agent: { readonly session: { readonly id: string; readonly seq: number; eventAt(seq: number): TimedEvent | undefined } }
  readonly step: number
  readonly signal: AbortSignal
}
type PreStepDecision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[]; startsRequestSeries?: true }

export class AdgGateway extends Service {
  static inject = ['sessionController']

  private readonly registry = new CapabilityRegistry()
  private readonly workspace: string | undefined
  private archived = new Set<string>()
  /** The latest context projections per session (control frames carry one key at a time). */
  private readonly contexts = new Map<string, { pressure?: unknown; breakdown?: unknown }>()
  private readonly peers = new Set<Peer>()
  private readonly approvals: ApprovalBroker
  private readonly questions: QuestionBroker
  private readonly permissions: Permissions
  private readonly permissionsReady: Promise<void>
  /** Tool calls the user already approved through guardTool: their own approval asks are not asked again. */
  private readonly approvedCalls = new Set<string>()
  /** Resolved after the listener binds. */
  url: string | undefined
  /**
   * Skill isolation (skill-scope.ts): plugins register script and game skills
   * here with what they belong to, and set what a session they start is about.
   */
  readonly skillScope: SkillScope
  /** The dsh is shared with other work (Config.shared). */
  readonly shared: boolean
  /**
   * Other copies of the app running on this computer (the desktop app and the
   * plugin both open). Plugins report what must not be used twice with `fact`.
   */
  readonly instances: Instances
  private readonly own: OwnSessions
  /** The role agents and which sessions are theirs (roles.ts). */
  readonly roles: SessionRoles
  /** The model their sessions use (roles.ts). */
  private readonly roleModelStore: RoleModel
  private readonly parts: AgentParts
  private readonly sockets: Sockets
  /** Bring one session's permission preset in line with the mode. */
  private presetOf: (sessionId: string) => void = () => {}

  constructor(ctx: Context, config: Config = {}) {
    super(ctx, 'adgGateway')
    const log = ctx.logger('adg-gateway')
    this.workspace = config.workspaceDir
    this.shared = config.shared === true
    this.own = new OwnSessions(this.shared && config.dataDir !== undefined ? join(config.dataDir, 'own-sessions.json') : undefined)
    this.parts = new AgentParts(log)
    this.roleModelStore = new RoleModel(config.dataDir === undefined ? undefined : join(config.dataDir, 'role-model.json'))
    this.roles = new SessionRoles(config.dataDir === undefined ? undefined : join(config.dataDir, 'session-roles.json'), () => this.broadcast('roles/changed', { items: this.roles.list() }))
    // A dsh of its own: every agent gets the app's parts (agentPart), registered from here.
    if (!this.shared) ctx.inject(['tools', 'systemPrompt'], scoped => { scoped.effect(() => this.parts.attach(scoped), 'adg-gateway agent parts') })
    this.skillScope = new SkillScope(config.dataDir, log)
    if (this.shared) this.skillScope.limitTo(sessionId => this.isOwn(sessionId))
    this.sockets = createSockets(socket => this.accept(socket, config.validateResults ?? false, log))
    this.instances = new Instances({
      label: copyLabel(this.shared), log,
      ...(config.dataDir === undefined ? {} : { dataDir: config.dataDir }),
      ...(config.instancesDir === undefined ? {} : { dir: config.instancesDir }),
    })
    ctx.effect(() => {
      this.instances.start(30_000, others => this.broadcast('instances/changed', { others }))
      return () => void this.instances.stop()
    }, 'adg-gateway instances')
    ctx.effect(() => this.registry.register({
      id: INSTANCES_CAPABILITY,
      version: 1,
      methods: { 'instances/others': async () => { await this.instances.beat(); return { others: this.instances.others() } } },
    }), 'adg-gateway capability instances')

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
      ...this.sessionPreset(),
      isOwn: sessionId => this.isOwn(sessionId),
      adopt: sessionId => this.adopt(sessionId),
      roles: () => this.roles.list(),
      roleOf: (sessionId, title) => this.roles.of(sessionId, title),
      requestedByOf: sessionId => this.roles.requestedBy(sessionId),
      // A task given on a role agent's page: you asked for it.
      tagRole: async (sessionId, role) => {
        await this.tagSession(sessionId, role, '你')
        return this.roleModel(role)
      },
      lastReplies: new LastReplies(ctx.sessionController),
      approvals: this.approvals,
      serverInfo: { name: 'adg-gateway', version: '0.1.0' },
      compact: (sessionId, signal) => compactSession(ctx, sessionId, signal),
      focus: (sessionId, focus) => this.skillScope.setFocus(sessionId, { scripts: focus.scripts ?? [], games: focus.games ?? [] }),
      capabilities: () => this.registry.list().filter(c => !c.id.startsWith('$')),
      notify: (call, method, params) => call.peer.notify(method, params),
    })) {
      ctx.effect(() => this.registry.register(capability), `adg-gateway capability ${capability.id}`)
    }

    // Claim approvals only while a protocol client or a chat channel can answer them. Prepended:
    // dsh's own remote bridge (dsh-api-remotes) holds a request for its browser
    // client even when none is attached, so answerers after it never run.
    ctx.on('approval/request', (request, next) => {
      // Another chat in a shared dsh: dsh's own page answers it, as it would without this app.
      if (!this.isOwn(request.agent.session.id)) return next()
      // An area's own setting (设置 → 权限) comes before the mode: allowed, refused, or asked even under full access.
      const policy = this.permissions.policyFor(request.toolName)
      if (request.callId !== undefined && this.approvedCalls.has(request.callId)) return Promise.resolve('allowed-once' as const)
      if (policy === 'deny') return Promise.resolve('rejected' as const)
      if (policy === 'allow') {
        this.permissions.allowed({ at: Date.now(), sessionId: request.agent.session.id, toolName: request.toolName, ...(request.reason === undefined ? {} : { reason: request.reason }) })
        this.broadcast('permissions/changed', this.permissions.state())
        return Promise.resolve('allowed-once' as const)
      }
      // Full access (设置 → 权限): the user said yes to everything in advance.
      if (this.permissions.mode === 'full' && policy !== 'ask') {
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
      if (sessionId === undefined || !this.isOwn(sessionId) || (!this.hasClients() && !this.questions.hasActiveAnswerer(sessionId))) return next()
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
      if (presets === undefined || !this.isOwn(session.id)) return
      const name = PRESET[this.permissions.mode]
      try {
        // A shared dsh keeps the person's own preset table, which has no full-access (no sandbox, approvals
        // still asked: dsh's `never` would refuse the app's own approvals). Its two settings go on directly,
        // as a preset would put them (dsh-sandbox-policy setSandboxMode, dsh-user-approval setApprovalPolicy).
        if (this.shared && this.permissions.mode === 'full') {
          if (presets.current(session) !== 'custom') {
            session.append?.('sandbox/mode', { mode: 'danger-full-access' })
            session.append?.('approval/policy', { policy: 'ask' })
          }
          return
        }
        if (presets.current(session) !== name) presets.set(session, name)
      } catch (error) {
        log.warn(`permission preset for ${session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    const liveSessions = () => (ctx.get('sessions' as never) as { list(): PresetSession[] } | undefined)?.list() ?? []
    const everySession = () => {
      for (const session of liveSessions()) presetFor(session)
    }
    // A shared dsh's session becomes the app's after it is created (session/created came first).
    this.presetOf = sessionId => {
      const session = liveSessions().find(s => s.id === sessionId)
      if (session !== undefined) void this.permissionsReady.then(() => presetFor(session))
    }
    this.permissionsReady = Promise.all([this.permissions.load(), this.own.loaded]).then(everySession)
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
        'permissions/area/set': async params => {
          await this.permissionsReady
          const { area, policy } = params as RequestParams<'permissions/area/set'>
          await this.permissions.setArea(area, policy)
          log.info(`permissions: ${area} → ${policy}`)
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

    // 「角色 agent 的模型」: what role agents' sessions are created with (roles.ts RoleModel).
    ctx.effect(() => this.registry.register({
      id: 'role-model',
      version: 1,
      methods: {
        'models/roleModel': async () => {
          await this.roleModelStore.loaded
          return { model: this.roleModelStore.get() ?? null }
        },
        'models/setRoleModel': async params => {
          const { model } = params as RequestParams<'models/setRoleModel'>
          await this.roleModelStore.set(model ?? undefined)
          if (model === null) return {}
          // Interventions and game reading look at screenshots.
          const info = await ctx.get('llm')?.resolveModelInfo(model.provider, model.model, AbortSignal.timeout(10_000)).catch(() => undefined)
          return info !== undefined && info.inputModalities?.includes('image') !== true ? { warning: `${model.model} 不能看图片：干预和读游戏要看截图，换一个能看图的模型。` } : {}
        },
      },
    }), 'adg-gateway capability role-model')

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
        ...ownerInfo(this.skillScope.ownerOf(s.name)),
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

    // Skill isolation: the app's script and game skills, each shown only to the sessions working on its script or game.
    ctx.inject(['skills'], scoped => {
      scoped.skills.registerProvider(control => this.skillScope.provider(control.invalidate) as never)
    })
    this.agentPart('adg-gateway skill_focus', agent => agent.tools.register(skillFocusTool(this.skillScope)))
    // A skill the user invokes by name (`/maa-daily`) brings what it belongs to into the session's focus,
    // before dsh's skill tool looks it up for that session. Prepended: this runs before the listeners after it.
    this.agentPart('adg-gateway skill focus hook', agent => agent.on('agent/pre-step' as never, (async (payload: PreStep & { messages?: readonly unknown[] }, next: () => Promise<PreStepDecision>) => {
      try {
        const owners = invokedSkills(payload.messages ?? []).map(name => this.skillScope.ownerOf(name)).filter(o => o !== undefined)
        if (owners.length > 0) {
          await this.skillScope.setFocus(payload.agent.session.id, { scripts: owners.flatMap(o => o.scripts ?? []), games: owners.flatMap(o => o.games ?? []) }, 'add')
        }
      } catch (error) {
        log.warn(`skill focus for ${payload.agent.session.id}: ${error instanceof Error ? error.message : String(error)}`)
      }
      return next()
    }) as never, true))

    // What the app is called, so the agent names it right (just before the reply style, which may give it a name of its own).
    this.agentPart('adg-gateway identity section', agent => agent.systemPrompt.section({ name: 'adg:identity', order: 10_090, interpolate: false, text: () => IDENTITY_PROMPT }))

    // Reminders that earlier parts may be out of date (time-context.ts): appended to the history, so the prompt cache keeps working.
    // Prepended, so the note goes in whatever other listeners do with the step's messages.
    const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
    this.agentPart('adg-gateway stale-context hook', agent => agent.on('agent/pre-step' as never, (async (payload: PreStep, next: () => Promise<PreStepDecision>) => {
      const decision = await next()
      if (decision.kind !== 'enter' || payload.signal.aborted) return decision
      try {
        const session = payload.agent.session
        const note = timeNote(timeFacts(session.seq, seq => session.eventAt(seq)), Date.now(), payload.step, timeZone)
        return note === undefined ? decision : { ...decision, messages: [...decision.messages, timeMessage(note)] }
      } catch (error) {
        log.warn(`stale-context reminder for ${payload.agent.session.id}: ${error instanceof Error ? error.message : String(error)}`)
        return decision
      }
    }) as never, true))

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
      this.agentPart('adg-gateway persona section', agent => agent.systemPrompt.section({
        name: 'adg:persona',
        // After the harness's own guidance, before the deployment suffix (10200).
        order: 10_100,
        interpolate: false,
        text: () => personaPrompt(persona.current),
      }))
    }

    // Automatic compaction (compaction@1): dsh reads the same file when it starts, so a change applies after a restart.
    if (config.dataDir !== undefined) {
      const compaction = new CompactionStore(config.dataDir)
      ctx.effect(() => this.registry.register({
        id: COMPACTION_CAPABILITY,
        version: 1,
        methods: {
          'compaction/get': () => compaction.state(),
          'compaction/set': params => compaction.set((params as RequestParams<'compaction/set'>).settings),
        },
      }), 'adg-gateway capability compaction')
    }

    // Skills the agent saved (the UI offers it after a new multi-step job): kept in this app's own data and
    // registered for its agents only, not in a skill folder other agents on the machine read.
    if (config.skillsDir !== undefined) {
      const dir = config.skillsDir
      let savedSkills: { registered: ReadonlyMap<string, unknown>; register(name?: string): Promise<void> } | undefined
      ctx.inject(['skills'], scoped => {
        const registered = new Map<string, () => void>()
        const register = async (name?: string) => {
          for (const skill of await userSkills(dir)) {
            if (name !== undefined && skill.name !== name) continue
            registered.get(skill.name)?.()
            try {
              registered.set(skill.name, this.skillScope.register({ name: skill.name, description: skill.description, content: skill.content, source: 'custom', path: skill.path, resourceBase: { kind: 'directory', path: dirname(skill.path) }, ...(skill.owner === undefined ? {} : { owner: skill.owner }) }))
            } catch (error) {
              log.warn(`saved skill ${skill.name} not registered: ${error instanceof Error ? error.message : String(error)}`)
            }
          }
        }
        void register().catch(error => log.warn(`saved skills not loaded: ${String(error)}`))
        scoped.effect(() => () => { for (const dispose of registered.values()) dispose(); registered.clear() }, 'adg-gateway saved skills')
        savedSkills = { registered, register }
      })
      const save = skillSaveTool({
        dir,
        taken: async () => (await ctx.get('skills')?.list({ ...(this.workspace === undefined ? {} : { cwd: this.workspace }) }) ?? []).filter(s => savedSkills?.registered.has(s.name) !== true).map(s => s.name),
        saved: async name => { await savedSkills?.register(name) },
      })
      this.agentPart('adg-gateway skill_save', agent => agent.tools.register({ ...save, execute: async (args, exec) => { await this.guardTool(exec); return save.execute(args, exec) } }))
    }

    // Session list deltas come from the controller's own lifecycle events (a shared dsh's other chats are not this app's).
    ctx.on('api-session/added', summary => {
      if (this.isOwn(summary.sessionId)) this.broadcast('sessions/changed', { kind: 'upsert', item: toSessionItem(summary, (id, title) => this.roles.of(id, title), id => this.roles.requestedBy(id)) })
    })
    ctx.on('api-session/removed', sessionId => {
      if (this.isOwn(sessionId)) this.broadcast('sessions/changed', { kind: 'removed', sessionId })
    })
    ctx.on('api-session/status', (sessionId, running) => {
      if (this.isOwn(sessionId)) this.broadcast('sessions/changed', { kind: 'upsert', item: { id: sessionId, running } })
    })
    ctx.on('api-session/activity', (sessionId, updatedAt) => {
      if (this.isOwn(sessionId)) this.broadcast('sessions/changed', { kind: 'upsert', item: { id: sessionId, updatedAt } })
    })
    ctx.on('api-session/error', (sessionId, message) => {
      if (this.isOwn(sessionId)) this.broadcast('session/error', { sessionId, message })
    })

    // Titles change through projections, so follow the host-wide control stream.
    ctx.effect(() => {
      const controller = new AbortController()
      void this.followTitles(controller.signal, log)
      return () => controller.abort()
    }, 'adg-gateway title feed')

    const staticDir = config.staticDir ?? (existsSync(join(BUNDLED_UI, 'index.html')) ? BUNDLED_UI : undefined)

    // Under dsh's own web server, at /adg/: its login guards the page and the socket, so no token (the dsh plugin).
    ctx.inject(['webServer', 'connection'], scoped => {
      const web = scoped.get('webServer' as never) as unknown as WebServerSlice
      const connection = scoped.get('connection' as never) as unknown as ConnectionSlice
      const denied = (headers: IncomingMessage['headers']) => connection.requestRejection({ headers })
      scoped.effect(() => web.register({
        kind: 'prefix',
        path: MOUNT,
        handler: (req, res) => {
          const rejection = denied(req.headers)
          if (rejection !== undefined) {
            res.writeHead(rejection, { 'content-type': 'text/plain; charset=utf-8' }).end('请从 dsh 的界面打开')
            return
          }
          serveMounted(staticDir, req, res)
        },
      }), 'adg-gateway mount')
      scoped.effect(() => web.registerUpgrade({
        path: `${MOUNT}/rpc`,
        handler: (req, socket, head) => {
          const rejection = denied(req.headers)
          if (rejection !== undefined) {
            socket.end(`HTTP/1.1 ${rejection} ${rejection === 401 ? 'Unauthorized' : 'Forbidden'}
Connection: close
Content-Length: 0

`)
            return
          }
          this.sockets.upgrade(req, socket, head)
        },
      }), 'adg-gateway mount socket')
      log.info(`UI under dsh's web server at ${MOUNT}/`)
    })

    ctx.effect(() => () => {
      for (const peer of this.peers) peer.close()
      this.peers.clear()
      void this.sockets.close()
    }, 'adg-gateway sockets')

    if (config.listen === false) return
    const token = config.token ?? keptToken(config.dataDir, log)
    ctx.effect(async () => {
      const server = await startServer({
        host: config.host ?? '127.0.0.1',
        port: config.port ?? 3290,
        token,
        ...(staticDir === undefined ? {} : { staticDir }),
        trustedHosts: config.trustedHosts ?? [],
        sockets: this.sockets,
      })
      const host = (config.host ?? '127.0.0.1').includes(':') ? `[${config.host}]` : (config.host ?? '127.0.0.1')
      this.url = `http://${host}:${server.port}/?token=${token}`
      // stderr, like the launcher's own URL line: stdout may belong to another protocol.
      process.stderr.write(`adg gateway: ${this.url}
`)
      if (config.openBrowser === true) openInBrowser(this.url, log)
      log.info(`protocol endpoint: ws://${host}:${server.port}/rpc?token=${token}`)
      return () => server.close()
    }, 'adg-gateway server')
  }

  /** One protocol client's socket, from the own port or dsh's web server. */
  private accept(socket: WebSocket, validateResults: boolean, log: ReturnType<Context['logger']>): void {
    const peer = new Peer(socket, {
      registry: this.registry,
      validateResults,
      log,
      onInitialized: ready => {
        for (const request of this.approvals.open()) if (this.isOwn(request.sessionId)) ready.notify('approval/requested', request)
        for (const request of this.questions.open()) if (this.isOwn(request.sessionId)) ready.notify('question/requested', request)
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
  }

  /** Is this one of the app's sessions? Every session is, unless the dsh is shared (Config.shared). */
  isOwn(sessionId: string): boolean {
    return !this.shared || this.own.has(sessionId)
  }

  /** What a new session of the app's is created with besides its folder: its agent preset when the dsh is shared. */
  sessionPreset(): { agentPreset?: string } {
    return this.shared ? { agentPreset: AGENT_PRESET } : {}
  }

  /**
   * A role agent (roles.ts), from the plugin that does its work: its sessions
   * are listed under it. Call in an effect; returns how to take it back.
   */
  role(spec: RoleSpec): () => void {
    return this.roles.register(spec)
  }

  /** The model a role agent's new session is created with; undefined: none chosen (or no such role). */
  roleModel(role: string): ModelSelection | undefined {
    return this.roles.list().some(r => r.id === role) ? this.roleModelStore.get() : undefined
  }

  /** Put a session the app opened under a role agent (`role`); `by`: who asked for its work (监控, 定时, 你, …). */
  async tagSession(sessionId: string, role: string, by?: string): Promise<void> {
    await this.roles.tag(sessionId, role, by)
    if (this.isOwn(sessionId)) this.broadcast('sessions/changed', { kind: 'upsert', item: { id: sessionId, role, ...(by === undefined ? {} : { requestedBy: by }) } })
  }

  /** Count a session the app just created as its own (session/created came before it was). */
  async adopt(sessionId: string): Promise<void> {
    if (!this.shared) return
    await this.own.add(sessionId)
    this.presetOf(sessionId)
  }

  /**
   * Give the app's agents something: a tool, a prompt section, a step hook.
   * With a dsh of its own, every agent gets it (the gateway's own scope takes
   * the parts, see the constructor); shared, the app's agent preset does
   * (agent.ts), so the person's other chats never see it. Belongs to the
   * calling plugin's fiber.
   *
   * Either way the part is registered from a scope that injects `tools` and
   * `systemPrompt` itself: called from another plugin, `this.ctx` is that
   * plugin's context, and an `inject` made on it cannot reach `tools`
   * (cordis: "cannot get property "tools" without inject").
   */
  agentPart(label: string, part: AgentPart): void {
    this.ctx.effect(() => this.parts.add(label, part), label)
  }

  /**
   * One of the app's general skills (a core skill every one of its sessions
   * sees). Shared, it goes through the skill scope, which shows it to the
   * app's sessions only; otherwise `register` registers it with dsh as usual.
   * @returns the disposer.
   */
  generalSkill(skill: ScopedSkillInput, register: () => () => void): () => void {
    return this.shared ? this.skillScope.register(skill) : register()
  }

  /** The agent preset's scope (agent.ts) takes every part, and later ones. @returns its disposer. */
  attachAgentScope(scope: Context): () => void {
    return this.parts.attach(scope)
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
  /**
   * Called by this app's tools before they act (most of them never ask for
   * approval on their own): an area set to 不允许 refuses, one set to 先问我
   * asks the user through dsh's approval service, even under full access.
   * @throws Error the agent reads, saying what the user set.
   */
  async guardTool(exec: { readonly name: string; readonly callId?: string; readonly agent?: unknown; readonly signal?: AbortSignal }): Promise<void> {
    await this.permissionsReady
    const policy = this.permissions.policyFor(exec.name)
    const area = areaOf(exec.name)
    if (policy === 'deny') throw new Error(`用户在「设置 → 权限」里把「${area?.title ?? exec.name}」设成了不允许，这个操作没有做。需要的话请用户去那里打开。`)
    if (policy !== 'ask') return
    const approval = this.ctx.get('approval')
    if (approval === undefined || exec.agent === undefined) throw new Error(`「${area?.title ?? exec.name}」设成了先问用户，但现在没有可用的审批渠道`)
    // exec is the tool's run context (ToolRunContext): its agent and call id are what dsh's request takes.
    const request = { agent: exec.agent, toolName: exec.name, ...(exec.callId === undefined ? {} : { callId: exec.callId }), reason: `「${area?.title ?? exec.name}」设成了每次先问你`, ...(exec.signal === undefined ? {} : { signal: exec.signal }) }
    const outcome = await approval.request(request as Parameters<typeof approval.request>[0])
    if (outcome !== 'allowed-once') throw new Error(outcome === 'rejected' ? '用户拒绝了这个操作' : `没有得到用户批准（${outcome}）`)
    if (exec.callId !== undefined) {
      this.approvedCalls.add(exec.callId)
      while (this.approvedCalls.size > 200) this.approvedCalls.delete(this.approvedCalls.values().next().value!)
    }
  }

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
          if (frame.type !== 'projection' || !this.isOwn(frame.sessionId)) continue
          if (frame.key === 'title') {
            const title = typeof frame.value === 'string' ? frame.value : null
            this.broadcast('session/title', { sessionId: frame.sessionId, title })
            const role = this.roles.of(frame.sessionId, title)
            this.broadcast('sessions/changed', { kind: 'upsert', item: { id: frame.sessionId, title, ...(role === undefined ? {} : { role }) } })
          } else if (frame.key === 'modelSelection') {
            this.broadcast('session/model', { sessionId: frame.sessionId, ...toSessionModel(frame.value) })
          } else if (frame.key === 'inbox') {
            this.broadcast('session/queue', { sessionId: frame.sessionId, items: toQueue(frame.value) })
          } else if (frame.key === 'contextPressure' || frame.key === 'contextBreakdown') {
            // The two arrive separately; the meter needs both.
            const known = this.contexts.get(frame.sessionId) ?? {}
            const next = frame.key === 'contextPressure' ? { ...known, pressure: frame.value } : { ...known, breakdown: frame.value }
            this.contexts.set(frame.sessionId, next)
            this.broadcast('session/context', { sessionId: frame.sessionId, context: toContext(next.pressure, next.breakdown) ?? null })
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
