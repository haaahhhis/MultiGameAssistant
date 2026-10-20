/**
 * The Game Pack contract (docs/PLAN.zh.md §5.5): `game.yaml` (this schema)
 * plus `GAME.md` — how to reach the event, mission and mail pages and what
 * they look like — for the agent. Built-in packs live in
 * `@adg/packs/games/<id>/`; the user's in `<data dir>/games/<id>/` replace a
 * built-in one of the same id.
 */
import { parse as parseYaml, YAMLParseError } from 'yaml'
import { z } from 'zod'
import { PackError } from './parse.ts'

const Id = z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, 'lowercase letters, digits and dashes')
const Url = z.string().url().refine(u => /^https?:\/\//.test(u), 'an http(s) address')

/**
 * A Semantic MediaWiki site (PRTS, the Bilibili game wikis) asked through its
 * `action=ask` API: every page matching `conditions` whose end date is still
 * ahead is an event. Read without a model, so the daily report costs nothing.
 */
export const SmwSource = z.object({
  /** The wiki's `api.php`. */
  api: Url,
  /** SMW conditions picking event pages, e.g. `[[分类:有活动信息的页面]]`. */
  conditions: z.string().min(2),
  /** Property holding the event's display name; the page name when absent. */
  title: z.string().min(1).optional(),
  start: z.string().min(1),
  end: z.string().min(1),
  /** When the event's shop closes, if later than the event. */
  shopEnd: z.string().min(1).optional(),
  /**
   * How the end property is stored, for the "still ahead" filter: `date` (a
   * real SMW date) or `text` written `YYYY/MM/DD HH:mm` in the game's time zone.
   */
  dates: z.enum(['date', 'text']).default('date'),
  /** The event page's address; `{page}` is the page name. */
  page: z.string().includes('{page}').optional(),
  /** Pages per query. @default 100 */
  limit: z.number().int().min(1).max(500).default(100),
})
export type SmwSource = z.infer<typeof SmwSource>

export const GameSource = z.object({
  id: Id,
  name: z.string().min(1),
  /** Where a person (or the agent, with web_fetch) reads it. */
  homepage: Url.optional(),
  /** Read by the plugin itself; without it the source is only for the agent. */
  smw: SmwSource.optional(),
})
export type GameSource = z.infer<typeof GameSource>

export const GameManifest = z.object({
  id: Id,
  name: z.string().min(1),
  /** Other names people call it, to match the user's words and script packs' `game.name`. */
  aliases: z.array(z.string().min(1)).default([]),
  /** Script Packs that play it. */
  scripts: z.array(Id).default([]),
  /** The server's time zone: dates written without one, and where a day starts. */
  timezone: z.string().min(1).default('Asia/Shanghai'),
  /** When the game's day rolls over, `HH:mm` server time. */
  dailyReset: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, 'HH:mm').default('04:00'),
  /** How the agent sees the game: in the emulator, or its PC window. */
  screen: z.object({
    target: z.enum(['emulator', 'window']),
    /** target=window: a piece of the window title (see window_list). */
    window: z.string().min(1).optional(),
  }).optional(),
  sources: z.array(GameSource).default([]),
})
export type GameManifest = z.infer<typeof GameManifest>
export type GameManifestInput = z.input<typeof GameManifest>

/** File names inside a Game Pack directory. */
export const GAME_MANIFEST_FILE = 'game.yaml'
export const GAME_GUIDE_FILE = 'GAME.md'

/**
 * Parse and validate `game.yaml` text.
 * @throws PackError for YAML syntax errors and schema violations.
 */
export function parseGameManifest(text: string, file = GAME_MANIFEST_FILE): GameManifest {
  let raw: unknown
  try {
    raw = parseYaml(text, { prettyErrors: true, maxAliasCount: 100 })
  } catch (error) {
    throw new PackError(file, [error instanceof YAMLParseError ? error.message.split('\n')[0]! : String(error)])
  }
  const parsed = GameManifest.safeParse(raw)
  if (!parsed.success) {
    throw new PackError(file, parsed.error.issues.map(issue => `${issue.path.join('.') || '(root)'}: ${issue.message}`))
  }
  return parsed.data
}
