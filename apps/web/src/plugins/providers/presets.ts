import type { ProviderApi } from '@adg/protocol'

/** A model service people commonly use, filled in when they pick it. */
export interface ProviderPreset {
  readonly key: string
  readonly name: string
  readonly note: string
  readonly api: ProviderApi
  readonly baseURL: string
  readonly id: string
  /** Where to create a key; undefined: no key needed. */
  readonly keyUrl?: string
  /** Pick a model that accepts images for screenshots (diagnosis, game info). */
  readonly vision?: string
}

export const PRESETS: readonly ProviderPreset[] = [
  { key: 'anthropic', name: 'Claude（Anthropic）', note: '看图和工具调用都很强', api: 'anthropic-messages', baseURL: 'https://api.anthropic.com', id: 'claude', keyUrl: 'https://console.anthropic.com/settings/keys', vision: '所有 Claude 模型都能看图' },
  { key: 'openai', name: 'ChatGPT（OpenAI）', note: 'GPT 系列', api: 'openai-completions', baseURL: 'https://api.openai.com/v1', id: 'chatgpt', keyUrl: 'https://platform.openai.com/api-keys', vision: 'gpt-4o、gpt-4.1 等能看图' },
  { key: 'gemini', name: 'Gemini（Google）', note: 'OpenAI 兼容接口', api: 'openai-completions', baseURL: 'https://generativelanguage.googleapis.com/v1beta/openai', id: 'gemini', keyUrl: 'https://aistudio.google.com/apikey', vision: 'Gemini 模型都能看图' },
  { key: 'openrouter', name: 'OpenRouter', note: '一个 Key 用很多家的模型', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', id: 'openrouter', keyUrl: 'https://openrouter.ai/keys' },
  { key: 'siliconflow', name: '硅基流动', note: '国内，开源模型多', api: 'openai-completions', baseURL: 'https://api.siliconflow.cn/v1', id: 'siliconflow', keyUrl: 'https://cloud.siliconflow.cn/account/ak' },
  { key: 'dashscope', name: '阿里云百炼（通义千问）', note: '国内', api: 'openai-completions', baseURL: 'https://dashscope.aliyuncs.com/compatible-mode/v1', id: 'dashscope', keyUrl: 'https://bailian.console.aliyun.com/?apiKey=1', vision: 'qwen-vl 系列能看图' },
  { key: 'moonshot', name: 'Kimi（月之暗面）', note: '国内', api: 'openai-completions', baseURL: 'https://api.moonshot.cn/v1', id: 'moonshot', keyUrl: 'https://platform.moonshot.cn/console/api-keys' },
  { key: 'zhipu', name: '智谱 GLM', note: '国内', api: 'openai-completions', baseURL: 'https://open.bigmodel.cn/api/paas/v4', id: 'zhipu', keyUrl: 'https://open.bigmodel.cn/usercenter/apikeys', vision: 'glm-4v 系列能看图' },
  { key: 'ark', name: '火山方舟（豆包）', note: '国内', api: 'openai-completions', baseURL: 'https://ark.cn-beijing.volces.com/api/v3', id: 'ark', keyUrl: 'https://console.volcengine.com/ark' },
  { key: 'ollama', name: 'Ollama（本机）', note: '在自己电脑上跑开源模型，不需要 Key', api: 'openai-completions', baseURL: 'http://127.0.0.1:11434/v1', id: 'ollama' },
  { key: 'custom', name: '其他服务', note: '中转站、自建网关等任何 OpenAI / Anthropic 兼容接口', api: 'openai-completions', baseURL: '', id: '' },
]
