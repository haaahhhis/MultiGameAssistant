/**
 * Data sites read without a model: Semantic MediaWiki wikis (PRTS, the
 * Bilibili game wikis) through `api.php?action=ask`, and the StarRailAssistant
 * public API (one JSON file per game: its version and events). Each event
 * whose end is still ahead counts; permanent ones (ending 9999/01/01, 长期)
 * are left out.
 */
import type { GameManifest, SmwSource, SraSource } from '@adg/pack-schema'
import { MS, parseDateText, wallClock } from './time.ts'

export interface SiteEvent {
  readonly name: string
  /** Other names for matching: the wiki page name. */
  readonly aliases: readonly string[]
  readonly startsAt?: number
  readonly endsAt: number
  readonly shopEndsAt?: number
  readonly url?: string
  readonly kind?: string
  readonly description?: string
}

/** The game's current version, from a source that knows it. */
export interface SiteVersion {
  readonly name: string
  readonly title?: string
  readonly startsAt?: number
  readonly endsAt?: number
}

export type Fetch = (url: string, init: { signal: AbortSignal; headers: Record<string, string> }) => Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>

const USER_AGENT = 'AutoDailyGamePlay/0.6 (game event calendar; +https://github.com/haaahhhis/AutoDailyGamePlay)'
const TIMEOUT_MS = 25_000
/** Pages of results followed at most. */
const MAX_PAGES = 4

/** The `ask` query for events whose end (or shop end) is after `since`. */
export function smwQuery(smw: SmwSource, since: string): string {
  const after = (prop: string) => `${smw.conditions}[[${prop}::>${since}]]`
  const where = smw.shopEnd === undefined ? after(smw.end) : `${after(smw.end)} OR ${after(smw.shopEnd)}`
  const show = [smw.title, smw.start, smw.end, smw.shopEnd].filter((p): p is string => p !== undefined).map(p => `|?${p}`).join('')
  return `${where}${show}|limit=${smw.limit}`
}

/** "Still ahead" as the end property is stored: a date, or slash-written text. */
function sinceText(smw: SmwSource, now: number, timeZone: string): string {
  const w = wallClock(now - MS.DAY, timeZone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return smw.dates === 'text' ? `${w.year}/${pad(w.month)}/${pad(w.day)}` : `${w.year}-${pad(w.month)}-${pad(w.day)}`
}

/** One printout value: an SMW date ({ timestamp } in UTC seconds) or text in the game's zone. */
export function readValue(value: unknown, timeZone: string, now: number): number | null | undefined {
  if (typeof value === 'object' && value !== null && 'timestamp' in value) {
    const seconds = Number((value as { timestamp: unknown }).timestamp)
    if (!Number.isFinite(seconds)) return undefined
    return new Date(seconds * 1000).getUTCFullYear() >= 2100 ? null : seconds * 1000
  }
  if (typeof value === 'string') return parseDateText(value, timeZone, now)
  return undefined
}

function textValue(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim() || undefined
  if (typeof value === 'object' && value !== null && 'fulltext' in value) return String((value as { fulltext: unknown }).fulltext).trim() || undefined
  return undefined
}

/** Turn an `ask` result into events, dropping permanent and ended ones. */
export function parseAsk(results: unknown, smw: SmwSource, timeZone: string, now: number): SiteEvent[] {
  if (typeof results !== 'object' || results === null) return []
  // An empty result comes back as [] rather than {}.
  const entries = Array.isArray(results) ? [] : Object.entries(results as Record<string, unknown>)
  const events: SiteEvent[] = []
  for (const [page, raw] of entries) {
    const item = raw as { printouts?: Record<string, unknown[]>; fullurl?: unknown }
    const out = item.printouts ?? {}
    const first = (prop: string | undefined) => (prop === undefined ? undefined : out[prop]?.[0])
    const end = readValue(first(smw.end), timeZone, now)
    if (end === null || end === undefined) continue
    const start = readValue(first(smw.start), timeZone, now)
    const shop = readValue(first(smw.shopEnd), timeZone, now)
    const shopEndsAt = typeof shop === 'number' && shop > end ? shop : undefined
    if (Math.max(end, shopEndsAt ?? 0) < now) continue
    // Subobjects ("页面#子对象") are named after their page.
    const pageName = page.split('#')[0]!.trim()
    const name = textValue(first(smw.title)) ?? pageName
    const url = smw.page !== undefined ? smw.page.replace('{page}', encodeURIComponent(pageName.replace(/ /g, '_'))) : typeof item.fullurl === 'string' ? (item.fullurl.startsWith('//') ? `https:${item.fullurl}` : item.fullurl) : undefined
    events.push({
      name,
      aliases: name === pageName ? [] : [pageName],
      ...(typeof start === 'number' ? { startsAt: start } : {}),
      endsAt: end,
      ...(shopEndsAt === undefined ? {} : { shopEndsAt }),
      ...(url === undefined ? {} : { url }),
    })
  }
  return events.sort((a, b) => a.endsAt - b.endsAt)
}

/**
 * Read one source's current events.
 * @throws with a message for the user when the site cannot be read.
 */
export async function readSmw(smw: SmwSource, game: GameManifest, now: number, fetchImpl: Fetch, signal?: AbortSignal): Promise<SiteEvent[]> {
  const query = smwQuery(smw, sinceText(smw, now, game.timezone))
  const events: SiteEvent[] = []
  let offset = 0
  for (let page = 0; page < MAX_PAGES; page++) {
    const url = `${smw.api}?action=ask&format=json&query=${encodeURIComponent(offset === 0 ? query : `${query}|offset=${offset}`)}`
    const timeout = AbortSignal.timeout(TIMEOUT_MS)
    let body: { query?: { results?: unknown }; error?: { info?: string }; 'query-continue-offset'?: number }
    try {
      const response = await fetchImpl(url, { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]), headers: { 'user-agent': USER_AGENT, accept: 'application/json' } })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      body = await response.json() as typeof body
    } catch (error) {
      const why = error instanceof Error ? (error.name === 'TimeoutError' ? `${TIMEOUT_MS / 1000} 秒没有响应` : error.message) : String(error)
      throw new Error(`${new URL(smw.api).host} 读不到：${why}`)
    }
    if (body.error !== undefined) throw new Error(`${new URL(smw.api).host} 不接受这个查询：${body.error.info ?? '未知错误'}`)
    events.push(...parseAsk(body.query?.results, smw, game.timezone, now))
    const next = body['query-continue-offset']
    if (typeof next !== 'number' || next <= offset) break
    offset = next
  }
  return events
}

