/**
 * The event calendar: every game's current events, merged from what the data
 * sites say (dates, which count), what the agent read on web pages, and what
 * it read in the game (remaining time, what is still to do). Kept in
 * `<data dir>/games/`.
 *
 * Each event keeps what every source said about it on its own (`facts`), and
 * the dates shown are worked out from them: a data site's first, then the
 * newest web page's. A refresh replaces only its own source's facts, so what
 * the agent read on a page is never overwritten or dropped by one; an event
 * goes when no source lists it any more (and the game screen never showed
 * it), or when it has ended.
 */
import { mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { writeFileAtomic } from '@adg/protocol/node'
import { GamesSettings, type Activity, type GameInfo } from '@adg/protocol'
import { z } from 'zod'
import { idKey, sameEvent } from './names.ts'
import type { SitePool, SiteEvent, SiteVersion } from './sources.ts'
import { MS, leftText, parseDateText, parseRemaining, shortDate } from './time.ts'

/** An event that ended this long ago is dropped. */
const KEEP_ENDED_MS = 2 * MS.DAY
/** An event known only from the screen, with no end, is forgotten after this long. */
const KEEP_UNDATED_MS = 14 * MS.DAY
/** Screen and site may disagree by this much before it is called a mismatch (the game rounds to days). */
const MISMATCH_MS = 30 * MS.HOUR

export const DEFAULT_SETTINGS: GamesSettings = { report: { enabled: true, at: '09:00', games: [], soonDays: 3, ai: true }, followed: [] }

/** What the agent read from the game screen (or a web page) for one event. */
export interface ReadEvent {
  readonly name: string
  /** As the game wrote it: "剩余 3天12小时". */
  readonly remaining?: string | undefined
  /** An explicit end, as written ("10/25 03:59"). */
  readonly endsAt?: string | undefined
  readonly startsAt?: string | undefined
  readonly todo?: readonly string[] | undefined
  readonly done?: readonly string[] | undefined
  readonly progress?: string | undefined
  readonly url?: string | undefined
  /** source=site: the event's picture in the announcement (https only). */
  readonly cover?: string | undefined
  /** source=site: which page it was read from (a page the user added); default: "agent 查到的网页". */
  readonly source?: { readonly id: string; readonly name: string } | undefined
}

/** What one source said about an event. */
interface Fact {
  /** The source's name, for the user. */
  name: string
  /** A web page the agent read (not a data site the plugin reads itself). */
  web: boolean
  at: number
  startsAt?: number
  endsAt?: number
  shopEndsAt?: number
  url?: string
  cover?: string
  description?: string
  kind?: string
}

/** The agent's web reading when it does not say which page. */
const AGENT_PAGE = { id: 'agent', name: 'agent 查到的网页' } as const

interface Stored extends Activity {
  /** Every name it went by, for matching. */
  names: string[]
  /** What each source said, by source id, in the order they first said it. */
  facts: Record<string, Fact>
}

const StoredSchema = z.object({
  activities: z.array(z.looseObject({ id: z.string(), game: z.string(), name: z.string() })).default([]),
  refreshed: z.record(z.string(), z.object({ at: z.number(), ok: z.boolean(), count: z.number(), detail: z.string().optional() })).default({}),
  readings: z.record(z.string(), z.object({ state: z.enum(['running', 'done', 'failed']), at: z.number(), sessionId: z.string().optional(), summary: z.string().optional() })).default({}),
  report: z.object({ lastSentAt: z.number().optional(), lastDay: z.string().optional(), lastResult: z.string().optional(), lastText: z.string().optional() }).default({}),
  versions: z.record(z.string(), z.object({ name: z.string(), title: z.string().optional(), startsAt: z.number().optional(), endsAt: z.number().optional(), cover: z.string().optional(), source: z.string(), at: z.number() })).default({}),
  pools: z.record(z.string(), z.array(z.object({ name: z.string(), type: z.string().optional(), startsAt: z.number().optional(), endsAt: z.number(), cover: z.string().optional(), up: z.array(z.string()) }))).default({}),
  settings: z.object({ report: GamesSettings.shape.report.partial().default({}), followed: z.array(z.string()).default([]) }).default({ report: {}, followed: [] }),
  /** Pages the user added to a game (games/source/add), by game. */
  links: z.record(z.string(), z.array(z.object({ id: z.string(), name: z.string(), url: z.string(), at: z.number() }))).default({}),
})
type Saved = z.infer<typeof StoredSchema>

export class Calendar {
  readonly #dir: string
  #items: Stored[] = []
  #saved: Omit<Saved, 'activities'> = { refreshed: {}, readings: {}, report: {}, settings: { report: {}, followed: [] }, versions: {}, pools: {}, links: {} }

  constructor(dir: string) {
    this.#dir = dir
  }

  get file(): string {
    return join(this.#dir, 'calendar.json')
  }

  async load(): Promise<void> {
    try {
      const saved = StoredSchema.parse(JSON.parse(await readFile(this.file, 'utf8')))
      this.#items = saved.activities.map(a => migrate({ todo: [], done: [], ...a, names: Array.isArray(a['names']) ? (a['names'] as string[]) : [a.name] } as unknown as Stored))
      this.#saved = { refreshed: saved.refreshed, readings: saved.readings, report: saved.report, settings: saved.settings, versions: saved.versions, pools: saved.pools, links: saved.links }
    } catch {
      // first start, or unreadable: start empty
    }
  }

  async save(): Promise<void> {
    await mkdir(this.#dir, { recursive: true })
    await writeFileAtomic(this.file, `${JSON.stringify({ activities: this.#items, ...this.#saved }, null, 1)}\n`)
  }

  // ── reading ──

  /** Current events, soonest end first; events without an end last. */
  list(game?: string): Activity[] {
    return this.#items
      .filter(a => game === undefined || a.game === game)
      .sort((a, b) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity) || a.name.localeCompare(b.name))
      .map(a => this.#public(a))
  }

  get(id: string): Activity | undefined {
    const found = this.#items.find(a => a.id === id)
    return found === undefined ? undefined : this.#public(found)
  }

  get settings(): GamesSettings {
    const saved = Object.fromEntries(Object.entries(this.#saved.settings.report).filter(([, v]) => v !== undefined))
    return { report: { ...DEFAULT_SETTINGS.report, ...saved }, followed: [...this.#saved.settings.followed] }
  }

  get report(): Saved['report'] {
    return this.#saved.report
  }

  refreshed(game: string): GameInfo['refreshed'] {
    return this.#saved.refreshed[game]
  }

  reading(game: string): GameInfo['reading'] {
    return this.#saved.readings[game]
  }

  /** Banners still open. */
  pools(game: string, now: number): NonNullable<GameInfo['pools']> {
    return (this.#saved.pools[game] ?? []).filter(p => p.endsAt > now)
  }

  /** Every picture address a data site gave: the only ones the host will fetch. */
  pictures(): Set<string> {
    const out = new Set<string>()
    for (const a of this.#items) if (a.cover !== undefined) out.add(a.cover)
    for (const v of Object.values(this.#saved.versions)) if (v.cover !== undefined) out.add(v.cover)
    for (const list of Object.values(this.#saved.pools)) for (const p of list) if (p.cover !== undefined) out.add(p.cover)
    return out
  }

  version(game: string): GameInfo['version'] {
    const v = this.#saved.versions[game]
    // A version that ended a while ago is old news until a source says what came next.
    return v !== undefined && (v.endsAt === undefined || v.endsAt > Date.now() - KEEP_ENDED_MS) ? v : undefined
  }

  /** Pages the user added to a game. */
  links(game: string): Saved['links'][string] {
    return this.#saved.links[game] ?? []
  }

  // ── writing ──

  /** @returns the new source's id. */
  async addLink(game: string, link: { name: string; url: string; at: number }): Promise<string> {
    const list = this.#saved.links[game] ?? []
    const same = list.find(l => l.url === link.url)
    if (same !== undefined) return same.id
    let n = list.length + 1
    while (list.some(l => l.id === `link-${n}`)) n++
    this.#saved.links[game] = [...list, { id: `link-${n}`, ...link }]
    await this.save()
    return `link-${n}`
  }

  /** @returns whether it was there. */
  async removeLink(game: string, id: string): Promise<boolean> {
    const list = this.#saved.links[game] ?? []
    if (!list.some(l => l.id === id)) return false
    this.#saved.links[game] = list.filter(l => l.id !== id)
    await this.save()
    return true
  }

  async configure(patch: { [K in keyof GamesSettings['report']]?: GamesSettings['report'][K] | undefined }): Promise<GamesSettings> {
    this.#saved.settings.report = { ...this.#saved.settings.report, ...Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) }
    await this.save()
    return this.settings
  }

  /** Follow or stop following an SRA game; stopping forgets its events. */
  async follow(sra: string, follow: boolean, gameId: string): Promise<void> {
    const list = this.#saved.settings.followed.filter(id => id !== sra)
    this.#saved.settings.followed = follow ? [...list, sra] : list
    if (!follow) {
      this.#items = this.#items.filter(a => a.game !== gameId)
      delete this.#saved.refreshed[gameId]
      delete this.#saved.versions[gameId]
    }
    await this.save()
  }

  /**
   * The user's own progress: the checklist as they keep it, or done as a whole.
   * @returns the event, or undefined when there is none with that id.
   */
  async progress(id: string, patch: { todo?: readonly string[] | undefined; done?: readonly string[] | undefined; finished?: boolean | undefined }, now: number): Promise<Activity | undefined> {
    const item = this.#items.find(a => a.id === id)
    if (item === undefined) return undefined
    if (patch.todo !== undefined) item.todo = unique(patch.todo.map(t => t.trim()).filter(Boolean))
    if (patch.done !== undefined) item.done = unique(patch.done.map(t => t.trim()).filter(Boolean))
    // Something ticked off is no longer to do.
    item.todo = item.todo.filter(t => !item.done.includes(t))
    if (patch.finished === true) item.finished = { at: now }
    else if (patch.finished === false) delete item.finished
    await this.save()
    return this.get(id)
  }

  async setReport(info: Saved['report']): Promise<void> {
    this.#saved.report = info
    await this.save()
  }

  async setReading(game: string, reading: NonNullable<GameInfo['reading']>): Promise<void> {
    this.#saved.readings[game] = reading
    await this.save()
  }

  /**
   * A data site's current events for a game: what it says now replaces what
   * it said before; an event it no longer lists loses only its word, and goes
   * when no other source (a web page the agent read, the game screen) has it.
   */
  async applySite(game: string, source: { id: string; name: string }, events: readonly SiteEvent[], now: number, timeZone: string): Promise<void> {
    const seen = new Set<Stored>()
    for (const event of events) {
      const names = [event.name, ...event.aliases]
      const item = this.#match(game, names, { startsAt: event.startsAt, endsAt: event.endsAt }, now, seen) ?? this.#create(game, event.name)
      seen.add(item)
      item.names = unique([...names, ...item.names])
      item.facts[source.id] = {
        name: source.name, web: false, at: now, endsAt: event.endsAt,
        ...(event.startsAt === undefined ? {} : { startsAt: event.startsAt }),
        ...(event.shopEndsAt === undefined ? {} : { shopEndsAt: event.shopEndsAt }),
        ...(event.url === undefined ? {} : { url: event.url }),
        ...(event.cover === undefined ? {} : { cover: event.cover }),
        ...(event.description === undefined ? {} : { description: event.description }),
        ...(event.kind === undefined ? {} : { kind: event.kind }),
      }
      // A data site's name for it is the one shown.
      item.name = event.name
      this.#derive(item, timeZone)
    }
    for (const item of this.#items) {
      if (item.game !== game || seen.has(item) || item.facts[source.id] === undefined) continue
      delete item.facts[source.id]
      this.#derive(item, timeZone)
    }
    this.#items = this.#items.filter(a => a.game !== game || Object.keys(a.facts).length > 0 || a.screen !== undefined)
    this.#prune(now)
    this.#saved.refreshed[game] = { at: now, ok: true, count: events.length }
    await this.save()
  }

  /** After every source of a game was read: the total, and the version if one said. */
  async refreshDone(game: string, count: number, now: number, version?: { source: string } & SiteVersion, pools?: readonly SitePool[]): Promise<void> {
    if (pools !== undefined) this.#saved.pools[game] = pools.map(p => ({ ...p, up: [...p.up] }))
    this.#saved.refreshed[game] = { at: now, ok: true, count }
    if (version !== undefined) this.#saved.versions[game] = { ...version, at: now }
    await this.save()
  }

  async refreshFailed(game: string, detail: string, now: number): Promise<void> {
    const before = this.#saved.refreshed[game]
    this.#saved.refreshed[game] = { at: now, ok: false, count: before?.count ?? 0, detail }
    await this.save()
  }

  /**
   * What the agent read. From the screen it adds progress (and the remaining
   * time, checked against the site's end); from a web page (`site`) it is
   * that page's word on the event (the user's page it came from, else
   * "agent 查到的网页"), kept beside the data sites' and used where they say
   * nothing.
   * @returns the events written, with how each was matched.
   */
  async applyRead(game: string, from: 'screen' | 'site', events: readonly ReadEvent[], context: { now: number; timeZone: string; sessionId?: string | undefined; source?: { id: string; name: string } | undefined; evidence?: (activity: Activity) => Promise<boolean> }): Promise<Array<{ activity: Activity; matched: boolean }>> {
    const { now, timeZone } = context
    const written: Array<{ activity: Activity; matched: boolean }> = []
    for (const event of events) {
      const explicit = event.endsAt === undefined ? undefined : parseDateText(event.endsAt, timeZone, now) ?? undefined
      const remaining = event.remaining === undefined ? undefined : parseRemaining(event.remaining)
      const end = explicit ?? (remaining === undefined ? undefined : now + remaining)
      const start = event.startsAt === undefined ? undefined : parseDateText(event.startsAt, timeZone, now) ?? undefined
      const existing = this.#match(game, [event.name], { startsAt: start, endsAt: end }, now)
      const item = existing ?? this.#create(game, event.name)
      item.names = unique([event.name, ...item.names])
      if (from === 'site') {
        const page = event.source ?? context.source ?? AGENT_PAGE
        // Read again from the same page: what it says now, and what it said before where it says nothing now.
        const before = item.facts[page.id]
        item.facts[page.id] = {
          ...before,
          name: page.name, web: true, at: now,
          ...(end === undefined ? {} : { endsAt: end }),
          ...(start === undefined ? {} : { startsAt: start }),
          ...(event.url === undefined ? {} : { url: event.url }),
          ...(event.cover !== undefined && /^https:\/\/\S+$/.test(event.cover) ? { cover: event.cover } : {}),
        }
      } else {
        item.screen = {
          at: now,
          ...(event.remaining === undefined ? {} : { remaining: event.remaining }),
          ...(end === undefined ? {} : { endsAt: end }),
          evidence: false,
          ...(context.sessionId === undefined ? {} : { sessionId: context.sessionId }),
        }
        if (event.todo !== undefined) item.todo = [...event.todo]
        if (event.done !== undefined) item.done = [...event.done]
        if (event.progress !== undefined) item.progress = event.progress
        else delete item.progress
      }
      this.#derive(item, timeZone)
      if (from === 'screen' && context.evidence !== undefined) item.screen!.evidence = await context.evidence(this.#public(item)).catch(() => false)
      written.push({ activity: this.#public(item), matched: existing !== undefined })
    }
    this.#prune(now)
    await this.save()
    return written
  }

  async remove(id: string): Promise<boolean> {
    const before = this.#items.length
    this.#items = this.#items.filter(a => a.id !== id)
    if (this.#items.length === before) return false
    await this.save()
    return true
  }

  // ── internals ──

  /**
   * The same event: an exact name first, then one name inside the other
   * whose dates overlap (running events preferred). `taken`: events already
   * matched in this pass, which a loose name does not take again.
   */
  #match(game: string, names: readonly string[], dates: { startsAt?: number | undefined; endsAt?: number | undefined }, now: number, taken?: ReadonlySet<Stored>): Stored | undefined {
    const mine = this.#items.filter(a => a.game === game)
    const keys = new Set(names.map(idKey))
    const exact = mine.find(a => a.names.some(n => keys.has(idKey(n))))
    if (exact !== undefined) return exact
    const overlaps = (a: Stored) => (a.startsAt ?? -Infinity) <= (dates.endsAt ?? Infinity) && (dates.startsAt ?? -Infinity) <= (a.endsAt ?? Infinity)
    const loose = mine.filter(a => taken?.has(a) !== true && sameEvent(a.names, names) && overlaps(a))
    const running = loose.find(a => (a.startsAt ?? 0) <= now && now <= (a.endsAt ?? Infinity))
    return running ?? loose[0]
  }

  #create(game: string, name: string): Stored {
    let id = `${game}/${idKey(name)}`
    for (let n = 2; this.#items.some(a => a.id === id); n++) id = `${game}/${idKey(name)}-${n}`
    const item: Stored = { id, game, name, names: [name], facts: {}, todo: [], done: [] }
    this.#items.push(item)
    return item
  }

  /**
   * The event as shown, from what its sources said: each detail from the
   * data sites first (the one that wrote last), then the web pages (the
   * newest reading); the end from the game screen when no source gives one.
   * Disagreements on the end are said: a web page against a data site, the
   * screen against a data site (the data site counts).
   */
  #derive(item: Stored, timeZone: string): void {
    const ordered = Object.entries(item.facts)
      .map(([id, fact], index) => ({ id, fact, index }))
      .sort((a, b) => Number(a.fact.web) - Number(b.fact.web) || b.fact.at - a.fact.at || b.index - a.index)
    const first = <K extends keyof Fact>(key: K): Fact[K] | undefined => ordered.find(o => o.fact[key] !== undefined)?.fact[key]
    const set = <K extends 'startsAt' | 'endsAt' | 'shopEndsAt' | 'url' | 'cover' | 'description' | 'kind'>(key: K, value: Stored[K] | undefined) => {
      if (value === undefined) delete item[key]
      else item[key] = value
    }
    const site = ordered.find(o => !o.fact.web)
    const primary = ordered[0]
    // A data site's dates come as a set (no start means none), a page's fill in only what is missing.
    set('startsAt', site !== undefined ? site.fact.startsAt : first('startsAt'))
    set('endsAt', first('endsAt') ?? item.screen?.endsAt)
    set('shopEndsAt', site !== undefined ? site.fact.shopEndsAt : first('shopEndsAt'))
    set('url', first('url'))
    set('cover', first('cover'))
    set('description', first('description'))
    set('kind', first('kind'))
    if (primary === undefined) delete item.site
    else item.site = { source: primary.id, name: primary.fact.name, at: primary.fact.at }

    delete item.mismatch
    const siteEnd = site?.fact.endsAt
    if (site === undefined || siteEnd === undefined) return
    const page = ordered.find(o => o.fact.web && o.fact.endsAt !== undefined)
    if (page !== undefined && Math.abs(page.fact.endsAt! - siteEnd) > MISMATCH_MS) {
      item.mismatch = `${page.fact.name}写的是 ${shortDate(page.fact.endsAt!, timeZone)} 结束，${site.fact.name} 写的是 ${shortDate(siteEnd, timeZone)}，以 ${site.fact.name} 为准`
      return
    }
    const screenEnd = item.screen?.endsAt
    if (screenEnd === undefined || Math.abs(screenEnd - siteEnd) <= MISMATCH_MS) return
    const shown = item.screen?.remaining ?? shortDate(screenEnd, timeZone)
    item.mismatch = `游戏里显示「${shown}」，${site.fact.name} 写的是 ${shortDate(siteEnd, timeZone)} 结束（${leftText(siteEnd, item.screen!.at)}），以 ${site.fact.name} 为准`
  }

  #prune(now: number): void {
    this.#items = this.#items.filter(a => {
      if (a.endsAt === undefined) {
        const seen = [a.screen?.at, ...Object.values(a.facts).map(f => f.at)].filter((t): t is number => t !== undefined)
        return (seen.length === 0 ? now : Math.max(...seen)) + KEEP_UNDATED_MS > now
      }
      return Math.max(a.endsAt, a.shopEndsAt ?? 0) + KEEP_ENDED_MS > now
    })
  }

  #public(item: Stored): Activity {
    const { names: _names, facts, ...activity } = item
    const sources = Object.entries(facts).map(([id, f]) => ({ id, name: f.name, at: f.at, web: f.web, ...(f.endsAt === undefined ? {} : { endsAt: f.endsAt }) }))
    return structuredClone({ ...activity, ...(sources.length === 0 ? {} : { sources }) })
  }
}

/** A calendar saved before sources were kept: what it had becomes the word of the source it named. */
function migrate(item: Stored): Stored {
  if (item.facts !== undefined && typeof item.facts === 'object') return item
  item.facts = {}
  const site = item.site
  if (site !== undefined) {
    item.facts[site.source] = {
      name: site.name, web: site.source === AGENT_PAGE.id || /^link-\d+$/.test(site.source), at: site.at,
      ...(item.startsAt === undefined ? {} : { startsAt: item.startsAt }),
      ...(item.endsAt === undefined ? {} : { endsAt: item.endsAt }),
      ...(item.shopEndsAt === undefined ? {} : { shopEndsAt: item.shopEndsAt }),
      ...(item.url === undefined ? {} : { url: item.url }),
      ...(item.cover === undefined ? {} : { cover: item.cover }),
      ...(item.description === undefined ? {} : { description: item.description }),
      ...(item.kind === undefined ? {} : { kind: item.kind }),
    }
  }
  return item
}

function unique(values: readonly string[]): string[] {
  return [...new Set(values)]
}
