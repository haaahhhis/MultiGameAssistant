/**
 * `persona@1`: how the agent talks — a style, a name, how it addresses the
 * user, and anything else the user wants to say about it. Added to every
 * agent's system prompt (the app's own conversations, Feishu, pipelines'
 * agent steps), so replies read the same everywhere. It changes the voice,
 * never the rules: approvals, the sandbox and what the agent may do stay.
 */
import { z } from 'zod'

export const PERSONA_CAPABILITY = 'persona'

export const PersonaStyle = z.enum(['default', 'concise', 'patient', 'lively', 'buddy', 'butler'])
export type PersonaStyle = z.infer<typeof PersonaStyle>

export const Persona = z.object({
  style: PersonaStyle,
  /** What the agent calls itself. */
  name: z.string().max(20).optional(),
  /** How it addresses the user ("主人", "指挥官"…). */
  callUser: z.string().max(20).optional(),
  /** Anything else, in the user's words. */
  custom: z.string().optional(),
})
export type Persona = z.infer<typeof Persona>

export const PersonaRequests = {
  'persona/get': {
    capability: PERSONA_CAPABILITY,
    params: z.object({}),
    /** `prompt`: the text added to the system prompt, for the settings page to show. */
    result: z.object({ persona: Persona, prompt: z.string() }),
  },
  'persona/set': {
    capability: PERSONA_CAPABILITY,
    params: z.object({ persona: Persona }),
    result: z.object({ persona: Persona, prompt: z.string() }),
  },
} as const
