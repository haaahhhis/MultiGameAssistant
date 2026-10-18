/**
 * Request and notification catalog for protocol v1.
 *
 * Every method names the capability that serves it. A client calls only the
 * methods whose capability `initialize` reported; a UI plugin declares the
 * capabilities it needs and is enabled only when all are present.
 */
import { z } from 'zod'
import { LiveAttempt, LiveFrame, SessionEvent } from './events.ts'
import { ScriptNotifications, ScriptRequests } from './scripts.ts'

export const PROTOCOL_VERSION = 1

/** Capability ids served by the built-in gateway. Plugins may add more. */
export const BuiltinCapability = {
  sessions: 'sessions',
  chat: 'chat',
  models: 'models',
  approval: 'approval',
  credentials: 'credentials',
  providers: 'providers',
} as const

/** Credential reference name, e.g. `DEEPSEEK_API_KEY` (same grammar as dsh). */
export const CredentialRef = z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/, 'credential names use letters, digits and underscores')

/** What a UI may know about a credential: never its value. */
export const CredentialInfo = z.object({
  configured: z.boolean(),
  /** Layer supplying the value, e.g. the launch environment or the stored file. */
  source: z.string().optional(),
  /** False when a read-only layer (the launch environment) shadows the reference. */
  writable: z.boolean(),
})
export type CredentialInfo = z.infer<typeof CredentialInfo>

/** Credential read by the built-in DeepSeek model provider. */
export const DEEPSEEK_API_KEY = 'DEEPSEEK_API_KEY'

export const Capability = z.object({
  id: z.string(),
  version: z.number().int().positive(),
})
export type Capability = z.infer<typeof Capability>

export const SessionItem = z.object({
  id: z.string(),
  title: z.string().nullable(),
  updatedAt: z.number(),
  running: z.boolean(),
  /** True when the session has no turn yet. */
  blank: z.boolean(),
  /** Whether a live agent currently owns the session. */
  live: z.boolean(),
  cwd: z.string().optional(),
  parentId: z.string().optional(),
  origin: z.enum(['subagent']).optional(),
})
export type SessionItem = z.infer<typeof SessionItem>

export const SessionHeader = z.object({
  id: z.string(),
  createdAt: z.number(),
  cwd: z.string().optional(),
  parentId: z.string().optional(),
  agentPreset: z.string().optional(),
})
export type SessionHeader = z.infer<typeof SessionHeader>

export const ModelSelection = z.object({
  provider: z.string(),
  model: z.string(),
  reasoningEffort: z.string().optional(),
})
export type ModelSelection = z.infer<typeof ModelSelection>

export const ModelCatalog = z.object({
  default: ModelSelection,
  groups: z.array(z.object({
    id: z.string(),
    name: z.string(),
    models: z.array(z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().optional(),
      efforts: z.array(z.object({ id: z.string(), name: z.string() })),
      defaultEffort: z.string().optional(),
    })),
  })),
  failures: z.array(z.object({ id: z.string(), name: z.string(), message: z.string() })),
})
export type ModelCatalog = z.infer<typeof ModelCatalog>

/** The session's durable model choice: what the last request used and what the next one will use. */
export const SessionModel = z.object({
  lastUsed: ModelSelection.nullable(),
  next: ModelSelection.nullable(),
})
export type SessionModel = z.infer<typeof SessionModel>

/**
 * Wire protocols a custom provider route can speak. These are the three
 * dsh's pi-ai adapter both serves and can list models for.
 */
export const ProviderApi = z.enum(['openai-completions', 'openai-responses', 'anthropic-messages'])
export type ProviderApi = z.infer<typeof ProviderApi>

/**
 * Route id: a settings key and the stem of its credential name, so it starts
 * with a letter (credential names cannot start with a digit).
 */
export const ProviderId = z.string().regex(/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/, 'use lowercase letters, digits and single hyphens, starting with a letter')

export const ProviderModel = z.object({
  id: z.string().min(1),
  name: z.string().optional(),
  contextWindow: z.number().int().positive().optional(),
  maxTokens: z.number().int().positive().optional(),
  input: z.array(z.enum(['text', 'image'])).optional(),
})
export type ProviderModel = z.infer<typeof ProviderModel>

/** One provider route stored in the user's settings. */
export const ProviderProfile = z.object({
  id: z.string(),
  displayName: z.string(),
  /** Wire protocol; a catalog route may leave it to the catalog. */
  api: z.string().optional(),
  baseURL: z.string().optional(),
  models: z.array(ProviderModel),
  /** Credential reference the route reads its key from. */
  apiKeyRef: z.string().optional(),
  credential: CredentialInfo.optional(),
  /** False when the route narrows a provider dsh ships a catalog for. */
  declared: z.boolean(),
  /** Whether the route is currently registered and serving requests. */
  active: z.boolean(),
  /** Configuration diagnostic reported by the adapter. */
  error: z.string().optional(),
})
export type ProviderProfile = z.infer<typeof ProviderProfile>

