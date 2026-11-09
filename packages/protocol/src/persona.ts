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
