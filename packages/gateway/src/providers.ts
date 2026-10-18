/**
 * `providers` capability: custom model provider routes.
 *
 * Nothing here talks to a model endpoint or stores a profile itself. Routes
 * live in the user's settings under the pi-ai adapter's namespace (the same
 * place dsh's own Models page writes), keys go through the credential
 * service, and model listing is the adapter's own discovery. The adapter
 * re-registers routes on every settings change, so a saved route serves the
 * next request without a restart.
 */
import type { SettingsForms, SettingsPathOp } from '@deepseek-ai/dsh-settings'
import type { LlmRuntime } from '@deepseek-ai/dsh-llm'
import {
  ErrorCode, ProviderApi, RpcError,
  type CredentialInfo, type ProviderModel, type ProviderProfile, type RequestParams, type RequestResult,
} from '@adg/protocol'
import type { HostCredentials } from './credentials.ts'
import type { CapabilityRegistration, MethodContext } from './registry.ts'

export type HostSettings = Pick<SettingsForms, 'describe' | 'mutate' | 'writable'>
export type HostLlm = Pick<LlmRuntime, 'listConfigurableProviders' | 'listProviders' | 'discoverModels'>

export interface ProvidersDeps {
  readonly settings: HostSettings
  readonly llm: HostLlm
  /** Read at call time: the credentials service may mount or unmount independently. */
  readonly credentials: () => HostCredentials | undefined
  /** Settings namespace of the pi-ai adapter entry. */
  readonly namespace: string
  /** Called after every committed write. */
  readonly changed: () => void
  /**
   * The saved default model for new sessions. Selecting a model in a session
   * also saves it as the default, so removing that model's route must not
   * leave new sessions pointing at nothing.
   */
  readonly defaultModel?: () => {
    readonly provider: string
    /** Drop the saved override so the profile's base default applies again. */
    reset(): Promise<void>
  } | undefined
}

/** The stored shape of one route, as far as this capability reads or writes it. */
interface StoredProfile {
  readonly displayName?: unknown
  readonly api?: unknown
  readonly baseURL?: unknown
  readonly apiKeyEnv?: unknown
  readonly models?: unknown
}

interface Section {
  readonly revision: number
  /** Effective routes (base layers plus the user section). */
  readonly value: Readonly<Record<string, StoredProfile>>
  /** Routes the user section owns; only these can be edited or removed. */
  readonly user: Readonly<Record<string, StoredProfile>>
}

/**
 * Credential name for a route, the same derivation dsh's Models page uses:
 * `acme-gateway` → `ACME_GATEWAY_API_KEY`.
 */
