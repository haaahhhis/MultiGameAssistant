/**
 * @adg/game-intel — game information (`ctx.adgGameIntel`): Game Packs, an event calendar fed by data sites (read without a
 * model) and by the agent reading the game screen, and a daily report to the
 * chat channels. Contributes the `games@1` capability.
 */
import { createHash } from 'node:crypto'
import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@adg/gateway'
import type {} from '@adg/intervene'
import type {} from '@adg/notify'
import type {} from '@adg/runner'
import type {} from '@adg/script-registry'
import { sessionConversations } from '@adg/notify'
import { GAME_GUIDE_FILE, GAME_MANIFEST_FILE, GameManifest, parseGameManifest } from '@adg/pack-schema'
import { GAMES_DIR } from '@adg/packs'
import { GAMES_CAPABILITY, type Activity, type GameInfo, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { Calendar, type ReadEvent } from './calendar.ts'
import { DailyReport, localDay, realClock, type Clock } from './daily.ts'
import { buildReport, recentDigest } from './report.ts'
import { wallClock } from './time.ts'
import { readSmw, readSra, type Fetch, type SiteEvent, type SitePool, type SiteVersion } from './sources.ts'
import { matchScripts } from './script-match.ts'
import { followedId, followedManifest, SRA_GAMES } from './sra-games.ts'
import { gameTools } from './tools.ts'

export { Calendar, DEFAULT_SETTINGS, type ReadEvent } from './calendar.ts'
export { DailyReport, localDay, realClock, type Clock, type DailyDeps } from './daily.ts'
export { buildReport, recentDigest, type ReportGame } from './report.ts'
export { parseAsk, parseSra, readSmw, readSra, readValue, smwQuery, type Fetch, type SiteEvent, type SiteVersion } from './sources.ts'
export { gameTools, type GameToolDeps } from './tools.ts'
export { daysLeft, leftText, parseDateText, parseRemaining, shortDate, wallClock, zonedTime } from './time.ts'
export { idKey, nameKey, sameEvent } from './names.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgGameIntel: AdgGameIntel
  }
}

const ConfigSchema = z.object({
  /** The calendar and screenshots: `<dataDir>/games/`; the user's Game Packs: `<dataDir>/games/<id>/game.yaml`. */
  dataDir: z.string().min(1),
  /** Built-in Game Packs. @default @adg/packs/games */
  gamesDir: z.string().optional(),
})
export type Config = z.input<typeof ConfigSchema>

const SKILL = new URL('../skills/game-intel.md', import.meta.url)
/** How to look things up on the web: public APIs first, then wiki query APIs, pages last. */
const WEB_SKILL = new URL('../skills/web-reading.md', import.meta.url)
/** Pictures kept for the board, by extension and media type. */
const IMAGE_TYPES: ReadonlyArray<readonly [string, string]> = [['jpg', 'image/jpeg'], ['png', 'image/png'], ['webp', 'image/webp'], ['gif', 'image/gif'], ['avif', 'image/avif']]
const MAX_IMAGE_BYTES = 8 * 1024 * 1024
/** An agent reading of the game gives up after this long. */
const READ_TIMEOUT_MS = 20 * 60_000
/** The agent's daily summary: longer than this, the plain list goes out instead. */
const SUMMARY_TIMEOUT_MS = 3 * 60_000

interface LoadedGame {
  readonly manifest: GameManifest
  readonly dir: string
  readonly builtin: boolean
  readonly guide?: string
  /** An SRA game followed without a pack. */
  readonly followed?: boolean
}

