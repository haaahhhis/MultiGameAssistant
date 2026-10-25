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
  /** A wiki file named after each event's page, used as its picture; `{page}` is the page name (PRTS: `活动预告 {page} 01.jpg`). */
  image: z.string().includes('{page}').optional(),
})
export type SmwSource = z.infer<typeof SmwSource>

/**
 * The StarRailAssistant public API (https://starrailassistant.top/reference/public-api/):
 * free, no key, JSON — the current version and its events (with a kind and a
 * description) for many games, kept by its community from official notices.
 */
export const SraSource = z.object({
  /** The API's game id: `ak` 明日方舟, `end` 终末地, `sr` 星穹铁道, `ys` 原神, `zzz` 绝区零… */
  game: z.string().regex(/^[a-z0-9-]+$/),
  /** A language tag such as `en-US`; the default language (Chinese) when absent. */
  locale: z.string().regex(/^[a-z]{2}-[A-Z]{2}$/).optional(),
  api: Url.default('https://starrailassistant.top/api/v1'),
})
export type SraSource = z.infer<typeof SraSource>

export const GameSource = z.object({
  id: Id,
  name: z.string().min(1),
  /** Where a person (or the agent, with web_fetch) reads it. */
  homepage: Url.optional(),
  /** Read by the plugin itself (smw or sra); without either the source is only for the agent. */
  smw: SmwSource.optional(),
  sra: SraSource.optional(),
}).refine(s => s.smw === undefined || s.sra === undefined, 'smw 和 sra 只能写一个')
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
  /** A picture for the game (https), shown when the data sites give none that loads. */
  art: Url.refine(u => u.startsWith('https://'), 'https').optional(),
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
