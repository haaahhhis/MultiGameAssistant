/**
 * `persona@1`: how agents talk — a style, how they address the user, how they
 * talk to each other, and anything else the user wants to say about it. One
 * setting for all of them, which any agent can override, and each agent's own
 * name. Added to each agent's system prompt (the app's own conversations,
 * Feishu, pipelines' agent steps); sub-agents get none, their answers are data.
 * It changes the voice, never the rules: tools, duties, approvals, the sandbox
 * and what an agent may do stay.
 */
import { z } from 'zod'
import { QUIET } from './handoff-notes.ts'

export const PERSONA_CAPABILITY = 'persona'

export const PersonaStyle = z.enum(['default', 'concise', 'patient', 'lively', 'buddy', 'butler'])
export type PersonaStyle = z.infer<typeof PersonaStyle>

/** To other agents: `plain` (the default) says what is meant, without the voice; `same` keeps it. */
export const PeerStyle = z.enum(['plain', 'same'])
export type PeerStyle = z.infer<typeof PeerStyle>

export const Persona = z.object({
  style: PersonaStyle,
  /** How it addresses the user ("主人", "指挥官"…). */
  callUser: z.string().max(20).optional(),
  /** Anything else, in the user's words. */
  custom: z.string().optional(),
  peerStyle: PeerStyle.optional(),
})
export type Persona = z.infer<typeof Persona>

/** One agent's own: what is left out follows `Persona`. The name is only ever an agent's own. */
export const PersonaOverride = Persona.partial().extend({
  /** What the agent calls itself. */
  name: z.string().max(20).optional(),
})
export type PersonaOverride = z.infer<typeof PersonaOverride>

/** Everything set: for all agents, and each agent's own by its id. */
export const PersonaSettings = z.object({
  persona: Persona,
  agents: z.record(z.string(), PersonaOverride),
})
export type PersonaSettings = z.infer<typeof PersonaSettings>

const PersonaAnswer = PersonaSettings.extend({
  /** The text added to the system prompt with nothing of an agent's own, for the settings page to show. */
  prompt: z.string(),
  /** The same, as it is for each agent, by id. */
  prompts: z.record(z.string(), z.string()),
})

/** What each style adds to the prompt; `default` adds nothing. */
export const STYLE_TEXT: Readonly<Record<PersonaStyle, string>> = {
  default: '',
  concise: '回答简短直接：先给结论，再给必要的细节；少寒暄，不用表情。',
  patient: '耐心、讲清楚：每一步说明为什么这么做，用对方听得懂的话，像教一个刚接触的人。',
  lively: '语气轻松活泼，可以用一点语气词和表情，但信息要准确、不啰嗦。',
  buddy: '像一起玩游戏的老朋友那样说话：熟悉游戏里的说法，可以适当吐槽和鼓励，但不夸张、不油腻。',
  butler: '像一位稳重周到的管家：礼貌、条理清楚，主动汇报进度和需要对方决定的事。',
}

/** How one agent talks: its own where it has any, else what is set for all. */
export function personaOf(settings: PersonaSettings, agentId: string): Persona & { name?: string } {
  const own = Object.entries(settings.agents[agentId] ?? {}).filter(([, value]) => value !== undefined)
  return { ...settings.persona, ...Object.fromEntries(own) }
}

/**
 * The system-prompt text for a persona; empty when nothing is set. The host
 * adds it to the agent's prompt, and the settings page shows the same text
 * while the user is still choosing: one function, so the two cannot differ.
 */
export function personaPrompt(p: Persona & { name?: string | undefined }): string {
  const lines: string[] = []
  if (p.name !== undefined && p.name.trim() !== '') lines.push(`你的名字是「${p.name.trim()}」，自称时用这个名字。`)
  if (p.callUser !== undefined && p.callUser.trim() !== '') lines.push(`称呼用户为「${p.callUser.trim()}」。`)
  if (STYLE_TEXT[p.style] !== '') lines.push(STYLE_TEXT[p.style])
  if (p.custom !== undefined && p.custom.trim() !== '') lines.push(`用户对你说话方式的要求：${p.custom.trim()}`)
  if (lines.length === 0) return ''
  lines.push(p.peerStyle === 'same'
    ? '和其他 agent 说话时也用这个方式。'
    : '上面是对用户说话的方式。和其他 agent 说话（agent_delegate、agent_message、交回去的结论）用平实的话，直接说事，不用人设和称呼：它们要读的是内容。')
  lines.push(`软件约定的固定写法（比如「${QUIET}」这一句、线索编号、工具的参数）一字不差照写，不加语气词和表情。`)
  return ['# 回复风格', ...lines, '这些只影响你说话的方式，不改变做事的规则：确认、安全限制和不能做的事都照旧；在飞书里回复也一样。'].join('\n')
}

export const PersonaRequests = {
  'persona/get': {
    capability: PERSONA_CAPABILITY,
    params: z.object({}),
    result: PersonaAnswer,
  },
  'persona/set': {
    capability: PERSONA_CAPABILITY,
    params: PersonaSettings,
    result: PersonaAnswer,
  },
} as const