/** Turn an SRA activity file into the version and the events still ahead. */
export function parseSra(body: unknown, timeZone: string, now: number): { version?: SiteVersion; events: SiteEvent[] } {
  const b = (typeof body === 'object' && body !== null ? body : {}) as Record<string, unknown>
  const str = (v: unknown) => (typeof v === 'string' && v.trim() !== '' ? v.trim() : undefined)
  const when = (v: unknown) => { const t = str(v); const at = t === undefined ? undefined : parseDateText(t, timeZone, now); return typeof at === 'number' ? at : undefined }
  const events: SiteEvent[] = []
  for (const raw of Array.isArray(b['activities']) ? b['activities'] : []) {
    const a = (raw ?? {}) as Record<string, unknown>
    const name = str(a['name'])
    const endsAt = when(a['endTime'])
    if (name === undefined || endsAt === undefined || endsAt < now) continue
    const startsAt = when(a['startTime'])
    const kind = str(a['kind'])
    const description = str(a['description'])
    events.push({
      name, aliases: [], endsAt,
      ...(startsAt === undefined ? {} : { startsAt }),
      ...(kind === undefined ? {} : { kind }),
      ...(description === undefined ? {} : { description: description.length > 300 ? `${description.slice(0, 300)}…` : description }),
    })
  }
  const name = str(b['version'])
  const title = str(b['versionName'])
  const startsAt = when(b['startTime'])
  const endsAt = when(b['endTime'])
  const version: SiteVersion | undefined = name === undefined ? undefined : {
    name, ...(title === undefined ? {} : { title }), ...(startsAt === undefined ? {} : { startsAt }), ...(endsAt === undefined ? {} : { endsAt }),
  }
  return { ...(version === undefined ? {} : { version }), events: events.sort((x, y) => x.endsAt - y.endsAt) }
}

/**
 * Read one game's SRA activity file.
 * @throws with a message for the user when it cannot be read.
 */
export async function readSra(sra: SraSource, game: GameManifest, now: number, fetchImpl: Fetch, signal?: AbortSignal): Promise<{ version?: SiteVersion; events: SiteEvent[] }> {
  const url = `${sra.api.replace(/\/$/, '')}/activity/${sra.game}${sra.locale === undefined ? '' : `-${sra.locale}`}.json`
  const timeout = AbortSignal.timeout(TIMEOUT_MS)
  try {
    const response = await fetchImpl(url, { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]), headers: { 'user-agent': USER_AGENT, accept: 'application/json' } })
    if (!response.ok) throw new Error(response.status === 404 ? `没有游戏 ${sra.game} 的数据（HTTP 404）` : `HTTP ${response.status}`)
    return parseSra(await response.json(), game.timezone, now)
  } catch (error) {
    const why = error instanceof Error ? (error.name === 'TimeoutError' ? `${TIMEOUT_MS / 1000} 秒没有响应` : error.message) : String(error)
    throw new Error(`${new URL(sra.api).host} 读不到：${why}`)
  }
}
