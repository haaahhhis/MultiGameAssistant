/**
 * `skills@1`: the agent's skills (dsh's skill registry) for people to look
 * at: what each one is for, where it comes from, and its instructions. Served
 * by the gateway while the host has a skill registry.
 */
import { z } from 'zod'

export const SKILLS_CAPABILITY = 'skills'

/** Script (or script pack) ids and game ids or names. */
export const SkillOwner = z.object({ scripts: z.array(z.string()).optional(), games: z.array(z.string()).optional() })
export type SkillOwner = z.infer<typeof SkillOwner>

export const SkillInfo = z.object({
  /** `/name` in a message invokes it. */
  name: z.string(),
  description: z.string(),
  whenToUse: z.string().optional(),
  /**
   * Where it comes from: `bundled` (shipped with the app or a plugin), `custom`
   * (packs and game packs the user added), `user-dsh` / `user-agents` (the
   * user's own skill folders), `project-*` (a working folder), `runtime`.
   */
  source: z.string(),
  /** The plugin or provider that serves it. */
  provider: z.string(),
  /** Its SKILL.md, when it is a file. */
  path: z.string().optional(),
  /** The agent finds and loads it by itself. */
  modelInvocable: z.boolean(),
  /** People can call it with `/name`. */
  userInvocable: z.boolean(),
  /**
   * What it belongs to (技能隔离): a session sees it only while it works on one
   * of these scripts or games. Absent: a general skill, seen everywhere.
   */
  owner: SkillOwner.optional(),
})
export type SkillInfo = z.infer<typeof SkillInfo>

export const SkillsRequests = {
  'skills/list': {
    capability: SKILLS_CAPABILITY,
    params: z.object({}),
    result: z.object({ skills: z.array(SkillInfo) }),
  },
  /** One skill with its instructions (markdown). */
  'skills/get': {
    capability: SKILLS_CAPABILITY,
    params: z.object({ name: z.string() }),
    result: SkillInfo.extend({ content: z.string() }),
  },
} as const
