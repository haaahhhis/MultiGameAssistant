import type { ProviderApi } from '@adg/protocol'

export interface ProtocolInfo {
  readonly id: ProviderApi
  readonly title: string
  readonly subtitle: string
  readonly hint: string
  readonly placeholder: string
  /** Request path appended to the base URL. */
  readonly requestPath: (base: string) => string
  /** Model listing path the host queries when pulling models. */
  readonly listPath: (base: string) => string
}

const trim = (base: string) => base.replace(/\/+$/, '')
/** Anthropic's listing tolerates a base with or without `/v1`, like dsh's discovery does. */
const anthropicRoot = (base: string) => {
  const b = trim(base)
  return b.endsWith('/v1') ? b.slice(0, -3) : b
}

export const PROTOCOLS: readonly ProtocolInfo[] = [
  {
    id: 'openai-completions',
    title: 'OpenAI 兼容',
    subtitle: 'Chat Completions',
    hint: '绝大多数第三方网关和本地服务都用这种：OneAPI / NewAPI、OpenRouter、硅基流动、vLLM、Ollama、LM Studio 等。',
    placeholder: 'https://api.example.com/v1',
    requestPath: base => `${trim(base)}/chat/completions`,
    listPath: base => `${trim(base)}/models`,
  },
  {
    id: 'openai-responses',
    title: 'OpenAI Responses',
    subtitle: 'Responses API',
    hint: 'OpenAI 的新一代接口，支持推理摘要等能力；仅在服务方明确支持 /responses 时使用。',
    placeholder: 'https://api.openai.com/v1',
    requestPath: base => `${trim(base)}/responses`,
    listPath: base => `${trim(base)}/models`,
  },
  {
    id: 'anthropic-messages',
    title: 'Anthropic 兼容',
    subtitle: 'Messages API',
    hint: 'Claude 官方接口以及兼容 Anthropic 格式的网关。地址写到域名即可，末尾的 /v1 可有可无。',
    placeholder: 'https://api.anthropic.com',
    requestPath: base => `${anthropicRoot(base)}/v1/messages`,
    listPath: base => `${anthropicRoot(base)}/v1/models`,
  },
]

export function protocolInfo(id: string | undefined): ProtocolInfo | undefined {
  return PROTOCOLS.find(p => p.id === id)
}

/** Route id from a display name, when the name is ASCII enough to produce one. */
export function slugify(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^[^a-z]+/, '').replace(/-+$/, '').slice(0, 40)
}

/** Same derivation as the host: `acme-gateway` → `ACME_GATEWAY_API_KEY`. */
export function keyRefFor(id: string): string {
  return `${id.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_API_KEY`
}

export const ID_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/

export function isHttpUrl(value: string): boolean {
  try {
    const { protocol } = new URL(value)
    return protocol === 'http:' || protocol === 'https:'
  } catch {
    return false
  }
}

export function formatContext(tokens: number | undefined): string | null {
  if (tokens === undefined) return null
  // Powers of two read the way model cards print them: 32768 → 32K, 1048576 → 1M.
  if (tokens % 1_048_576 === 0) return `${tokens / 1_048_576}M`
  if (tokens >= 1_000_000) return `${+(tokens / 1_000_000).toFixed(1)}M`
  if (tokens % 1024 === 0) return `${tokens / 1024}K`
  if (tokens >= 1000) return `${Math.round(tokens / 1000)}K`
  return String(tokens)
}