export function deriveKeyRef(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

const str = (value: unknown): string | undefined => (typeof value === 'string' && value !== '' ? value : undefined)
const posInt = (value: unknown): number | undefined =>
  (typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : undefined)

function routesOf(value: unknown): Record<string, StoredProfile> {
  const providers = (value as { providers?: unknown } | undefined)?.providers
  return typeof providers === 'object' && providers !== null ? providers as Record<string, StoredProfile> : {}
}

/** Read a stored or discovered model entry into the protocol shape, dropping anything unusable. */
export function toProviderModel(entry: unknown): ProviderModel | undefined {
  if (typeof entry !== 'object' || entry === null) return undefined
  const e = entry as Record<string, unknown>
  const id = str(e.id)
  if (id === undefined) return undefined
  const name = str(e.name)
  const contextWindow = posInt(e.contextWindow)
  const maxTokens = posInt(e.maxTokens)
  const rawInput = Array.isArray(e.input) ? e.input : Array.isArray(e.inputModalities) ? e.inputModalities : undefined
  const input = rawInput?.filter((m): m is 'text' | 'image' => m === 'text' || m === 'image')
  return {
    id,
    ...(name === undefined || name === id ? {} : { name }),
    ...(contextWindow === undefined ? {} : { contextWindow }),
    ...(maxTokens === undefined ? {} : { maxTokens }),
    ...(input === undefined || input.length === 0 ? {} : { input }),
  }
}

/** The profile object written for a model: only the fields pi-ai's model schema accepts. */
function storedModel(model: ProviderModel): Record<string, unknown> {
  return {
    id: model.id,
    ...(model.name === undefined ? {} : { name: model.name }),
    ...(model.contextWindow === undefined ? {} : { contextWindow: model.contextWindow }),
    ...(model.maxTokens === undefined ? {} : { maxTokens: model.maxTokens }),
    ...(model.input === undefined ? {} : { input: [...model.input] }),
  }
}

export function providersCapability(deps: ProvidersDeps): CapabilityRegistration {
  const { settings, llm, namespace } = deps

  const read = (): Section => {
    const descriptor = settings.describe({ redactSecrets: true }).find(d => d.ns === namespace)
    if (descriptor === undefined) {
      throw new RpcError(ErrorCode.HostError, `settings namespace "${namespace}" is not mounted; the profile needs @deepseek-ai/dsh-llm-pi-ai`, { code: 'PROVIDERS_UNAVAILABLE' })
    }
    return { revision: descriptor.revision, value: routesOf(descriptor.value), user: routesOf(descriptor.user) }
  }

  const takenIds = (section: Section): string[] => [...new Set([
    ...llm.listConfigurableProviders().map(e => e.provider),
    ...llm.listProviders().map(p => p.id),
    ...Object.keys(section.value),
  ])].sort()

  const write = async (ops: SettingsPathOp[], expectedRevision: number | undefined): Promise<number> => {
    await settings.mutate(namespace, ops, expectedRevision)
    deps.changed()
    return read().revision
  }

  const list = async (): Promise<RequestResult<'providers/list'>> => {
    const section = read()
    const directory = new Map(llm.listConfigurableProviders().map(e => [e.provider, e]))
    const active = new Set(llm.listProviders().map(p => p.id))
    const ids = Object.keys(section.user).sort()
    const refs = [...new Set(ids.map(id => str((section.value[id] ?? section.user[id])?.apiKeyEnv)).filter(r => r !== undefined))]
    const credentials = deps.credentials()
    let described: Readonly<Record<string, CredentialInfo>> = {}
    if (credentials !== undefined && refs.length > 0) {
      try {
        described = await credentials.describe(refs)
      } catch {
        // Key state is advisory; the list itself still answers.
      }
    }
    const providers = ids.map((id): ProviderProfile => {
      const profile = section.value[id] ?? section.user[id] ?? {}
      const entry = directory.get(id)
      const apiKeyRef = str(profile.apiKeyEnv)
      const info = apiKeyRef === undefined ? undefined : described[apiKeyRef]
      const api = str(profile.api)
      const baseURL = str(profile.baseURL)
      return {
        id,
        displayName: str(profile.displayName) ?? entry?.displayName ?? id,
        ...(api === undefined ? {} : { api }),
        ...(baseURL === undefined ? {} : { baseURL }),
        models: (Array.isArray(profile.models) ? profile.models : []).map(toProviderModel).filter(m => m !== undefined),
        ...(apiKeyRef === undefined ? {} : { apiKeyRef }),
        ...(info === undefined ? {} : {
          credential: { configured: info.configured, writable: info.writable, ...(info.source === undefined ? {} : { source: info.source }) },
        }),
        declared: entry?.declared ?? true,
        active: active.has(id),
        ...(entry?.error === undefined ? {} : { error: entry.error }),
      }
    })
    return { providers, revision: section.revision, writable: settings.writable, protocols: [...ProviderApi.options], taken: takenIds(section) }
  }

  const discover = async (params: RequestParams<'providers/discover'>, call: MethodContext): Promise<RequestResult<'providers/discover'>> => {
    if (params.provider === undefined && params.baseURL === undefined) {
      throw new RpcError(ErrorCode.InvalidParams, 'model discovery needs a provider route or a baseURL')
    }
    const found = await llm.discoverModels(namespace, {
      ...(params.provider === undefined ? {} : { provider: params.provider }),
      ...(params.baseURL === undefined ? {} : { baseURL: params.baseURL }),
      ...(params.api === undefined ? {} : { api: params.api }),
      ...(params.apiKey === undefined ? {} : { apiKey: params.apiKey.trim() }),
    }, call.signal)
    return { models: found.map(toProviderModel).filter(m => m !== undefined) }
  }

  const save = async (params: RequestParams<'providers/save'>): Promise<RequestResult<'providers/save'>> => {
    const section = read()
    const existing = section.user[params.id]
    if (params.create && takenIds(section).includes(params.id)) {
      throw new RpcError(ErrorCode.InvalidParams, `provider id "${params.id}" is already in use`)
    }
    if (!params.create && existing === undefined) {
      throw new RpcError(ErrorCode.NotFound, `no custom provider "${params.id}"`)
    }
    const key = params.apiKey?.trim()
    const credentials = deps.credentials()
    if (key !== undefined && key !== '' && credentials === undefined) {
      throw new RpcError(ErrorCode.HostError, 'the credentials service is not mounted, so the key cannot be stored', { code: 'CREDENTIALS_UNAVAILABLE' })
    }
    const storesKey = key !== undefined && key !== ''
    const currentRef = str(existing?.apiKeyEnv)
    // A route names its key reference only once a key is stored for it, like dsh's own page:
    // a keyless route keeps the provider's ambient authentication.
    const apiKeyRef = currentRef ?? (storesKey ? deriveKeyRef(params.id) : undefined)
    const displayName = params.displayName?.trim() ?? ''
    const base = ['providers', params.id]
    const models = params.models.map(storedModel)

    const ops: SettingsPathOp[] = params.create
      ? [{
        op: 'set',
        path: base,
        value: {
          ...(displayName === '' ? {} : { displayName }),
          ...(apiKeyRef === undefined ? {} : { apiKeyEnv: apiKeyRef }),
          api: params.api,
          baseURL: params.baseURL,
          models,
        },
      }]
      // Field by field, so settings this form does not show (headers, compat, retry policy) survive an edit.
      : [
        displayName === '' ? { op: 'unset', path: [...base, 'displayName'] } : { op: 'set', path: [...base, 'displayName'], value: displayName },
        { op: 'set', path: [...base, 'api'], value: params.api },
        { op: 'set', path: [...base, 'baseURL'], value: params.baseURL },
        { op: 'set', path: [...base, 'models'], value: models },
        ...(currentRef === undefined && apiKeyRef !== undefined ? [{ op: 'set' as const, path: [...base, 'apiKeyEnv'], value: apiKeyRef }] : []),
      ]
    const revision = await write(ops, params.expectedRevision)
    if (storesKey && apiKeyRef !== undefined) await credentials!.set(apiKeyRef, key)
    return { revision, ...(apiKeyRef === undefined ? {} : { apiKeyRef }) }
  }

  const remove = async (params: RequestParams<'providers/remove'>): Promise<RequestResult<'providers/remove'>> => {
    const section = read()
    const existing = section.user[params.id]
    if (existing === undefined) throw new RpcError(ErrorCode.NotFound, `no custom provider "${params.id}"`)
    const revision = await write([{ op: 'unset', path: ['providers', params.id] }], params.expectedRevision)
    const ref = str(existing.apiKeyEnv)
    const credentials = deps.credentials()
    // Keep a key another route still reads.
    const shared = Object.entries(section.value).some(([id, p]) => id !== params.id && str(p.apiKeyEnv) === ref)
    if (params.removeKey === true && ref !== undefined && credentials !== undefined && !shared) await credentials.unset(ref)
    const fallback = deps.defaultModel?.()
    const defaultReset = fallback !== undefined && fallback.provider === params.id
    if (defaultReset) await fallback.reset()
    return { revision, defaultReset }
  }

  return {
    id: 'providers',
    version: 1,
    methods: {
      'providers/list': () => list(),
      'providers/discover': (params, call) => discover(params as RequestParams<'providers/discover'>, call),
      'providers/save': params => save(params as RequestParams<'providers/save'>),
      'providers/remove': params => remove(params as RequestParams<'providers/remove'>),
    },
  }
}
