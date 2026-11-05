/**
 * `skills@1`: the agent's skills (dsh's skill registry) for people to look
 * at: what each one is for, where it comes from, and its instructions. Served
 * by the gateway while the host has a skill registry. The skills kept in this
 * app's own skills folder (the agent's `skill_save`, or made on the 技能 page)
 * can be written and deleted here too.
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
  /** Kept in this app's skills folder (saved by the agent or made on the 技能 page): it can be changed and deleted. */
  removable: z.boolean().optional(),
})
export type SkillInfo = z.infer<typeof SkillInfo>

/** A skill name as the skills folder keeps it: lowercase letters, digits and hyphens. */
export const SKILL_NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
export const MAX_SKILL_NAME = 48

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
  /** Write a skill into this app's skills folder; `replace` to change one already there. Seen by the agents at once. */
  'skills/save': {
    capability: SKILLS_CAPABILITY,
    params: z.object({
      name: z.string().regex(SKILL_NAME).max(MAX_SKILL_NAME),
      description: z.string().trim().min(10).max(400),
      content: z.string().trim().min(20).max(20_000),
      /** Only these scripts (ids) see it; none: every session. */
      scripts: z.array(z.string().min(1).max(64)).max(20).optional(),
      games: z.array(z.string().min(1).max(64)).max(20).optional(),
      replace: z.boolean().optional(),
    }),
    result: z.object({ name: z.string(), replaced: z.boolean() }),
  },
  /** Delete one of this app's skills folder (`removable`). */
  'skills/remove': {
    capability: SKILLS_CAPABILITY,
    params: z.object({ name: z.string() }),
    result: z.object({}),
  },
} as const

export const SkillsNotifications = {
  /** A skill was saved or deleted; re-read `skills/list`. */
  'skills/changed': z.object({}),
} as const
