/**
 * @adg/game-intel — game information (`ctx.adgGameIntel`): Game Packs, an event calendar fed by data sites (read without a
 * model) and by the agent reading the game screen, and a daily report to the
 * chat channels. Contributes the `games@1` capability.
 */
import { createHash } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-tools'
import type { RoleSpec } from '@adg/gateway'
import type {} from '@adg/intervene'
import type {} from '@adg/notify'
import type {} from '@adg/runner'
import type {} from '@adg/script-registry'
import { sessionConversations } from '@adg/notify'
import { GAME_GUIDE_FILE, GAME_MANIFEST_FILE, GameManifest, parseGameManifest } from '@adg/pack-schema'
import { GAMES_CAPABILITY, OWN_IMAGE, SHOT_IMAGE, type Activity, type GameInfo, type GameNotice, type RequestParams, taskMessage } from '@adg/protocol'
import { z } from 'zod'
import { Calendar, type OwnPatch, type ReadEvent, type ReadNotice } from './calendar.ts'
import { readNoticeArticle } from './read-notice.ts'
import { ExeIcons } from '@adg/protocol/node'
import { DailyReport, localDay, realClock, type Clock } from './daily.ts'
import { buildReport, recentDigest } from './report.ts'
import { wallClock } from './time.ts'
import { readSmw, readSra, readSteam, type Fetch, type SiteEvent, type SitePool, type SiteVersion } from './sources.ts'
import { matchScripts } from './script-match.ts'
import { followedId, followedManifest, SRA_GAMES } from './sra-games.ts'
import { gameTools } from './tools.ts'

export { Calendar, DEFAULT_SETTINGS, OWN_FIELDS, type OwnFields, type OwnPatch, type ReadEvent } from './calendar.ts'
export { DailyReport, localDay, realClock, type Clock, type DailyDeps } from './daily.ts'
export { buildReport, recentDigest, type ReportGame } from './report.ts'
export { parseAsk, parseSra, parseSteam, readSmw, readSra, readSteam, readValue, smwQuery, type Fetch, type SiteEvent, type SiteVersion } from './sources.ts'
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
  /**
   * The official Game Packs: the 技能库's downloads (`<dataDir>/skill-hub/skills/game-<id>/game.yaml`,
   * beside the guide the hub registers as a skill). The app ships none; deleting one there removes the game.
   * @default <dataDir>/skill-hub/skills
   */
  gamesDir: z.string().optional(),
})
export type Config = z.input<typeof ConfigSchema>