/** Base64 characters per image (≈2.6 MB decoded); four fit in one 16 MiB frame. */
export const MAX_IMAGE_BASE64 = 3_500_000

/** An image sent with a prompt: base64 bytes without the `data:` prefix. */
export const PromptImage = z.object({
  mediaType: z.enum(['image/png', 'image/jpeg', 'image/gif', 'image/webp']),
  data: z.string().min(1).max(MAX_IMAGE_BASE64).regex(/^[A-Za-z0-9+/]+={0,2}$/, 'base64 without a data: prefix'),
  name: z.string().max(200).optional(),
})
export type PromptImage = z.infer<typeof PromptImage>

const Empty = z.object({})
const Accepted = z.object({ accepted: z.literal(true) })

/** Request method name → params and result schemas, plus its capability. */
export const Requests = {
  'initialize': {
    capability: null,
    params: z.object({
      protocolVersion: z.number().int(),
      client: z.object({ name: z.string(), version: z.string() }),
    }),
    result: z.object({
      protocolVersion: z.number().int(),
      server: z.object({ name: z.string(), version: z.string(), dsh: z.string().optional() }),
      capabilities: z.array(Capability),
    }),
  },
  'sessions/list': {
    capability: 'sessions',
    params: Empty,
    result: z.object({ items: z.array(SessionItem) }),
  },
  'sessions/create': {
    capability: 'sessions',
    params: z.object({ cwd: z.string().optional() }),
    result: z.object({ sessionId: z.string() }),
  },
  'sessions/rename': {
    capability: 'sessions',
    params: z.object({ sessionId: z.string(), title: z.string().min(1) }),
    result: z.object({ title: z.string() }),
  },
  'session/open': {
    capability: 'sessions',
    params: z.object({
      sessionId: z.string(),
      /** Upper bound on user/assistant messages in the opening window. */
      maxMessages: z.number().int().positive().optional(),
    }),
    result: z.object({
      subscriptionId: z.string(),
      header: SessionHeader,
      /** Inclusive durable cut of the opening window; pass as `throughSeq` to history. */
      cursor: z.number(),
      events: z.array(SessionEvent),
      hasMore: z.boolean(),
      title: z.string().nullable(),
      live: LiveAttempt.nullable(),
    }),
  },
  'session/close': {
    capability: 'sessions',
    params: z.object({ subscriptionId: z.string() }),
    result: Empty,
  },
  'session/history': {
    capability: 'sessions',
    params: z.object({
      sessionId: z.string(),
      throughSeq: z.number(),
      beforeSeq: z.number(),
      maxMessages: z.number().int().positive().optional(),
    }),
    result: z.object({ events: z.array(SessionEvent), hasMore: z.boolean() }),
  },
  'session/prompt': {
    capability: 'chat',
    params: z.object({
      sessionId: z.string(),
      /** Client-minted id; retrying with the same id never enqueues twice. */
      requestId: z.string(),
      text: z.string().min(1),
      mode: z.enum(['queue', 'steer']),
    }),
    result: Accepted,
  },
  'session/cancel': {
    capability: 'chat',
    params: z.object({ sessionId: z.string() }),
    result: Accepted,
  },
  'models/catalog': {
    capability: 'models',
    params: Empty,
    result: ModelCatalog,
  },
  'session/selectModel': {
    capability: 'models',
    params: ModelSelection.extend({ sessionId: z.string() }),
    result: z.object({ selected: ModelSelection }),
  },
  'session/model': {
    capability: 'models',
    params: z.object({ sessionId: z.string() }),
    result: SessionModel,
  },
  'approval/respond': {
    capability: 'approval',
    params: z.object({
      approvalId: z.string(),
      decision: z.enum(['allow-once', 'reject']),
    }),
    result: Empty,
  },
  'credentials/describe': {
    capability: 'credentials',
    params: z.object({ refs: z.array(CredentialRef).min(1).max(64) }),
    result: z.object({ items: z.record(z.string(), CredentialInfo) }),
  },
  'credentials/set': {
    capability: 'credentials',
    /** The value travels client → host only; no method ever returns it. */
    params: z.object({ ref: CredentialRef, value: z.string().min(1).max(4096) }),
    result: Empty,
  },
  'credentials/unset': {
    capability: 'credentials',
    params: z.object({ ref: CredentialRef }),
    result: Empty,
  },
  'providers/list': {
    capability: 'providers',
    params: Empty,
    result: z.object({
      providers: z.array(ProviderProfile),
      /** Pass back as `expectedRevision` so a concurrent edit is refused rather than overwritten. */
      revision: z.number(),
      writable: z.boolean(),
      protocols: z.array(ProviderApi),
      /** Every route id already in use, custom or shipped. */
      taken: z.array(z.string()),
    }),
  },
  'providers/discover': {
    capability: 'providers',
    params: z.object({
      /** Existing route being edited; lets the host use its stored key and headers. */
      provider: z.string().optional(),
      baseURL: z.url({ protocol: /^https?$/ }).optional(),
      api: ProviderApi.optional(),
      /** Used for this one request only; never stored. */
      apiKey: z.string().min(1).max(4096).optional(),
    }),
    result: z.object({ models: z.array(ProviderModel) }),
  },
  'providers/save': {
    capability: 'providers',
    params: z.object({
      id: ProviderId,
      /** True for a new route: refused when the id is taken. */
      create: z.boolean(),
      displayName: z.string().max(80).optional(),
      api: ProviderApi,
      baseURL: z.url({ protocol: /^https?$/ }),
      models: z.array(ProviderModel).min(1),
      /** Stored under the route's credential reference; omitted keeps the current key. */
      apiKey: z.string().min(1).max(4096).optional(),
      expectedRevision: z.number().optional(),
    }),
    result: z.object({ revision: z.number(), apiKeyRef: z.string().optional() }),
  },
  'providers/remove': {
    capability: 'providers',
    params: z.object({
      id: z.string().min(1),
      /** Also delete the stored key the route referenced. */
      removeKey: z.boolean().optional(),
      expectedRevision: z.number().optional(),
    }),
    result: z.object({
      revision: z.number(),
      /** True when the route was the default for new sessions and the default fell back to the profile's own. */
      defaultReset: z.boolean(),
    }),
  },
  ...ScriptRequests,
} as const

