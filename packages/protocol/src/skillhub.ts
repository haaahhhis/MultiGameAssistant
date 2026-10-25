/**
 * `skillhub@1`: the skills repository (技能库) — skills for particular games
 * and scripts, downloaded from a GitHub repository when the user wants them.
 * Core skills ship with the app and cannot be changed; the user's own skills
 * are not tracked. Served by `@adg/script-registry`.
 */
import { z } from 'zod'
import { GitHubRepo } from './scripts.ts'

export const SKILLHUB_CAPABILITY = 'skillhub'

export const HubRepo = z.object({ repo: GitHubRepo, branch: z.string().trim().min(1).max(100).regex(/^[\w./-]+$/) })
export type HubRepo = z.infer<typeof HubRepo>

export const HubItem = z.object({
  name: z.string(),
  description: z.string(),
  title: z.string().optional(),
  kind: z.enum(['game', 'script', 'general']),
  /** Game ids and script / pack ids it is for: the page suggests it for the ones the user has. */
  games: z.array(z.string()),
  scripts: z.array(z.string()),
  repo: z.string(),
  path: z.string(),
  hash: z.string(),
  installed: z.object({
    at: z.number(),
    /** The user changed it since it was downloaded. */
    modified: z.boolean(),
    /** The repository has a newer version. */
    update: z.boolean(),
  }).optional(),
  /** Why it cannot be downloaded (a core or the user's own skill has the name). */
  blocked: z.string().optional(),
})
export type HubItem = z.infer<typeof HubItem>

const ByName = z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) })

export const SkillHubRequests = {
  /** What the repositories have and how each stands here; `refresh` reads them now (otherwise at most daily). */
  'skillhub/list': {
    capability: SKILLHUB_CAPABILITY,
    params: z.object({ refresh: z.boolean().optional() }),
    result: z.object({ items: z.array(HubItem), repos: z.array(HubRepo), errors: z.array(z.string()), fetchedAt: z.number().optional() }),
  },
  'skillhub/install': {
    capability: SKILLHUB_CAPABILITY,
    params: ByName.extend({ repo: GitHubRepo.optional() }),
    result: HubItem,
  },
  /**
   * Take the newer version. A skill the user changed gives `conflict` unless
   * `resolve` says: `keep` theirs (and skip this version), `replace` it
   * (theirs backed up), or `merge` (the agent merges the two in a session).
   */
  'skillhub/update': {
    capability: SKILLHUB_CAPABILITY,
    params: ByName.extend({ resolve: z.enum(['keep', 'replace', 'merge']).optional() }),
    result: z.object({ state: z.enum(['current', 'updated', 'kept', 'conflict', 'merging']), item: HubItem, backup: z.string().optional(), sessionId: z.string().optional() }),
  },
  /** The user's version and the repository's newer one, to show what differs. */
  'skillhub/diff': {
    capability: SKILLHUB_CAPABILITY,
    params: ByName,
    result: z.object({ mine: z.string(), theirs: z.string() }),
  },
  'skillhub/remove': {
    capability: SKILLHUB_CAPABILITY,
    params: ByName,
    result: z.object({}),
  },
  /** Which repositories to read, in order (the first with a name wins). */
  'skillhub/repos/set': {
    capability: SKILLHUB_CAPABILITY,
    params: z.object({ repos: z.array(HubRepo).min(1).max(10) }),
    result: z.object({ repos: z.array(HubRepo) }),
  },
} as const

export const SkillHubNotifications = {
  /** A downloaded skill or the list changed; read `skillhub/list` again. */
  'skillhub/changed': z.object({}),
} as const