/** The role agent that reads games and writes the daily report: those sessions are listed under it. */
export const GAME_ROLE: RoleSpec = {
  id: 'games',
  name: '游戏',
  description: '读游戏活动和资讯、写日报、添加游戏',
  order: 20,
  titles: ['游戏信息', '游戏资讯', '添加游戏', '日报'],
  // Games and their screens, and what scripts ran (for the daily report); no installing, runs or pipelines.
  // skill_hub_list: its reading prompt and game_list send it there when a game's skill is missing.
  // browser_*: official sites and wikis that need clicking through (the built-in browser).
  tools: ['game_*', 'screen_*', 'window_*', 'browser_*', 'emulator_status', 'emulator_start', 'script_list', 'script_tasks', 'script_runs', 'skill_hub_list', 'system_info', 'skill_focus', 'skill_save'],
  duty: [
    '# 你的角色：游戏',
    '你是 MultiGameAssistant 的「游戏」agent：读游戏的活动、资讯和进度并记下来（game_record），写日报，添加游戏。',
    '不安装、运行或修脚本，不改流水线和定时；需要这些时交给对应的同事（agent_delegate），或者在回复里说清楚。',
  ].join('\n'),
}

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
  /** Made here (by name on the game page, or by the agent's game_add): taking it off deletes it. */
  readonly own?: boolean
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
  /** Every game pack there is, the ones taken off the game page too (`games` is what the page shows). */
  private allGames: LoadedGame[] = []
  private readonly daily: DailyReport
  private readonly dir: string
  /** Game programs' icons (exe-icon.ts). */
  private readonly icons: ExeIcons
  /** Each game's PC program as found this run (undefined: none). */
  private readonly programs = new Map<string, Promise<string | undefined>>()
  private readonly builtinDir: string
  private readonly log: { warn(message: string): void }

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgGameIntel')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-game-intel')
    this.log = log
    this.dir = join(spec.dataDir, 'games')
    this.builtinDir = spec.gamesDir ?? join(spec.dataDir, 'skill-hub', 'skills')
    this.calendar = new Calendar(this.dir)
    this.icons = new ExeIcons(join(this.dir, 'icons'))
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
      await this.adoptEvidence().catch(error => log.warn(`old screenshots not converted: ${String(error)}`))
      await calendar.rederive(game => this.timezone(game)).catch(error => log.warn(`calendar not worked out again: ${String(error)}`))
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
        if (guide !== undefined) disposers.push(scoped.adgGateway.generalSkill({ ...guide, source: 'bundled' }, () => scoped.skills.register({ ...guide, source: 'bundled' })))
        const web = parseFrontmatter(await readFile(WEB_SKILL, 'utf8'))
        if (web !== undefined) disposers.push(scoped.adgGateway.generalSkill({ ...web, source: 'bundled' }, () => scoped.skills.register({ ...web, source: 'bundled' })))
        for (const game of this.games) {
          if (game.guide === undefined) continue
          const skill = parseFrontmatter(game.guide)
          if (skill === undefined) { log.warn(`game ${game.manifest.id}: GAME.md has no usable frontmatter`); continue }
          try {
            const owner = { games: [game.manifest.id, game.manifest.name] }
            disposers.push(scoped.adgGateway.skillScope.register({ ...skill, source: game.builtin ? 'bundled' : 'custom', path: join(game.dir, GAME_GUIDE_FILE), resourceBase: { kind: 'directory', path: game.dir }, owner, kind: 'game-pack' }))
          } catch (error) {
            log.warn(`game ${game.manifest.id}: skill not registered: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      })().catch(error => log.warn(`game skills not loaded: ${String(error)}`))
      scoped.effect(() => () => { for (const dispose of disposers.splice(0)) dispose() }, 'adg-game-intel skills')
    })

    // ── tools ──
    ctx.inject(['adgGateway'], gateway => gateway.adgGateway.agentPart('adg-game-intel tools', agent => {
      const registered: Array<() => void> = []
      for (const tool of gameTools({
        games: () => this.infos(),
        activities: game => calendar.list(game),
        notices: game => calendar.notices(game),
        recordNotices: async (game, notices) => { await this.ready; return this.recordNotices(game, notices) },
        refresh: async game => { await this.ready; return this.refresh(game) },
        record: async (game, from, events, sessionId, keep) => { await this.ready; return this.record(game, from, events, sessionId, keep) },
        launch: async (game, signal) => { await this.ready; return this.launch(game, signal) },
        close: async (game, signal) => { await this.ready; return this.close(game, signal) },
        report: () => this.preview(),
        sendReport: () => this.sendReport(localDay(this.clock.now())),
        now: () => this.clock.now(),
        add: async (manifest, guide) => { await this.ready; return this.addGame(manifest, guide) },
        saveActivity: async (game, id, patch, image, sessionId) => {
          await this.ready
          // The agent's own screenshot ranks lowest, whoever asked for it: it is no picture of the user's.
          if (image?.trim() === 'screenshot') {
            const shot = await this.imageFrom(image, sessionId)
            return this.saveAgentShot(await this.saveActivity(game, id, patch), shot, sessionId)
          }
          return this.saveActivity(game, id, patch, image === undefined ? undefined : await this.imageFrom(image, sessionId))
        },
        chooseSource: async (id, source) => {
          await this.ready
          return this.chooseSource(id, source)
        },
        removeActivity: async (id, what) => {
          await this.ready
          if (what === 'mine') return this.resetActivity(id)
          if (!(await this.removeActivity(id))) throw new Error('没有这个活动（可能已经结束被清掉了）')
          return undefined
        },
      })) registered.push(agent.tools.register({ ...tool, execute: async (args, exec) => { await ctx.get('adgGateway')?.guardTool(exec); return tool.execute(args, exec) } })) // 设置 → 权限 (guardTool)
      return () => { for (const dispose of registered) dispose() }
    }))

    // ── capability ──
    ctx.inject(['adgGateway'], scoped => {
      scoped.effect(() => scoped.adgGateway.role(GAME_ROLE), 'adg-game-intel role')
      scoped.adgGateway.register({
        id: GAMES_CAPABILITY,
        version: 1,
        methods: {
          'games/list': async () => {
            await this.ready
            await this.loadGames(log)
            // The events of the games on the page only (one taken off or deleted shows none).
            const shown = new Set(this.games.map(g => g.manifest.id))
            return { games: this.infos(), activities: calendar.list().filter(a => shown.has(a.game)), notices: calendar.notices().filter(n => shown.has(n.game)), settings: calendar.settings, report: { ...calendar.report, ...(this.daily.next() === undefined ? {} : { next: this.daily.next() }) } }
          },
          'games/notice/detail': async params => {
            await this.ready
            const { game, noticeId } = params as RequestParams<'games/notice/detail'>
            const { manifest } = this.game(game)
            const notice = calendar.noticeDetail(game, noticeId)
            if (notice.article?.length) return notice
            const article = await readNoticeArticle(notice, manifest, this.fetch)
            return calendar.saveArticle(game, noticeId, article)
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
            await this.ready
            const id = (params as RequestParams<'games/evidence'>).activityId
            const screen = calendar.get(id)?.screen
            if (screen?.evidence !== true) throw new Error('这个活动没有保存截图')
            if (screen.image !== undefined) return this.picture(screen.image)
            return { mediaType: 'image/png', data: (await readFile(this.evidenceFile(id))).toString('base64') }
          },
          'games/icon': async (params, call) => {
            await this.ready
            const icon = await this.icon((params as RequestParams<'games/icon'>).game, call.signal)
            return icon === null ? {} : { icon }
          },
          'games/image': async params => {
            await this.ready
            return this.picture((params as RequestParams<'games/image'>).url)
          },
          'games/banner/set': async params => {
            await this.ready
            const p = params as RequestParams<'games/banner/set'>
            const image = p.image !== undefined ? Buffer.from(p.image.data, 'base64') : p.path !== undefined ? await this.imageFile(p.path) : undefined
            const banner = await this.setBanner(p.game, image)
            return banner === undefined ? {} : { banner }
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
            return { sessionId: await this.discover((params as RequestParams<'games/discover'>).game) }
          },
          'games/create': async params => {
            await this.ready
            return { game: await this.createGame((params as RequestParams<'games/create'>).name) }
          },
          'games/remove': async params => {
            await this.ready
            await this.removeGame((params as RequestParams<'games/remove'>).game)
            return {}
          },
          'games/catalog': async () => {
            await this.ready
            // A game pack may have come or gone with the 技能库 since.
            await this.loadGames(log)
            // Ticked: on the game page, followed or through a game pack that reads it.
            return {
              games: SRA_GAMES.map(g => {
                const shown = this.games.find(l => l.manifest.sources.some(s => s.sra?.game === g.sra))
                const pack = shown === undefined || shown.followed === true ? undefined : shown.manifest.id
                return { sra: g.sra, name: g.name, followed: shown !== undefined, ...(pack === undefined ? {} : { pack }) }
              }),
            }
          },
          'games/follow': async params => {
            await this.ready
            const { sra, follow } = params as RequestParams<'games/follow'>
            if (!SRA_GAMES.some(g => g.sra === sra)) throw new Error(`SRA 公共 API 没有游戏 ${sra}`)
            await this.showSra(sra, follow)
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
            await this.removeActivity((params as RequestParams<'games/activity/remove'>).activityId)
            return {}
          },
          'games/activity/save': async params => {
            await this.ready
            const { game, activityId, image, todo, ...fields } = params as RequestParams<'games/activity/save'>
            return this.saveActivity(game, activityId, { ...fields, ...(todo === undefined ? {} : { todo }) }, image === undefined ? undefined : Buffer.from(image.data, 'base64'))
          },
          'games/activity/source': async params => {
            await this.ready
            const { activityId, source } = params as RequestParams<'games/activity/source'>
            return this.chooseSource(activityId, source)
          },
          'games/activity/reset': async params => {
            await this.ready
            const activity = await this.resetActivity((params as RequestParams<'games/activity/reset'>).activityId)
            return activity === undefined ? {} : { activity }
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
    if (OWN_IMAGE.test(url) || SHOT_IMAGE.test(url)) {
      const [kind, file] = url.split(':') as ['own' | 'shot', string]
      const mediaType = IMAGE_TYPES.find(([ext]) => file.endsWith(`.${ext}`))![1]
      const bytes = await readFile(join(this.imageDir(kind), file)).catch(() => { throw new Error('这张图片已经不在了') })
      return { mediaType, data: bytes.toString('base64') }
    }
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
          // The user's pack replaces an official one of the same id.
          found.set(manifest.id, { manifest, dir, builtin, ...(builtin ? {} : { own: true }), ...(guide === undefined ? {} : { guide }) })
        } catch (error) {
          log.warn(`game pack ${id}: ${error instanceof Error ? error.message : String(error)}`)
        }
      }
    }
    // Game packs the user took off the game page: still installed (their skills too), not shown.
    this.allGames = [...found.values()]
    for (const id of this.calendar.settings.hidden ?? []) found.delete(id)
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

  // ── the user's own events ──

  /**
   * Add an event of the user's own, or write their word on one (see
   * `Calendar.saveOwn`); `image`: a new picture, kept under
   * `<data>/games/images/own/`. @throws Error with what is wrong.
   */
  async saveActivity(gameId: string, activityId: string | undefined, patch: OwnPatch, image?: Buffer): Promise<Activity> {
    const { manifest } = this.game(gameId)
    if (activityId !== undefined && this.calendar.get(activityId)?.game !== manifest.id) throw new Error(`${manifest.name}没有活动「${activityId}」（可能已经结束被清掉了；game_activities 可查）`)
    const cover = image === undefined ? patch.cover : await this.keepImage(image)
    const activity = await this.calendar.saveOwn({ game: manifest.id, id: activityId }, { ...patch, ...(cover === undefined ? {} : { cover }) }, this.clock.now(), manifest.timezone)
    await this.sweepImages()
    this.changed(manifest.id)
    if (activity === undefined) throw new Error('什么都没留下：这个活动只有你填的内容，清空后就从日历去掉了')
    return activity
  }

  /**
   * The picture the user picked for a game's banner, kept under
   * `<data>/games/images/own/`; undefined: the version's art again (the old
   * picture is let go). @returns its address (`own:<hash>.<ext>`).
   */
  async setBanner(gameId: string, image: Buffer | undefined): Promise<string | undefined> {
    const { manifest } = this.game(gameId)
    const banner = image === undefined ? undefined : await this.keepImage(image)
    await this.calendar.setBanner(manifest.id, banner)
    await this.sweepImages()
    this.changed(manifest.id)
    return banner
  }

  /** A picture file the user picked in a file dialog on this computer. @throws Error when it is not one, or too big. */
  private async imageFile(path: string): Promise<Buffer> {
    const full = path.replace(/^"|"$/g, '')
    if (!isAbsolute(full)) throw new Error('图片路径要是完整路径')
    const info = await stat(full).catch(() => undefined)
    if (info === undefined || !info.isFile()) throw new Error(`找不到图片文件：${full}`)
    if (info.size > MAX_IMAGE_BYTES) throw new Error('图片太大（最多 8 MB）')
    return readFile(full)
  }

  private timezone(game: string): string {
    return this.games.find(g => g.manifest.id === game)?.manifest.timezone ?? 'Asia/Shanghai'
  }

  /** Keep the agent's screenshot of an event as what it read from the screen: the lowest rank of picture. */
  private async saveAgentShot(saved: Activity, bytes: Buffer, sessionId: string | undefined): Promise<Activity> {
    const shot = await this.keepImage(bytes, 'shot')
    const activity = await this.calendar.setShot(saved.id, shot, { now: this.clock.now(), timeZone: this.timezone(saved.game), sessionId })
    await this.sweepImages()
    this.changed(saved.game)
    return activity ?? saved
  }

  /** Which source an event's picture and dates come from; `null`: the default order. */
  async chooseSource(activityId: string, source: string | null): Promise<Activity> {
    const before = this.calendar.get(activityId)
    if (before === undefined) throw new Error('没有这个活动（可能已经结束被清掉了）')
    const activity = await this.calendar.chooseSource(activityId, source, this.timezone(before.game))
    if (activity === undefined) throw new Error('没有这个活动（可能已经结束被清掉了）')
    this.changed(before.game)
    return activity
  }

  /** Take back what the user wrote on an event. @returns it as it is now; undefined when it went. */
  async resetActivity(activityId: string): Promise<Activity | undefined> {
    const before = this.calendar.get(activityId)
    if (before === undefined) throw new Error('没有这个活动（可能已经结束被清掉了）')
    const activity = await this.calendar.resetOwn(activityId, this.timezone(before.game))
    await this.sweepImages()
    this.changed(before.game)
    return activity
  }

  async removeActivity(activityId: string): Promise<boolean> {
    const removed = await this.calendar.remove(activityId)
    await this.sweepImages()
    this.changed()
    return removed
  }

  /**
   * A picture for an event, as the agent names it: an http(s) address (fetched
   * now and kept, so it stays when the page goes), a file on this computer
   * (a path relative to the workspace is fine), or `screenshot`, the last
   * screenshot of this conversation.
   */
  async imageFrom(source: string, sessionId: string | undefined): Promise<Buffer> {
    const from = source.trim()
    if (from === 'screenshot') {
      const shot = sessionId === undefined ? undefined : this.ctx.get('adgIntervene')?.lastShot(sessionId)
      if (shot === undefined) throw new Error('这个对话还没有截图：先用 screen_capture 截一张')
      return shot
    }
    if (/^https?:\/\//i.test(from)) {
      const response = await fetch(from, { signal: AbortSignal.timeout(20_000), headers: { accept: 'image/*', 'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) MultiGameAssistant' } })
      if (!response.ok) throw new Error(`图片读不到：HTTP ${response.status}`)
      return Buffer.from(await response.arrayBuffer())
    }
    const path = from.replace(/^file:\/\/\/?/i, '')
    const workspace = this.ctx.get('adgGateway')?.workspaceDir()
    const full = isAbsolute(path) || workspace === undefined ? path : resolve(workspace, path)
    return readFile(full).catch(() => { throw new Error(`读不到图片文件：${full}`) })
  }

  /**
   * Keep a picture the user added (`own`) or a screenshot an event was read
   * from (`shot`), named by its content. @returns its address (`own:<hash>.<ext>`).
   */
  private async keepImage(bytes: Buffer, kind: 'own' | 'shot' = 'own'): Promise<string> {
    if (kind === 'own' && bytes.length > MAX_IMAGE_BYTES) throw new Error('图片太大（最多 8 MB）')
    const ext = imageType(bytes)
    if (ext === undefined) throw new Error('不是支持的图片（png、jpg、gif、webp、avif）')
    const file = `${createHash('sha256').update(bytes).digest('hex').slice(0, 32)}.${ext}`
    const dir = this.imageDir(kind)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, file), bytes)
    return `${kind}:${file}`
  }

  private imageDir(kind: 'own' | 'shot'): string {
    return join(this.dir, 'images', kind === 'own' ? 'own' : 'shots')
  }

  /** Pictures the user added, and screenshots, that no event has any more. */
  private async sweepImages(): Promise<void> {
    for (const [kind, used] of [['own', this.calendar.ownImages()], ['shot', this.calendar.shotImages()]] as const) {
      const dir = this.imageDir(kind)
      const files = await readdir(dir).catch(() => [] as string[])
      await Promise.all(files.filter(f => !used.has(`${kind}:${f}`)).map(f => rm(join(dir, f), { force: true }).catch(() => {})))
    }
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

  /** A game's program icon, for its avatar; null when it has no PC program this app knows of. */
  private async icon(gameId: string, signal: AbortSignal): Promise<{ mediaType: string; data: string } | null> {
    const program = await this.program(gameId)
    if (program === undefined) return null
    try {
      return { mediaType: 'image/png', data: (await this.icons.png(program, signal)).toString('base64') }
    } catch (e) {
      this.log.warn(`games: no icon for ${gameId} (${program}): ${e instanceof Error ? e.message : String(e)}`)
      return null
    }
  }

  /**
   * Where a game's PC program is: the one a script that plays it starts (its
   * saved 游戏位置), else where 自动查找 finds the program the packs that play
   * it name (installed or not), looked for once a run.
   */
  private async program(gameId: string): Promise<string | undefined> {
    const runner = this.ctx.get('adgRunner')?.runner
    if (runner === undefined || process.platform !== 'win32') return undefined
    const scripts = this.scriptsOf(gameId)
    // A saved 游戏位置 is read every time: one saved a moment ago counts at once.
    for (const id of scripts) {
      const exe = (await runner.launch.get(id).catch(() => undefined))?.pcExe
      if (exe !== undefined && existsSync(exe)) return exe
    }
    // The search, once a while: it reads the registry and the disk.
    let search = this.programs.get(gameId)
    if (search === undefined) {
      search = this.searchProgram(gameId, scripts)
      this.programs.set(gameId, search)
      void search.then(path => { if (path === undefined) setTimeout(() => this.programs.delete(gameId), 2 * 60_000).unref?.() })
    }
    const path = await search
    if (path !== undefined && !existsSync(path)) { this.programs.delete(gameId); return undefined }
    return path
  }

  /** Where 自动查找 finds the program the packs that play a game name (installed or not), with the game's names to look for. */
  private async searchProgram(gameId: string, scripts: readonly string[]): Promise<string | undefined> {
    const runner = this.ctx.get('adgRunner')?.runner
    if (runner === undefined) return undefined
    const { manifest } = this.game(gameId)
    const library = this.ctx.get('adgScripts')?.library
    for (const id of scripts) {
      let pack
      try { pack = library?.packOf(id) } catch { pack = undefined }
      const game = (pack ?? library?.pack(id))?.manifest.game
      if (game?.pc?.process === undefined) continue
      const found = await runner.findGameProgram(game, [manifest.name, ...manifest.aliases]).catch(() => undefined)
      if (found !== undefined) return found
    }
    return undefined
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
    return this.games.map(({ manifest: m, builtin, followed, own }) => {
      const sra = m.sources.map(s => s.sra?.game).filter((id): id is string => id !== undefined)
      const refreshed = this.calendar.refreshed(m.id)
      const reading = this.calendar.reading(m.id)
      const webReading = this.calendar.reading(`${m.id}#web`)
      const version = this.calendar.version(m.id)
      const pools = this.calendar.pools(m.id, this.clock.now())
      const banner = this.calendar.banner(m.id)
      return {
        id: m.id, name: m.name, aliases: m.aliases, scripts: scripts.get(m.id) ?? m.scripts, timezone: m.timezone,
        ...(m.screen === undefined ? {} : { screen: { target: m.screen.target, ...(m.screen.window === undefined ? {} : { window: m.screen.window }) } }),
        sources: m.sources.map(s => ({ id: s.id, name: s.name, ...(s.homepage === undefined ? {} : { homepage: s.homepage }), auto: s.smw !== undefined || s.sra !== undefined || s.steam !== undefined, ...(/^link-\d+$/.test(s.id) && this.calendar.links(m.id).some(l => l.id === s.id) ? { added: true } : {}) })),
        builtin,
        ...(m.art === undefined ? {} : { art: m.art }),
        ...(banner === undefined ? {} : { banner }),
        ...(followed === true ? { followed: true } : {}),
        ...(sra.length === 0 ? {} : { sra }),
        ...(own === true ? { own: true } : {}),
        ...(m.single === true ? { single: true } : {}),
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
  async refresh(gameId?: string): Promise<Array<{ game: string; ok: boolean; count: number; notices?: number; detail?: string }>> {
    const games = gameId === undefined ? this.games : [this.game(gameId)]
    const results: Array<{ game: string; ok: boolean; count: number; notices?: number; detail?: string }> = []
    for (const { manifest } of games) {
      const sources = manifest.sources.filter(s => s.smw !== undefined || s.sra !== undefined || s.steam !== undefined)
      if (sources.length === 0) {
        const where = manifest.sources.map(s => s.homepage).filter(Boolean).join(' 或 ') || '官网公告'
        results.push({ game: manifest.id, ok: false, count: 0, detail: manifest.single === true
          ? `没有能直接读的公告来源：用 web_fetch 看 ${where}，版本更新和公告用 game_notice 记下`
          : `没有能直接读的数据站：用 web_fetch（只拿到空壳时用内置浏览器）看 ${where}，再用 game_record（source=site）记下` })
        continue
      }
      const failures: string[] = []
      let count = 0
      let notices = 0
      let version: ({ source: string } & SiteVersion) | undefined
      let pools: SitePool[] | undefined
      for (const source of sources) {
        const now = this.clock.now()
        try {
          // Announcements (Steam's news): kept beside the events, no dates to put on the calendar.
          if (source.steam !== undefined) {
            notices += (await this.calendar.applyNotices(manifest.id, { id: source.id, name: source.name }, await readSteam(source.steam, this.fetch), now)).length
            continue
          }
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
      if (failures.length > 0 && count + notices === 0) await this.calendar.refreshFailed(manifest.id, failures.join('；'), this.clock.now())
      else await this.calendar.refreshDone(manifest.id, this.calendar.list(manifest.id).filter(a => a.sources?.some(s => !s.web) === true).length, this.clock.now(), version, pools)
      results.push({ game: manifest.id, ok: failures.length === 0 || count + notices > 0, count, ...(notices === 0 ? {} : { notices }), ...(failures.length === 0 ? {} : { detail: failures.join('；') }) })
      this.changed(manifest.id)
    }
    // Events that ended went with their screenshots and pictures.
    await this.sweepImages()
    return results
  }

  // ── what the agent read ──

  /** Announcements the agent read (game_notice), each credited to the site it came from. */
  async recordNotices(gameId: string, notices: readonly ReadNotice[]): Promise<GameNotice[]> {
    this.game(gameId)
    const kept: GameNotice[] = []
    for (const notice of notices) {
      const host = notice.url !== undefined && URL.canParse(notice.url) ? hostName(notice.url) : undefined
      kept.push(...await this.calendar.applyNotices(gameId, { id: 'agent', name: host === undefined ? 'agent 查到' : `${host}（agent 查到）` }, [notice], this.clock.now()))
    }
    this.changed(gameId)
    return kept
  }

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
    // The screenshot is the evidence, and the picture of every event read from it that has none.
    const kept = shot === undefined ? undefined : await this.keepImage(shot, 'shot').catch(error => {
      this.log.warn(`screenshot not kept: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    })
    const written = await this.calendar.applyRead(gameId, from, credited, { now: this.clock.now(), timeZone: manifest.timezone, sessionId, shot: kept })
    await this.sweepImages()
    this.changed(gameId)
    return written
  }

  /**
   * Screenshots kept before they were pictures: one file per event under
   * `evidence/`. Each becomes a `shot:` picture (and its event's background).
   */
  private async adoptEvidence(): Promise<void> {
    const shots = new Map<string, string>()
    for (const a of this.calendar.list()) {
      if (a.screen?.evidence !== true || a.screen.image !== undefined) continue
      const file = this.evidenceFile(a.id)
      const bytes = await readFile(file).catch(() => undefined)
      if (bytes === undefined) continue
      const kept = await this.keepImage(bytes, 'shot').catch(() => undefined)
      if (kept === undefined) continue
      shots.set(a.id, kept)
      await rm(file, { force: true }).catch(() => {})
    }
    await this.calendar.adoptShots(shots, game => this.games.find(g => g.manifest.id === game)?.manifest.timezone ?? 'Asia/Shanghai')
  }

  /** Where a screenshot was kept before `shot:` pictures. */
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
    if (existing !== undefined && existing.builtin && existing.followed !== true) throw new Error(`已经有技能库的游戏包「${existing.manifest.name}」（${manifest.id}），换一个 id，或者直接用它`)
    const dir = join(this.dir, manifest.id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, GAME_MANIFEST_FILE), `# 由 agent 用 game_add 写的游戏包；可以直接改（JSON 也是 YAML）。\n${JSON.stringify(input, null, 2)}\n`)
    if (guide !== undefined && guide.trim() !== '') {
      await writeFile(join(dir, GAME_GUIDE_FILE), `---\nname: game-${manifest.id}\ndescription: ${JSON.stringify(`${manifest.name}的活动和资讯：从哪里看、怎么看。用户问${manifest.name}的活动时使用。`)}\n---\n\n${guide.trim()}\n`)
    }
    if (this.calendar.settings.hidden?.includes(manifest.id) === true) await this.calendar.hide(manifest.id, false)
    await this.loadGames(this.log)
    this.changed(manifest.id)
    if (manifest.sources.some(s => s.smw !== undefined || s.sra !== undefined)) void this.refresh(manifest.id).catch(() => [])
    return this.infos().find(g => g.id === manifest.id)!
  }

  // ── which games are on the page (apart from the 技能库's packs) ──

  /**
   * Show an SRA game, or stop: a game pack that reads it (from the 技能库 or
   * made here) is shown or taken off with it, the pack staying installed;
   * without one the API is followed. @returns the game's id on the page.
   */
  private async showSra(sra: string, show: boolean): Promise<string> {
    const packs = this.allGames.filter(g => g.manifest.sources.some(s => s.sra?.game === sra))
    for (const pack of packs) await this.calendar.hide(pack.manifest.id, !show)
    await this.calendar.follow(sra, show && packs.length === 0, followedId(sra))
    await this.loadGames(this.log)
    this.changed()
    const id = packs[0]?.manifest.id ?? followedId(sra)
    // Its events, now rather than tomorrow morning.
    if (show && this.games.some(g => g.manifest.id === id)) void this.refresh(id).catch(() => [])
    return id
  }

  /**
   * Put a game on the page by its name: one there already is it; one taken
   * off comes back; one the SRA public API knows is followed; any other is
   * made here, empty (no sources yet), for the agent to find its sources from
   * its page. No pack is downloaded: the page offers the 技能库's for it.
   * @returns its id.
   */
  async createGame(name: string): Promise<string> {
    const wanted = name.trim()
    if (wanted === '') throw new Error('写一个游戏名')
    const key = wanted.toLowerCase()
    await this.loadGames(this.log)
    const named = (g: LoadedGame) => [g.manifest.id, g.manifest.name, ...g.manifest.aliases].some(n => n.toLowerCase() === key)
    const shown = this.games.find(named)
    if (shown !== undefined) return shown.manifest.id
    const away = this.allGames.find(named)
    if (away !== undefined) {
      await this.calendar.hide(away.manifest.id, false)
      await this.loadGames(this.log)
      this.changed(away.manifest.id)
      return away.manifest.id
    }
    const sra = SRA_GAMES.find(g => g.sra === key || g.name.toLowerCase() === key || g.words.some(w => w.toLowerCase() === key))
    if (sra !== undefined) return this.showSra(sra.sra, true)
    const id = await this.freeId(wanted)
    const dir = join(this.dir, id)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, GAME_MANIFEST_FILE), `# 在游戏页按名字添加的游戏：来源由 agent 找（游戏页上的「让 agent 去找」），也可以直接改（JSON 也是 YAML）。\n${JSON.stringify({ id, name: wanted, sources: [] }, null, 2)}\n`)
    await this.loadGames(this.log)
    this.changed(id)
    return id
  }

  /** An id for a game made by name: its letters and digits, else a short fingerprint of the name; not one in use. */
  private async freeId(name: string): Promise<string> {
    const slug = name.normalize('NFKD').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '')
    const base = slug.length >= 2 ? slug.slice(0, 40).replace(/-+$/, '') : `game-${createHash('sha256').update(name).digest('hex').slice(0, 8)}`
    const taken = new Set([
      ...this.allGames.map(g => g.manifest.id),
      ...SRA_GAMES.map(g => followedId(g.sra)),
      // Folders the plugin keeps beside the packs.
      'images', 'evidence', 'icons',
      ...await readdir(this.dir).catch(() => [] as string[]),
    ])
    for (let n = 1; ; n++) {
      const id = n === 1 ? base : `${base}-${n}`
      if (!taken.has(id)) return id
    }
  }

  /**
   * Take a game off the page: an SRA game is no longer followed, a game pack
   * from the 技能库 is hidden (it stays installed, with its skills), one made
   * here is deleted with its events.
   */
  async removeGame(gameId: string): Promise<void> {
    await this.loadGames(this.log)
    const game = this.game(gameId)
    const sras = game.manifest.sources.map(s => s.sra?.game).filter((s): s is string => s !== undefined)
    if (game.followed === true) {
      for (const sra of sras) await this.calendar.follow(sra, false, gameId)
    } else if (game.own === true) {
      await rm(game.dir, { recursive: true, force: true })
      await this.calendar.forget(gameId)
    } else {
      await this.calendar.hide(gameId, true)
    }
    // Nor followed through the API it reads: it would come back as that.
    for (const sra of sras) if (this.calendar.settings.followed.includes(sra)) await this.calendar.follow(sra, false, followedId(sra))
    await this.loadGames(this.log)
    // One made here over an official pack of the same id: that one is not shown either.
    if (this.games.some(g => g.manifest.id === gameId)) {
      await this.calendar.hide(gameId, true)
      await this.loadGames(this.log)
    }
    this.changed()
  }

  /**
   * The agent finds where a game on the page can be read (one added by name
   * has no sources yet) and writes them into its game pack (game_add, the same
   * id), from the game's page, which shows it working (its web reading). An
   * official pack is not rewritten: the agent reads the web for it instead.
   */
  async discover(gameId: string): Promise<string> {
    const game = this.game(gameId)
    if (game.builtin && game.followed !== true) return this.readWeb(gameId)
    const { manifest } = game
    const sessions = this.ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const conversations = sessionConversations(sessions, () => this.ctx.get('adgGateway')?.workspaceDir(), (id, f) => this.ctx.get('adgGateway')?.skillScope.setFocus(id, f) ?? Promise.resolve(), () => this.ctx.get('adgGateway'))
    const sessionId = await conversations.home(GAME_ROLE.id, { focus: { games: [manifest.id] } })
    await this.calendar.setReading(`${manifest.id}#web`, { state: 'running', at: this.clock.now(), sessionId })
    this.changed(manifest.id)
    const known = SRA_GAMES.map(g => `${g.sra}（${g.name}）`).join('、')
    const has = manifest.sources.length === 0 ? '还没有任何来源' : `现在的来源：${manifest.sources.map(s => s.name).join('、')}`
    const prompt = [
      `游戏页上有「${manifest.name}」（游戏 id：${manifest.id}），${has}。按技能 web-reading 找能读到它活动和资讯的来源，写进它的游戏包：`,
      `1. SRA 公共 API：已知的游戏 id 有 ${known}。它是其中之一，就写一个 sra 来源：{ "id": "sra", "name": "SRA 公共 API", "sra": { "game": "<那个 id>" } }。`,
      '2. Wiki：B 站游戏 WIKI（wiki.biligame.com/<缩写>）或官方 / 玩家 Wiki，试它的 api.php?action=ask 能不能查到带开始、结束时间的活动页；能的话写成 smw 来源（conditions、start、end 等属性名照实写，dates 按存法选 date 或 text）。',
      '3. 官网的新闻 / 公告列表页：写成只有 homepage 的来源（agent 读）。',
      '   单机游戏（买断制、没有限时活动的）：在 Steam 上有的，再写一个 Steam 来源（steam_appid 是商店页 store.steampowered.com/app/<数字> 里的数字），插件每天自动读它在 Steam 的官方公告（版本更新、补丁说明）；game_add 时写 single=true。',
      `4. 用 game_add 写它的游戏包：id 一定用 ${manifest.id}（换了 id 游戏页上就成了另一个游戏），name 用它的中文正式名（用户写的名字是「${manifest.name}」），aliases 写常见简称，timezone 写服务器时区，sources 写找到的（原来有的保留）；guide 写几行：哪些来源看什么、公告页怎么找活动。`,
      '5. 写好后 game_activities 看读到了什么；只有网页来源的，就按技能读一次公告页，用 game_record（source=site）记下活动。单机游戏读一次官方的更新日志，用 game_notice 记下最近的版本更新和长期公告。',
      '6. 找不到这个游戏（名字不对、没有公开的活动信息）就不要 game_add，直接说明找了哪里、为什么没找到。',
      '不要向用户提问；最后告诉用户加了什么来源、哪些能自动读、现在有几个活动。',
    ].join('\n')
    void conversations.ask(sessionId, taskMessage('你', `找活动来源：${manifest.name}`, prompt), AbortSignal.timeout(READ_TIMEOUT_MS)).then(
      answer => this.calendar.setReading(`${manifest.id}#web`, { state: 'done', at: this.clock.now(), sessionId, summary: answer.slice(0, 400) }),
      error => this.calendar.setReading(`${manifest.id}#web`, { state: 'failed', at: this.clock.now(), sessionId, summary: error instanceof Error ? error.message : String(error) }),
    ).finally(() => this.changed(manifest.id))
    return sessionId
  }

  async readWeb(gameId: string, sourceId?: string): Promise<string> {
    const { manifest } = this.game(gameId)
    const sessions = this.ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const chosen = sourceId === undefined ? manifest.sources.filter(s => s.smw === undefined && s.sra === undefined) : manifest.sources.filter(s => s.id === sourceId)
    if (sourceId !== undefined && chosen.length === 0) throw new Error(`${manifest.name}没有来源「${sourceId}」`)
    const conversations = sessionConversations(sessions, () => this.ctx.get('adgGateway')?.workspaceDir(), (id, f) => this.ctx.get('adgGateway')?.skillScope.setFocus(id, f) ?? Promise.resolve(), () => this.ctx.get('adgGateway'))
    const sessionId = await conversations.home(GAME_ROLE.id, { focus: { games: [manifest.id] } })
    await this.calendar.setReading(`${manifest.id}#web`, { state: 'running', at: this.clock.now(), sessionId })
    this.changed(manifest.id)
    const where = chosen.length === 0
      ? '游戏包里没有写网页来源：按技能 web-reading 的顺序自己找（先 SRA 公共 API 和 Wiki 接口，再官网公告，最后 web_search）。'
      : `要读的来源：${chosen.map(s => `${s.name}${s.homepage === undefined ? '' : `（${s.homepage}）`}`).join('；')}。`
    const prompt = (manifest.single === true ? [
      `上网查单机游戏「${manifest.name}」最近的官方公告（游戏 id：${manifest.id}），按技能 web-reading 和 game-intel：`,
      `1. 先 game_activities（game=${manifest.id}）看已经记了哪些公告，不用重复记。`,
      `2. ${where}看官方的更新日志或公告列表（Steam 新闻、官网博客、公告页），只打开最近的几篇。`,
      '3. 版本更新、补丁说明用 game_notice 记下（kind=update，写上版本号、发布日期、一两句改了什么和网址；有配图就写进 cover）；长期有效的公告 kind=notice、lasting=true；其他资讯 kind=news。单机游戏一般没有限时活动，真有（限时折扣、联动、节日活动）才用 game_record。',
      '4. 不打开游戏，不向用户提问。最后用两三句话总结：最新版本是什么、改了什么、有没有要注意的公告。',
    ] : [
      `上网查「${manifest.name}」现在的活动和最新消息（游戏 id：${manifest.id}），按技能 web-reading 和 game-intel：`,
      `1. 先 game_activities（game=${manifest.id}）看日历里已经有什么，不用重复查。`,
      `2. ${where}先读列表页，只打开最近的活动、版本和维护公告。`,
      '3. 每个找到起止时间的活动用 game_record（source=site，写上 url；公告里有这个活动的配图就把图片地址写进 cover）记下；只记有确切出处的时间。版本更新公告和长期有效的公告（没有结束时间的）用 game_notice 记下（kind=update 或 notice，长期的写 lasting=true）。',
      '4. 不打开游戏，不向用户提问。最后用两三句话总结：现在有哪些活动、哪些快结束、有什么新消息（新版本、维护、福利）。',
    ]).join('\n')
    void conversations.ask(sessionId, taskMessage('你', `游戏资讯：${manifest.name}`, prompt), AbortSignal.timeout(READ_TIMEOUT_MS)).then(
      answer => this.calendar.setReading(`${manifest.id}#web`, { state: 'done', at: this.clock.now(), sessionId, summary: answer.slice(0, 400) }),
      error => this.calendar.setReading(`${manifest.id}#web`, { state: 'failed', at: this.clock.now(), sessionId, summary: error instanceof Error ? error.message : String(error) }),
    ).finally(() => this.changed(manifest.id))
    return sessionId
  }

  async read(gameId: string): Promise<string> {
    const { manifest } = this.game(gameId)
    const sessions = this.ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const conversations = sessionConversations(sessions, () => this.ctx.get('adgGateway')?.workspaceDir(), (id, f) => this.ctx.get('adgGateway')?.skillScope.setFocus(id, f) ?? Promise.resolve(), () => this.ctx.get('adgGateway'))
    const sessionId = await conversations.home(GAME_ROLE.id, { focus: { games: [manifest.id] } })
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
    void conversations.ask(sessionId, taskMessage('你', `游戏信息：${manifest.name}`, prompt), AbortSignal.timeout(READ_TIMEOUT_MS)).then(
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
    const conversations = sessionConversations(sessions, () => this.ctx.get('adgGateway')?.workspaceDir(), undefined, () => this.ctx.get('adgGateway'))
    try {
      const sessionId = await conversations.home(GAME_ROLE.id)
      const prompt = [
        '把下面这些近期的游戏活动写成今天发到飞书的日报正文。只根据给出的内容写，不调用工具，不提问。',
        '要求：中文，按游戏分段（段首用【游戏名】），每个游戏一两句；先说快结束且没做完的（写清剩几天、还差什么），再说刚开始和即将开始的；用户已做完的不用提醒；不用 Markdown 标题、加粗或表格；整篇不超过 12 行。语气、称呼和自称按你的「回复风格」来（没有设定就平实地写）：可以用一句符合风格的话开头，内容照上面的要求，不要客套的结束语。',
        '',
        digest,
      ].join('\n')
      const answer = (await conversations.ask(sessionId, taskMessage('定时', `日报：${local.month}月${local.day}日`, prompt), AbortSignal.timeout(SUMMARY_TIMEOUT_MS))).trim()
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

/** The picture's type from its first bytes (not what a name or header claims). @returns its extension. */
export function imageType(bytes: Uint8Array): 'png' | 'jpg' | 'gif' | 'webp' | 'avif' | undefined {
  const ascii = (from: number, to: number) => String.fromCharCode(...bytes.subarray(from, to))
  if (bytes[0] === 0x89 && ascii(1, 4) === 'PNG') return 'png'
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (ascii(0, 4) === 'GIF8') return 'gif'
  if (ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'webp'
  if (ascii(4, 8) === 'ftyp' && /^avi[fs]$/.test(ascii(8, 12))) return 'avif'
  return undefined
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
