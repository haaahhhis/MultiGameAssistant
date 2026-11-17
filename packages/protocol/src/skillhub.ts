/**
 * `skillhub@1`: the skills repository (技能库) — skills for particular games
 * and scripts, downloaded from a GitHub repository when the user wants them.
 * A downloaded skill follows the repository: an update replaces it. Core
 * skills ship with the app and cannot be changed; the user's own skills are
 * not tracked. Served by `@adg/script-registry`.
 */
import { z } from 'zod'
import { GitHubRepo } from './scripts.ts'
import { SkillOwner } from './skills.ts'

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
  /** Fingerprint of its whole folder: a different one is another version. */
  hash: z.string(),
  /** What the repository's index calls this version, and one line on what changed. */
  version: z.string().optional(),
  changes: z.string().optional(),
  /** App versions it works with, e.g. `>=2.1.0`. */
  requires: z.string().optional(),
  installed: z.object({
    at: z.number(),
    /** The repository has a newer version (not one gone back from). */
    update: z.boolean(),
    /** The version downloaded here. */
    version: z.string().optional(),
    /** The version the last update replaced, kept to go back to. */
    previous: z.object({ version: z.string().optional(), at: z.number() }).optional(),
    /** Went back from the repository's current version: not offered again until another. */
    held: z.boolean().optional(),
  }).optional(),
  /** Why the repository's version cannot be taken: this app is too old for it. */
  incompatible: z.string().optional(),
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
  /** Take the newer version in place of the downloaded one, changed here or not. */
  'skillhub/update': {
    capability: SKILLHUB_CAPABILITY,
    params: ByName,
    result: z.object({ state: z.enum(['current', 'updated']), item: HubItem }),
  },
  /** Go back to the version the last update replaced. */
  'skillhub/rollback': {
    capability: SKILLHUB_CAPABILITY,
    params: ByName,
    result: HubItem,
  },
  'skillhub/remove': {
    capability: SKILLHUB_CAPABILITY,
    params: ByName,
    result: z.object({}),
  },
  /**
   * Put a downloaded skill under other games and scripts than the repository
   * says (it was picked for the wrong one); empty lists make it general, `null`
   * goes back to the repository's. Kept across its updates.
   */
  'skillhub/owner': {
    capability: SKILLHUB_CAPABILITY,
    params: ByName.extend({ owner: SkillOwner.nullable() }),
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