export const SessionsChanged = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('upsert'), item: SessionItem.partial().extend({ id: z.string() }) }),
  z.object({ kind: z.literal('removed'), sessionId: z.string() }),
])
export type SessionsChanged = z.infer<typeof SessionsChanged>

export const ApprovalRequested = z.object({
  approvalId: z.string(),
  sessionId: z.string(),
  toolName: z.string(),
  callId: z.string().optional(),
  reason: z.string().optional(),
  /** Localized presentation text keyed by locale (always has `en`). */
  displayReason: z.record(z.string(), z.string()).optional(),
})
export type ApprovalRequested = z.infer<typeof ApprovalRequested>

/** Notification method name → params schema. */
export const Notifications = {
  'sessions/changed': SessionsChanged,
  'session/event': z.object({ subscriptionId: z.string(), event: SessionEvent }),
  'session/live': z.object({ subscriptionId: z.string(), frame: LiveFrame }),
  'session/closed': z.object({ subscriptionId: z.string(), reason: z.string() }),
  'session/title': z.object({ sessionId: z.string(), title: z.string().nullable() }),
  'session/error': z.object({ sessionId: z.string(), message: z.string() }),
  'approval/requested': ApprovalRequested,
  'approval/resolved': z.object({ approvalId: z.string(), outcome: z.string() }),
  /** A stored credential changed (set, unset, or edited on disk). Never carries the value. */
  'credentials/changed': z.object({ ref: z.string() }),
  /** Provider routes or their models changed; re-read `providers/list` and `models/catalog`. */
  'providers/changed': z.object({}),
  /** A session's model selection changed. */
  'session/model': SessionModel.extend({ sessionId: z.string() }),
  ...ScriptNotifications,
} as const

export type RequestMethod = keyof typeof Requests
/** Params as a client writes them. */
export type RequestInput<M extends RequestMethod> = z.input<(typeof Requests)[M]['params']>
/** Params as a server handler receives them, after validation. */
export type RequestParams<M extends RequestMethod> = z.infer<(typeof Requests)[M]['params']>
export type RequestResult<M extends RequestMethod> = z.infer<(typeof Requests)[M]['result']>
export type NotificationMethod = keyof typeof Notifications
export type NotificationParams<M extends NotificationMethod> = z.infer<(typeof Notifications)[M]>

/** Standard and protocol-specific JSON-RPC error codes. */
export const ErrorCode = {
  ParseError: -32700,
  InvalidRequest: -32600,
  MethodNotFound: -32601,
  InvalidParams: -32602,
  InternalError: -32603,
  /** `initialize` has not completed on this connection. */
  NotInitialized: -32002,
  /** The upstream host rejected the operation; `data.code` carries its code. */
  HostError: -32010,
  /** The referenced subscription, approval, or session does not exist. */
  NotFound: -32011,
} as const
