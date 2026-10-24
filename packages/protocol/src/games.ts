/**
 * `games@1`: game information (docs/PLAN.zh.md §5.5) — the games known from
 * Game Packs, their events (dates from data sites, progress read from the
 * game screen), refreshing both, and the daily report. Served by
 * `@adg/game-intel`.
 */
import { z } from 'zod'
import { ClockTime } from './pipelines.ts'

export const GAMES_CAPABILITY = 'games'

export const Activity = z.object({
  /** `<game>/<key>`; the key is the normalised name, so a site and the screen meet on it. */
  id: z.string(),
  game: z.string(),
  name: z.string(),
  startsAt: z.number().optional(),
  endsAt: z.number().optional(),
  /** The event's shop stays open until then (Arknights: 兑换结束). */
  shopEndsAt: z.number().optional(),
  url: z.string().optional(),
  /** What kind of event, as the data site says ("SideStory", "挑战活动"). */
  kind: z.string().optional(),
  /** What it is about, from the data site. */
  description: z.string().optional(),
  /** Seen on a data site: its dates are the ones that count. */
  site: z.object({ source: z.string(), name: z.string(), at: z.number() }).optional(),
  /** Read from the game screen by the agent. */
  screen: z.object({
    at: z.number(),
    /** The remaining time as the game wrote it. */
    remaining: z.string().optional(),
    endsAt: z.number().optional(),
    /** A screenshot was kept (`games/evidence`). */
    evidence: z.boolean(),
    sessionId: z.string().optional(),
  }).optional(),
  /** Still to do, as read from the game ("活动商店还剩 3 项没换"). */
  todo: z.array(z.string()),
  done: z.array(z.string()),
  progress: z.string().optional(),
  /** The user said they are done with it (or took it back): their word beats the lists. */
  finished: z.object({ at: z.number() }).optional(),
  /** The game and the data site disagree on when it ends. */
  mismatch: z.string().optional(),
})
export type Activity = z.infer<typeof Activity>

export const GameSourceInfo = z.object({
  id: z.string(),
  name: z.string(),
  homepage: z.string().optional(),
  /** Read by the plugin itself (no model); otherwise only the agent reads it. */
  auto: z.boolean(),
})

export const GameInfo = z.object({
  id: z.string(),
  name: z.string(),
  aliases: z.array(z.string()),
  /** Script Packs that play it. */
  scripts: z.array(z.string()),
  timezone: z.string(),
  screen: z.object({ target: z.enum(['emulator', 'window']), window: z.string().optional() }).optional(),
  sources: z.array(GameSourceInfo),
  builtin: z.boolean(),
  /** Followed from the SRA public API without a Game Pack (no scripts, no screen reading): can be unfollowed. */
  followed: z.boolean().optional(),
  /** The game's current version, from a data site that knows it. */
  version: z.object({
    name: z.string(),
    title: z.string().optional(),
    startsAt: z.number().optional(),
    endsAt: z.number().optional(),
    source: z.string(),
    at: z.number(),
  }).optional(),
  /** The last data-site refresh. */
  refreshed: z.object({ at: z.number(), ok: z.boolean(), count: z.number(), detail: z.string().optional() }).optional(),
  /** The last time the agent read the game screen. */
  reading: z.object({
    state: z.enum(['running', 'done', 'failed']),
    at: z.number(),
    sessionId: z.string().optional(),
    summary: z.string().optional(),
  }).optional(),
})
export type GameInfo = z.infer<typeof GameInfo>

export const GamesSettings = z.object({
  report: z.object({
    /** Send the daily report to the chat channels (Feishu). */
    enabled: z.boolean(),
    /** Local time it is sent; data sites are read just before. */
    at: ClockTime,
    /** Games in the report; empty: every game with events. */
    games: z.array(z.string()),
    /** An event ending within this many days is called out. */
    soonDays: z.number().int().min(1).max(30),
  }),
  /** SRA game ids followed besides the Game Packs (`ys`, `zzz`…), see `games/catalog`. */
  followed: z.array(z.string()),
})
export type GamesSettings = z.infer<typeof GamesSettings>

export const ReportInfo = z.object({
  /** When today's (or the last) report went out. */
  lastSentAt: z.number().optional(),
  /** The day (YYYY-MM-DD, local) it was for. */
  lastDay: z.string().optional(),
  lastResult: z.string().optional(),
  /** The next time it will go out. */
  next: z.number().optional(),
})

export const GamesRequests = {
  'games/list': {
    capability: GAMES_CAPABILITY,
    params: z.object({}),
    result: z.object({ games: z.array(GameInfo), activities: z.array(Activity), settings: GamesSettings, report: ReportInfo }),
  },
  /** Read the data sites now (one game, or all). */
  'games/refresh': {
    capability: GAMES_CAPABILITY,
    params: z.object({ game: z.string().optional() }),
    result: z.object({ results: z.array(z.object({ game: z.string(), ok: z.boolean(), count: z.number(), detail: z.string().optional() })) }),
  },
  /** Ask the agent to read the game screen; it works in a session of its own. */
  'games/read': {
    capability: GAMES_CAPABILITY,
    params: z.object({ game: z.string() }),
    result: z.object({ sessionId: z.string() }),
  },
  'games/report/preview': {
    capability: GAMES_CAPABILITY,
    params: z.object({}),
    result: z.object({ title: z.string(), text: z.string() }),
  },
  'games/report/send': {
    capability: GAMES_CAPABILITY,
    params: z.object({}),
    result: z.object({ channels: z.array(z.string()), text: z.string() }),
  },
  'games/settings/set': {
    capability: GAMES_CAPABILITY,
    params: z.object({ report: GamesSettings.shape.report.partial().optional() }),
    result: GamesSettings,
  },
  /** The screenshot kept when an event was read from the game. */
  'games/evidence': {
    capability: GAMES_CAPABILITY,
    params: z.object({ activityId: z.string() }),
    result: z.object({ mediaType: z.string(), data: z.string() }),
  },
  /** Every game the SRA public API knows, and whether it is shown (a Game Pack reads it, or it is followed). */
  'games/catalog': {
    capability: GAMES_CAPABILITY,
    params: z.object({}),
    result: z.object({ games: z.array(z.object({ sra: z.string(), name: z.string(), followed: z.boolean(), pack: z.string().optional() })) }),
  },
  /** Follow (or stop following) an SRA game that has no Game Pack: its events come in with the daily refresh. */
  'games/follow': {
    capability: GAMES_CAPABILITY,
    params: z.object({ sra: z.string(), follow: z.boolean() }),
    result: z.object({}),
  },
  /** The user's own progress on an event: its checklist, or done as a whole. */
  'games/activity/progress': {
    capability: GAMES_CAPABILITY,
    params: z.object({
      activityId: z.string(),
      todo: z.array(z.string().min(1).max(80)).max(30).optional(),
      done: z.array(z.string().min(1).max(80)).max(30).optional(),
      finished: z.boolean().optional(),
    }),
    result: Activity,
  },
  /** Forget an event (wrongly read, or no longer wanted). */
  'games/activity/remove': {
    capability: GAMES_CAPABILITY,
    params: z.object({ activityId: z.string() }),
    result: z.object({}),
  },
} as const

export const GamesNotifications = {
  /** Something changed; re-read `games/list`. */
  'games/changed': z.object({ game: z.string().optional() }),
} as const