export class AdgGameIntel extends Service {
  static inject = ['adgNotify']
  readonly calendar: Calendar
  readonly ready: Promise<void>
  /** Injectable for tests. */
  fetch: Fetch = (url, init) => fetch(url, init)
  clock: Clock = realClock
  private games: LoadedGame[] = []
  private readonly daily: DailyReport
  private readonly dir: string
  private readonly builtinDir: string
  private readonly log: { warn(message: string): void }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgGameIntel')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-game-intel')
    this.log = log
    this.dir = join(spec.dataDir, 'games')
    this.builtinDir = spec.gamesDir ?? GAMES_DIR
    this.calendar = new Calendar(this.dir)
    const calendar = this.calendar
    const changed = (game?: string) => ctx.get('adgGateway')?.broadcast('games/changed', game === undefined ? {} : { game })

    const daily = new DailyReport({
      clock: { now: () => this.clock.now(), setTimeout: (fn, ms) => this.clock.setTimeout(fn, ms) },
      at: () => (calendar.settings.report.enabled ? calendar.settings.report.at : undefined),
      lastDay: () => calendar.report.lastDay,
      send: async day => {
        await this.refresh().catch(() => [])
        await this.sendReport(day)
      },
      log: { warn: m => log.warn(m) },
    })
    this.daily = daily
    this.ready = (async () => {
      await calendar.load()
      await this.loadGames(log)
      daily.start()
    })()
    ctx.effect(() => () => this.daily.stop(), 'adg-game-intel daily report')

    // ── skills: the general guide, reading the web, and each game's GAME.md ──
    // The guides for every session; a game's GAME.md only for the sessions working on that game (the gateway's skill scope).
    ctx.inject(['skills', 'adgGateway'], scoped => {
      const disposers: Array<() => void> = []
      void (async () => {
        await this.ready
        const guide = parseFrontmatter(await readFile(SKILL, 'utf8'))
        if (guide !== undefined) disposers.push(scoped.skills.register({ ...guide, source: 'bundled' }))
        const web = parseFrontmatter(await readFile(WEB_SKILL, 'utf8'))
        if (web !== undefined) disposers.push(scoped.skills.register({ ...web, source: 'bundled' }))
        for (const game of this.games) {
          if (game.guide === undefined) continue
          const skill = parseFrontmatter(game.guide)
          if (skill === undefined) { log.warn(`game ${game.manifest.id}: GAME.md has no usable frontmatter`); continue }
          try {
            const owner = { games: [game.manifest.id, game.manifest.name] }
            disposers.push(scoped.adgGateway.skillScope.register({ ...skill, source: game.builtin ? 'bundled' : 'custom', path: join(game.dir, GAME_GUIDE_FILE), resourceBase: { kind: 'directory', path: game.dir }, owner }))
          } catch (error) {
            log.warn(`game ${game.manifest.id}: skill not registered: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })().catch(error => log.warn(`game skills not loaded: ${String(error)}`))
      scoped.effect(() => () => { for (const dispose of disposers.splice(0)) dispose() }, 'adg-game-intel skills')
    })

    // ── tools ──
    ctx.inject(['tools'], scoped => {
      for (const tool of gameTools({
        games: () => this.infos(),
        activities: game => calendar.list(game),
        refresh: async game => { await this.ready; return this.refresh(game) },
        record: async (game, from, events, sessionId, keep) => { await this.ready; return this.record(game, from, events, sessionId, keep) },
        launch: async (game, signal) => { await this.ready; return this.launch(game, signal) },
        close: async (game, signal) => { await this.ready; return this.close(game, signal) },
        report: () => this.preview(),
        sendReport: () => this.sendReport(localDay(this.clock.now())),
        now: () => this.clock.now(),
        add: async (manifest, guide) => { await this.ready; return this.addGame(manifest, guide) },
      })) scoped.tools.register({ ...tool, execute: async (args, exec) => { await ctx.get('adgGateway')?.guardTool(exec); return tool.execute(args, exec) } }) // 设置 → 权限 (guardTool)
    })

    // ── capability ──
    ctx.inject(['adgGateway'], scoped => {
      scoped.adgGateway.register({
        id: GAMES_CAPABILITY,
        version: 1,
        methods: {
          'games/list': async () => {
            await this.ready
            await this.loadGames(log)
            return { games: this.infos(), activities: calendar.list(), settings: calendar.settings, report: { ...calendar.report, ...(this.daily.next() === undefined ? {} : { next: this.daily.next() }) } }
          },
          'games/refresh': async params => {
            await this.ready
            const game = (params as RequestParams<'games/refresh'>).game
            if (game !== undefined) this.game(game)
            return { results: await this.refresh(game) }
          },
          'games/read': async params => {
            await this.ready
            const p = params as RequestParams<'games/read'>
            return { sessionId: p.how === 'web' ? await this.readWeb(p.game, p.source) : await this.read(p.game) }
          },
          'games/report/preview': async () => { await this.ready; return this.preview() },
          'games/report/send': async () => {
            await this.ready
            return this.sendReport(localDay(this.clock.now()))
          },
          'games/settings/set': async params => {
            await this.ready
            const p = params as RequestParams<'games/settings/set'>
            const settings = await calendar.configure(p.report ?? {})
            this.daily.start()
            changed()
            return settings
          },
          'games/evidence': async params => {
            const id = (params as RequestParams<'games/evidence'>).activityId
            if (calendar.get(id)?.screen?.evidence !== true) throw new Error('这个活动没有保存截图')
            return { mediaType: 'image/png', data: (await readFile(this.evidenceFile(id))).toString('base64') }
          },
          'games/image': async params => {
            await this.ready
            return this.picture((params as RequestParams<'games/image'>).url)
          },
          'games/source/add': async params => {
            await this.ready
            const p = params as RequestParams<'games/source/add'>
            return this.addLink(p.game, p.url, p.name)
          },
          'games/mirrorchyan': async (params, call) => {
            await this.ready
            return this.mirrorTools((params as RequestParams<'games/mirrorchyan'>).game, call.signal)
          },
          'games/source/remove': async params => {
            await this.ready
            const p = params as RequestParams<'games/source/remove'>
            await this.removeLink(p.game, p.source)
            return {}
          },
          'games/discover': async params => {
            await this.ready
            return { sessionId: await this.discover((params as RequestParams<'games/discover'>).name) }
          },
          'games/catalog': async () => {
            await this.ready
            const followed = new Set(calendar.settings.followed)
            return {
              games: SRA_GAMES.map(g => {
                const pack = this.games.find(l => !l.followed && l.manifest.sources.some(s => s.sra?.game === g.sra))?.manifest.id
                return { sra: g.sra, name: g.name, followed: followed.has(g.sra), ...(pack === undefined ? {} : { pack }) }
              }),
            }
          },
          'games/follow': async params => {
            await this.ready
            const { sra, follow } = params as RequestParams<'games/follow'>
            if (!SRA_GAMES.some(g => g.sra === sra)) throw new Error(`SRA 公共 API 没有游戏 ${sra}`)
            await calendar.follow(sra, follow, followedId(sra))
            await this.loadGames(log)
            changed()
            // Its events, now rather than tomorrow morning.
            if (follow && this.games.some(g => g.manifest.id === followedId(sra))) void this.refresh(followedId(sra)).catch(() => [])
            return {}
          },
          'games/activity/progress': async params => {
            await this.ready
            const { activityId, ...patch } = params as RequestParams<'games/activity/progress'>
            const activity = await calendar.progress(activityId, patch, this.clock.now())
            if (activity === undefined) throw new Error('没有这个活动（可能已经结束被清掉了）')
            changed(activity.game)
            return activity
          },
          'games/activity/remove': async params => {
            await this.ready
            await calendar.remove((params as RequestParams<'games/activity/remove'>).activityId)
            changed()
            return {}
          },
        },
      })
    })

    this.changed = changed
  }

  private changed: (game?: string) => void = () => {}

  /**
   * A data site's picture, kept on disk after the first fetch (covers rarely
   * change, and the board shows them every time). Only addresses a data site
   * gave are fetched: this is not a general-purpose proxy.
   */
  private async picture(url: string): Promise<{ mediaType: string; data: string }> {
    if (!this.calendar.pictures().has(url) && !this.games.some(g => g.manifest.art === url)) throw new Error('这张图片不是数据站或游戏包给的地址')
    const name = createHash('sha256').update(url).digest('hex').slice(0, 32)
    const dir = join(this.dir, 'images')
    for (const [ext, mediaType] of IMAGE_TYPES) {
      const cached = await readFile(join(dir, `${name}.${ext}`)).catch(() => undefined)
      if (cached !== undefined) return { mediaType, data: cached.toString('base64') }
    }
    const response = await fetch(url, { signal: AbortSignal.timeout(20_000), headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MultiGameAssistant' } })
    if (!response.ok) throw new Error(`图片读不到：HTTP ${response.status}`)
    const mediaType = (response.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase()
    const ext = IMAGE_TYPES.find(([, type]) => type === mediaType)?.[0]
    if (ext === undefined) throw new Error(`不是图片（${mediaType || '没有类型'}）`)
    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length > MAX_IMAGE_BYTES) throw new Error('图片太大')
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, `${name}.${ext}`), bytes)
    return { mediaType, data: bytes.toString('base64') }
  }

  // ── games ──

  private async loadGames(log: { warn(message: string): void }): Promise<void> {
    const found = new Map<string, LoadedGame>()
    for (const [base, builtin] of [[this.builtinDir, true], [this.dir, false]] as const) {
      let entries: string[]
      try { entries = await readdir(base) } catch { continue }
      for (const id of entries) {
        const dir = join(base, id)
        let text: string
        try { text = await readFile(join(dir, GAME_MANIFEST_FILE), 'utf8') } catch { continue }
        try {
          const manifest = parseGameManifest(text, `${id}/${GAME_MANIFEST_FILE}`)
          const guide = await readFile(join(dir, GAME_GUIDE_FILE), 'utf8').catch(() => undefined)
          // The user's pack replaces a built-in one of the same id.
          found.set(manifest.id, { manifest, dir, builtin, ...(guide === undefined ? {} : { guide }) })
        } catch (error) {
          log.warn(`game pack ${id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    // SRA games followed without a pack (one a pack already reads is not added twice).
    const covered = new Set([...found.values()].flatMap(g => g.manifest.sources.map(s => s.sra?.game).filter((s): s is string => s !== undefined)))
    for (const sra of this.calendar.settings.followed) {
      const game = SRA_GAMES.find(g => g.sra === sra)
      if (game === undefined || covered.has(sra) || found.has(followedId(sra))) continue
      found.set(followedId(sra), { manifest: followedManifest(game), dir: '', builtin: true, followed: true })
    }
    // Pages the user added on the game page: sources only the agent reads.
    this.games = [...found.values()].map(g => {
      const links = this.calendar.links(g.manifest.id)
      return links.length === 0 ? g : { ...g, manifest: { ...g.manifest, sources: [...g.manifest.sources, ...links.map(l => ({ id: l.id, name: l.name, homepage: l.url }))] } }
    })
  }

  /** Keep a page about a game as a source and have the agent read it now. @returns its id and the reading session. */
  async addLink(gameId: string, url: string, name?: string): Promise<{ source: string; sessionId: string }> {
    this.game(gameId)
    const source = await this.calendar.addLink(gameId, { name: name?.trim() || hostName(url), url, at: this.clock.now() })
    await this.loadGames(this.log)
    this.changed(gameId)
    return { source, sessionId: await this.readWeb(gameId, source) }
  }

  async removeLink(gameId: string, source: string): Promise<void> {
    if (!(await this.calendar.removeLink(gameId, source))) throw new Error('这个来源不是在游戏页添加的网址，不能在这里删除')
    await this.loadGames(this.log)
    this.changed(gameId)
  }

  /**
   * The scripts that play each game: the ones its pack lists, and installed
   * scripts whose id, name, repository or pack names it (script-match.ts),
   * so a script installed from any repository finds its game (ok-ww → 鸣潮).
   */
  private scriptsByGame(): Map<string, string[]> {
    const out = new Map(this.games.map(g => [g.manifest.id, [...g.manifest.scripts]]))
    const library = this.ctx.get('adgScripts')?.library
    if (library === undefined) return out
    const scripts = library.list().scripts.map(s => {
      const pack = library.packOf(s.id)?.manifest
      const folder = s.source.kind === 'local' ? s.source.path.split(/[\\/]/).filter(Boolean).at(-1) : undefined
      const texts = [s.id, s.name, s.source.kind === 'github' ? s.source.repo : folder, s.channels.github?.repo, pack?.name, pack?.game?.name, pack?.source.github]
      return { id: s.id, texts: texts.filter((t): t is string => t !== undefined && t !== '') }
    })
    for (const [script, ids] of matchScripts(scripts, this.gameWords())) {
      for (const id of ids) {
        const list = out.get(id)!
        if (!list.includes(script)) list.push(script)
      }
    }
    return out
  }

  /** Each game's words for matching scripts and tools to it (names, aliases, the usual script names of SRA games). */
  private gameWords() {
    return this.games.map(({ manifest: m }) => ({
      id: m.id,
      words: [m.name, ...m.aliases, ...(m.id.startsWith('sra-') ? [] : [m.id]), ...m.sources.flatMap(s => SRA_GAMES.find(g => g.sra === s.sra?.game)?.words ?? [])],
    }))
  }

  /**
   * Mirror酱 tools for a game: its name or aliases in the tool's name or id,
   * else (for a tool whose name names no game) in its description. Every
   * game MultiGameAssistant knows takes part, followed or not, so a tool for
   * another game is not taken for this one; usual script names ("一条龙")
   * are left out, they do not tell tools apart. No CDK is needed.
   */
  private async mirrorTools(gameId: string, signal?: AbortSignal) {
    const library = this.ctx.get('adgScripts')?.library
    if (library === undefined) throw new Error('脚本库没有加载')
    const { items, from } = await library.searchMirror('', signal)
    // 「明日方舟：终末地」 is written 「终末地」, 「蔚蓝档案（国服）」 「蔚蓝档案」.
    const forms = (name: string) => [name, name.replace(/[（(][^）)]*[）)]/g, '').trim(), ...(/[：:](.{2,})$/.exec(name)?.slice(1) ?? [])]
    const followed = this.games.map(({ manifest: m }) => ({ id: m.id, words: [m.name, ...m.aliases].flatMap(forms) }))
    const names = new Set(this.games.map(g => g.manifest.name))
    const games = [...followed, ...SRA_GAMES.filter(g => !names.has(g.name)).map(g => ({ id: `sra:${g.sra}`, words: forms(g.name) }))]
    const byName = matchScripts(items.map(i => ({ id: i.rid, texts: [i.rid, i.name] })), games)
    const rest = items.filter(i => (byName.get(i.rid)?.length ?? 0) === 0)
    const byDescription = matchScripts(rest.map(i => ({ id: i.rid, texts: [i.description] })), games)
    const mine = new Set([...byName, ...byDescription].filter(([, ids]) => ids.includes(gameId)).map(([rid]) => rid))
    return { items: items.filter(i => mine.has(i.rid)), from }
  }

  private scriptsOf(gameId: string): string[] {
    return this.scriptsByGame().get(gameId) ?? []
  }

  private game(id: string): LoadedGame {
    const game = this.games.find(g => g.manifest.id === id)
    if (game === undefined) throw new Error(`没有游戏「${id}」`)
    return game
  }

  infos(): GameInfo[] {
    const scripts = this.scriptsByGame()
    return this.games.map(({ manifest: m, builtin, followed }) => {
      const refreshed = this.calendar.refreshed(m.id)
      const reading = this.calendar.reading(m.id)
      const webReading = this.calendar.reading(`${m.id}#web`)
      const version = this.calendar.version(m.id)
      const pools = this.calendar.pools(m.id, this.clock.now())
      return {
        id: m.id, name: m.name, aliases: m.aliases, scripts: scripts.get(m.id) ?? m.scripts, timezone: m.timezone,
        ...(m.screen === undefined ? {} : { screen: { target: m.screen.target, ...(m.screen.window === undefined ? {} : { window: m.screen.window }) } }),
        sources: m.sources.map(s => ({ id: s.id, name: s.name, ...(s.homepage === undefined ? {} : { homepage: s.homepage }), auto: s.smw !== undefined || s.sra !== undefined, ...(/^link-\d+$/.test(s.id) && this.calendar.links(m.id).some(l => l.id === s.id) ? { added: true } : {}) })),
        builtin,
        ...(m.art === undefined ? {} : { art: m.art }),
        ...(followed === true ? { followed: true } : {}),
        ...(refreshed === undefined ? {} : { refreshed }),
        ...(reading === undefined ? {} : { reading }),
        ...(webReading === undefined ? {} : { webReading }),
        ...(version === undefined ? {} : { version }),
        ...(pools.length === 0 ? {} : { pools }),
      }
    })
  }

  // ── data sites ──

  /** Read every readable data site (of one game, or all). */
  async refresh(gameId?: string): Promise<Array<{ game: string; ok: boolean; count: number; detail?: string }>> {
    const games = gameId === undefined ? this.games : [this.game(gameId)]
    const results: Array<{ game: string; ok: boolean; count: number; detail?: string }> = []
    for (const { manifest } of games) {
      const sources = manifest.sources.filter(s => s.smw !== undefined || s.sra !== undefined)
      if (sources.length === 0) {
        results.push({ game: manifest.id, ok: false, count: 0, detail: `没有能直接读的数据站：用 web_fetch 看 ${manifest.sources.map(s => s.homepage).filter(Boolean).join(' 或 ') || '官网公告'}，再用 game_record（source=site）记下` })
        continue
      }
      const failures: string[] = []
      let count = 0
      let version: ({ source: string } & SiteVersion) | undefined
      let pools: SitePool[] | undefined
      for (const source of sources) {
        const now = this.clock.now()
        try {
          let events: SiteEvent[]
          if (source.sra !== undefined) {
            const read = await readSra(source.sra, manifest, now, this.fetch)
            events = read.events
            if (read.version !== undefined) version ??= { source: source.name, ...read.version }
            pools ??= read.pools
          } else {
            events = await readSmw(source.smw!, manifest, now, this.fetch)
          }
          await this.calendar.applySite(manifest.id, { id: source.id, name: source.name }, events, now, manifest.timezone)
          count += events.length
        } catch (error) {
          failures.push(`${source.name}：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failures.length > 0 && count === 0) await this.calendar.refreshFailed(manifest.id, failures.join('；'), this.clock.now())
      else await this.calendar.refreshDone(manifest.id, this.calendar.list(manifest.id).filter(a => a.sources?.some(s => !s.web) === true).length, this.clock.now(), version, pools)
      results.push({ game: manifest.id, ok: failures.length === 0 || count > 0, count, ...(failures.length === 0 ? {} : { detail: failures.join('；') }) })
      this.changed(manifest.id)
    }
    return results
  }

  // ── what the agent read ──

  private async record(gameId: string, from: 'screen' | 'site', events: readonly ReadEvent[], sessionId: string | undefined, keep: boolean): Promise<Array<{ activity: Activity; matched: boolean }>> {
    const { manifest } = this.game(gameId)
    const shot = from === 'screen' && keep && sessionId !== undefined ? this.ctx.get('adgIntervene')?.lastShot(sessionId) : undefined
    // Read from a page the user added (same site): that page is its source, beside the agent's other readings.
    // Any other page is the agent's own find, named after its site so people can tell where it came from.
    const links = this.calendar.links(gameId)
    const credited = from !== 'site' ? events : events.map(event => {
      if (event.source !== undefined) return event
      const host = event.url === undefined || !URL.canParse(event.url) ? undefined : hostName(event.url)
      const link = host === undefined ? undefined : links.find(l => event.url!.startsWith(l.url)) ?? links.find(l => hostName(l.url) === host)
      if (link !== undefined) return { ...event, source: { id: link.id, name: link.name } }
      return host === undefined ? event : { ...event, source: { id: 'agent', name: `${host}（agent 查到）` } }
    })
    const written = await this.calendar.applyRead(gameId, from, credited, {
      now: this.clock.now(),
      timeZone: manifest.timezone,
      sessionId,
      ...(shot === undefined ? {} : {
        evidence: async activity => {
          await mkdir(join(this.dir, 'evidence'), { recursive: true })
          await writeFile(this.evidenceFile(activity.id), shot)
          return true
        },
      }),
    })
    this.changed(gameId)
    return written
  }

  private evidenceFile(activityId: string): string {
    return join(this.dir, 'evidence', `${activityId.replace(/[^\p{L}\p{N}-]+/gu, '_')}.png`)
  }

  /** Ask the agent to read the game screen, in a session of its own. @returns the session id. */
  /**
   * The agent reads the web for this game: the sources the plugin cannot read
   * itself (official news, wikis without an API), or one of them, the way the
   * web-reading skill says (public APIs first, list pages before articles),
   * and records what it finds in the calendar. Nothing is opened in the game.
   */
  /**
   * A game no pack knows yet: write the user's own pack for it
   * (`<data>/games/<id>/game.yaml`, JSON being YAML), load it, and read its
   * sources. A built-in pack of the same id is not replaced.
   * @returns the game as the board shows it. @throws Error with what is wrong in the manifest.
   */
  async addGame(input: unknown, guide?: string): Promise<GameInfo> {
    const parsed = GameManifest.safeParse(input)
    if (!parsed.success) throw new Error(`游戏包写得不对：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('；')}`)
    const manifest = parsed.data
    const existing = this.games.find(g => g.manifest.id === manifest.id)
    if (existing !== undefined && existing.builtin && existing.followed !== true) throw new Error(`已经有内置的游戏「${existing.manifest.name}」（${manifest.id}），换一个 id，或者直接用它`)
    const dir = join(this.dir, manifest.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, GAME_MANIFEST_FILE), `# 由 agent 用 game_add 写的游戏包；可以直接改（JSON 也是 YAML）。\n${JSON.stringify(input, null, 2)}\n`)
    if (guide !== undefined && guide.trim() !== '') {
      await writeFile(join(dir, GAME_GUIDE_FILE), `---\nname: game-${manifest.id}\ndescription: ${JSON.stringify(`${manifest.name}的活动和资讯：从哪里看、怎么看。用户问${manifest.name}的活动时使用。`)}\n---\n\n${guide.trim()}\n`)
    }
    await this.loadGames(this.log)
    this.changed(manifest.id)
    if (manifest.sources.some(s => s.smw !== undefined || s.sra !== undefined)) void this.refresh(manifest.id).catch(() => [])
    return this.infos().find(g => g.id === manifest.id)!
  }

  /** The agent looks for where a game's events and news can be read, and adds it (game_add). */
  async discover(name: string): Promise<string> {
    const sessions = this.ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const conversations = sessionConversations(sessions, () => this.ctx.get('adgGateway')?.workspaceDir())
    const sessionId = await conversations.create(`添加游戏：${name}`)
    const known = SRA_GAMES.map(g => `${g.sra}（${g.name}）`).join('、')
    const prompt = [
      `用户想在游戏页看到「${name}」的活动和资讯。先 game_list 看是不是已经有了（名字或别名对得上就告诉用户在哪，不用再加）。没有的话，按技能 web-reading 找它的来源：`,
      `1. SRA 公共 API：已知的游戏 id 有 ${known}。是其中之一就告诉用户在「游戏 → 更多游戏」里勾上即可，不用 game_add。`,
      '2. Wiki：B 站游戏 WIKI（wiki.biligame.com/<缩写>）或官方 / 玩家 Wiki，试它的 api.php?action=ask 能不能查到带开始、结束时间的活动页；能的话写成 smw 来源（conditions、start、end 等属性名照实写，dates 按存法选 date 或 text）。',
      '3. 官网的新闻 / 公告列表页：写成只有 homepage 的来源（agent 读）。',
      '4. 用 game_add 创建游戏包：id 用小写英文和短横线，name 用中文正式名，aliases 写常见简称，timezone 写服务器时区；guide 写几行：哪些来源看什么、公告页怎么找活动。',
      '5. 创建后 game_activities 看读到了什么；只有网页来源的，就按技能读一次公告页，用 game_record（source=site）记下活动。',
      '不要向用户提问；最后告诉用户加了什么来源、哪些能自动读、现在有几个活动。',
    ].join('\n')
    void conversations.ask(sessionId, prompt, AbortSignal.timeout(READ_TIMEOUT_MS)).catch(() => {}).finally(() => this.changed())
    return sessionId
  }

  async readWeb(gameId: string, sourceId?: string): Promise<string> {
    const { manifest } = this.game(gameId)
    const sessions = this.ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const chosen = sourceId === undefined ? manifest.sources.filter(s => s.smw === undefined && s.sra === undefined) : manifest.sources.filter(s => s.id === sourceId)
    if (sourceId !== undefined && chosen.length === 0) throw new Error(`${manifest.name}没有来源「${sourceId}」`)
    const conversations = sessionConversations(sessions, () => this.ctx.get('adgGateway')?.workspaceDir(), (id, f) => this.ctx.get('adgGateway')?.skillScope.setFocus(id, f) ?? Promise.resolve())
    const sessionId = await conversations.create(`游戏资讯：${manifest.name}`, { focus: { games: [manifest.id] } })
    await this.calendar.setReading(`${manifest.id}#web`, { state: 'running', at: this.clock.now(), sessionId })
    this.changed(manifest.id)
    const where = chosen.length === 0
      ? '游戏包里没有写网页来源：按技能 web-reading 的顺序自己找（先 SRA 公共 API 和 Wiki 接口，再官网公告，最后 web_search）。'
      : `要读的来源：${chosen.map(s => `${s.name}${s.homepage === undefined ? '' : `（${s.homepage}）`}`).join('；')}。`
    const prompt = [
      `上网查「${manifest.name}」现在的活动和最新消息（游戏 id：${manifest.id}），按技能 web-reading 和 game-intel：`,
      `1. 先 game_activities（game=${manifest.id}）看日历里已经有什么，不用重复查。`,
      `2. ${where}先读列表页，只打开最近的活动、版本和维护公告。`,
      '3. 每个找到起止时间的活动用 game_record（source=site，写上 url；公告里有这个活动的配图就把图片地址写进 cover）记下；只记有确切出处的时间。',
      '4. 不打开游戏，不向用户提问。最后用两三句话总结：现在有哪些活动、哪些快结束、有什么新消息（新版本、维护、福利）。',
    ].join('\n')
    void conversations.ask(sessionId, prompt, AbortSignal.timeout(READ_TIMEOUT_MS)).then(
      answer => this.calendar.setReading(`${manifest.id}#web`, { state: 'done', at: this.clock.now(), sessionId, summary: answer.slice(0, 400) }),
      error => this.calendar.setReading(`${manifest.id}#web`, { state: 'failed', at: this.clock.now(), sessionId, summary: error instanceof Error ? error.message : String(error) }),
    ).finally(() => this.changed(manifest.id))
    return sessionId
  }

  async read(gameId: string): Promise<string> {
    const { manifest } = this.game(gameId)
    const sessions = this.ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const conversations = sessionConversations(sessions, () => this.ctx.get('adgGateway')?.workspaceDir(), (id, f) => this.ctx.get('adgGateway')?.skillScope.setFocus(id, f) ?? Promise.resolve())
    const sessionId = await conversations.create(`游戏信息：${manifest.name}`, { focus: { games: [manifest.id] } })
    await this.calendar.setReading(manifest.id, { state: 'running', at: this.clock.now(), sessionId })
    this.changed(manifest.id)
    const screen = manifest.screen === undefined ? '游戏画面' : manifest.screen.target === 'emulator' ? '模拟器画面（screen_capture target=emulator）' : `游戏窗口（screen_capture target=window${manifest.screen.window === undefined ? '，先 window_list 找窗口' : `，window=${manifest.screen.window}`}）`
    const prompt = [
      `读取「${manifest.name}」现在的活动和进度（游戏 id：${manifest.id}）。按技能 game-intel 和 game-${manifest.id}（这个游戏的技能；没有的话先用 skill_hub_list 看技能库里有没有，有就告诉用户可以在「技能 → 技能库」下载，这次先按 game-intel 做）：`,
      `1. game_sites_refresh（game=${manifest.id}）拿数据站的活动时间；没有能直接读的数据站就按技能看官网公告并用 game_record（source=site）记下。`,
      `2. 看${screen}。有脚本正在用它，就不要打断，说明原因后结束；游戏没开就用 game_launch（game=${manifest.id}）启动，等它进到主界面（关掉公告和更新提示，启动器要点「开始游戏」就点；要输入账号密码或验证码时停下，告诉用户）。`,
      '3. 按技能里的路线进活动页，只看不花东西；每读完一个活动就 game_record（source=screen）。',
      '4. 读完回到主界面，用一两句话总结哪些活动快结束、还有什么没做。',
      `5. 有始有终：最后用 ask_user_question 问用户要不要把游戏关掉（选项「关掉游戏」「先开着」；游戏是你这次用 game_launch 打开的，就把「关掉游戏」放第一个并标上 (Recommended)）。用户选关掉就用 game_close（game=${manifest.id}），然后告诉用户已经关了。第 2 步因为有脚本在用而结束的，不要问、也不要关。`,
    ].join('\n')
    void conversations.ask(sessionId, prompt, AbortSignal.timeout(READ_TIMEOUT_MS)).then(
      answer => this.calendar.setReading(manifest.id, { state: 'done', at: this.clock.now(), sessionId, summary: answer.slice(0, 400) }),
      error => this.calendar.setReading(manifest.id, { state: 'failed', at: this.clock.now(), sessionId, summary: error instanceof Error ? error.message : String(error) }),
    ).finally(() => this.changed(manifest.id))
    return sessionId
  }

  /**
   * Start the game when it is not running, through the first installed script
   * that plays it (its 「启动游戏」 setting; the emulator is started first).
   * @returns what was done. @throws Error with what is missing, or who is using the screen.
   */
  async launch(gameId: string, signal: AbortSignal): Promise<{ script: string; lines: string[] }> {
    const { manifest } = this.game(gameId)
    const runner = this.ctx.get('adgRunner')?.runner
    if (runner === undefined) throw new Error('运行插件没有加载，不能启动游戏')
    const scripts = this.scriptsOf(manifest.id)
    const script = scripts.find(id => runner.hasPack(id))
    if (script === undefined) throw new Error(`还没有安装玩${manifest.name}的脚本（${scripts.join('、') || '游戏包里没写，也没有认出是玩它的脚本'}），不知道怎么启动它；请用户先打开游戏，或先安装脚本并在脚本页设置「启动游戏」`)
    const lines = await runner.startGame(script, manifest.screen?.target === 'emulator' ? 'emulator' : 'pc', signal)
    return { script, lines }
  }

  /**
   * Close the game (only the game: the emulator stays up), through the first
   * installed script that plays it, the same way `launch` finds it.
   * @returns what was done. @throws Error with what is missing, or who is using the screen.
   */
  async close(gameId: string, signal: AbortSignal): Promise<{ script: string; lines: string[] }> {
    const { manifest } = this.game(gameId)
    const runner = this.ctx.get('adgRunner')?.runner
    if (runner === undefined) throw new Error('运行插件没有加载，不能关闭游戏')
    const script = this.scriptsOf(manifest.id).find(id => runner.hasPack(id))
    if (script === undefined) throw new Error(`还没有安装玩${manifest.name}的脚本，不知道怎么找到它的进程；请用户自己关掉游戏`)
    const lines = await runner.closeGame(script, manifest.screen?.target === 'emulator' ? 'emulator' : 'pc', signal)
    return { script, lines }
  }

  // ── report ──

  preview(): { title: string; text: string } {
    const { title, text } = buildReport(this.reportGames(), this.calendar.list(), this.calendar.settings.report, this.clock.now())
    return { title, text }
  }

  private reportGames(): { id: string; name: string; timezone: string }[] {
    return this.games.map(g => ({ id: g.manifest.id, name: g.manifest.name, timezone: g.manifest.timezone }))
  }

  /**
   * The agent's summary of the recent events (just started, ending soon,
   * starting soon), in a session of its own. @returns undefined when the
   * setting is off, nothing is recent, or the agent cannot (the plain list goes out).
   */
  private async summarize(): Promise<string | undefined> {
    const settings = this.calendar.settings.report
    const sessions = this.ctx.get('sessionController')
    if (!settings.ai || sessions === undefined) return undefined
    const now = this.clock.now()
    const digest = recentDigest(this.reportGames(), this.calendar.list(), settings, now)
    if (digest === undefined) return undefined
    const local = wallClock(now, Intl.DateTimeFormat().resolvedOptions().timeZone)
    const conversations = sessionConversations(sessions, () => this.ctx.get('adgGateway')?.workspaceDir())
    try {
      const sessionId = await conversations.create(`日报：${local.month}月${local.day}日`)
      const prompt = [
        '把下面这些近期的游戏活动写成今天发到飞书的日报正文。只根据给出的内容写，不调用工具，不提问。',
        '要求：中文，按游戏分段（段首用【游戏名】），每个游戏一两句；先说快结束且没做完的（写清剩几天、还差什么），再说刚开始和即将开始的；用户已做完的不用提醒；不用 Markdown 标题、加粗或表格；整篇不超过 12 行。语气、称呼和自称按你的「回复风格」来（没有设定就平实地写）：可以用一句符合风格的话开头，内容照上面的要求，不要客套的结束语。',
        '',
        digest,
      ].join('\n')
      const answer = (await conversations.ask(sessionId, prompt, AbortSignal.timeout(SUMMARY_TIMEOUT_MS))).trim()
      return answer.length === 0 ? undefined : answer
    } catch (error) {
      this.log.warn(`daily report: the agent summary failed, sending the plain list: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }

  /** Send the report to the chat channels. @returns the channels it reached, and what was sent. */
  private async sendReport(day: string): Promise<{ channels: string[]; text: string }> {
    const plain = this.preview()
    const title = plain.title
    const text = (await this.summarize()) ?? plain.text
    let channels: string[] = []
    let result: string
    try {
      channels = await this.ctx.adgNotify.notify.send({ id: `games-report:${day}:${this.clock.now()}`, scope: 'games', title, text, severity: 'info' })
      result = channels.length === 0 ? '没有发出去：还没有设置好的聊天渠道' : `已发到${channels.join('、')}`
    } catch (error) {
      result = `发送失败：${error instanceof Error ? error.message : String(error)}`
    }
    await this.calendar.setReport({ ...this.calendar.report, lastResult: result, ...(channels.length > 0 ? { lastSentAt: this.clock.now(), lastDay: day, lastText: text } : {}) })
    this.changed()
    return { channels, text }
  }
}

/** "news.example.com" for a page's address, without "www.". */
function hostName(url: string): string {
  try { return new URL(url).hostname.replace(/^www\./, '') } catch { return '网页' }
}

/** `name` and `description` from a one-line-per-key frontmatter, and the body. */
function parseFrontmatter(text: string): { name: string; description: string; content: string } | undefined {
  const match = /^﻿?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  const meta = Object.fromEntries(match[1]!.split(/\r?\n/).map(line => /^(\w+):\s*(.*)$/.exec(line)).filter(m => m !== null).map(m => [m[1]!, m[2]!.trim()]))
  if (!meta['name'] || !meta['description']) return undefined
  return { name: meta['name'], description: meta['description'], content: match[2]!.trim() }
}

export default AdgGameIntel
