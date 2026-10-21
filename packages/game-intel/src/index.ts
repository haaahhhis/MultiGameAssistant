/**
 * @adg/game-intel — game information (`ctx.adgGameIntel`, docs/PLAN.zh.md
 * §5.5): Game Packs, an event calendar fed by data sites (read without a
 * model) and by the agent reading the game screen, and a daily report to the
 * chat channels. Contributes the `games@1` capability.
 */
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
import { sessionConversations } from '@adg/notify'
import { GAME_GUIDE_FILE, GAME_MANIFEST_FILE, parseGameManifest, type GameManifest } from '@adg/pack-schema'
import { GAMES_DIR } from '@adg/packs'
import { GAMES_CAPABILITY, type Activity, type GameInfo, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { Calendar, type ReadEvent } from './calendar.ts'
import { DailyReport, localDay, realClock, type Clock } from './daily.ts'
import { buildReport } from './report.ts'
import { readSmw, type Fetch } from './sources.ts'
import { gameTools } from './tools.ts'

export { Calendar, DEFAULT_SETTINGS, type ReadEvent } from './calendar.ts'
export { DailyReport, localDay, realClock, type Clock, type DailyDeps } from './daily.ts'
export { buildReport, type ReportGame } from './report.ts'
export { parseAsk, readSmw, readValue, smwQuery, type Fetch, type SiteEvent } from './sources.ts'
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
/** An agent reading of the game gives up after this long. */
const READ_TIMEOUT_MS = 20 * 60_000

interface LoadedGame {
  readonly manifest: GameManifest
  readonly dir: string
  readonly builtin: boolean
  readonly guide?: string
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

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgGameIntel')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-game-intel')
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

    // ── skills: the general guide and each game's GAME.md ──
    ctx.inject(['skills'], scoped => {
      const disposers: Array<() => void> = []
      void (async () => {
        await this.ready
        const guide = parseFrontmatter(await readFile(SKILL, 'utf8'))
        if (guide !== undefined) disposers.push(scoped.skills.register({ ...guide, source: 'bundled' }))
        for (const game of this.games) {
          if (game.guide === undefined) continue
          const skill = parseFrontmatter(game.guide)
          if (skill === undefined) { log.warn(`game ${game.manifest.id}: GAME.md has no usable frontmatter`); continue }
          try {
            disposers.push(scoped.skills.register({ ...skill, source: game.builtin ? 'bundled' : 'custom', path: join(game.dir, GAME_GUIDE_FILE), resourceBase: { kind: 'directory', path: game.dir } }))
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
        sendReport: async () => ({ channels: await this.sendReport(localDay(this.clock.now())) }),
        now: () => this.clock.now(),
      })) scoped.tools.register(tool)
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
            return { sessionId: await this.read((params as RequestParams<'games/read'>).game) }
          },
          'games/report/preview': async () => { await this.ready; return this.preview() },
          'games/report/send': async () => {
            await this.ready
            const channels = await this.sendReport(localDay(this.clock.now()))
            return { channels, text: this.preview().text }
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
    this.games = [...found.values()]
  }

  private game(id: string): LoadedGame {
    const game = this.games.find(g => g.manifest.id === id)
    if (game === undefined) throw new Error(`没有游戏「${id}」`)
    return game
  }

  infos(): GameInfo[] {
    return this.games.map(({ manifest: m, builtin }) => {
      const refreshed = this.calendar.refreshed(m.id)
      const reading = this.calendar.reading(m.id)
      return {
        id: m.id, name: m.name, aliases: m.aliases, scripts: m.scripts, timezone: m.timezone,
        ...(m.screen === undefined ? {} : { screen: { target: m.screen.target, ...(m.screen.window === undefined ? {} : { window: m.screen.window }) } }),
        sources: m.sources.map(s => ({ id: s.id, name: s.name, ...(s.homepage === undefined ? {} : { homepage: s.homepage }), auto: s.smw !== undefined })),
        builtin,
        ...(refreshed === undefined ? {} : { refreshed }),
        ...(reading === undefined ? {} : { reading }),
      }
    })
  }

  // ── data sites ──

  /** Read every readable data site (of one game, or all). */
  async refresh(gameId?: string): Promise<Array<{ game: string; ok: boolean; count: number; detail?: string }>> {
    const games = gameId === undefined ? this.games : [this.game(gameId)]
    const results: Array<{ game: string; ok: boolean; count: number; detail?: string }> = []
    for (const { manifest } of games) {
      const sources = manifest.sources.filter(s => s.smw !== undefined)
      if (sources.length === 0) {
        results.push({ game: manifest.id, ok: false, count: 0, detail: `没有能直接读的数据站：用 web_fetch 看 ${manifest.sources.map(s => s.homepage).filter(Boolean).join(' 或 ') || '官网公告'}，再用 game_record（source=site）记下` })
        continue
      }
      const failures: string[] = []
      let count = 0
      for (const source of sources) {
        const now = this.clock.now()
        try {
          const events = await readSmw(source.smw!, manifest, now, this.fetch)
          await this.calendar.applySite(manifest.id, { id: source.id, name: source.name }, events, now, manifest.timezone)
          count += events.length
        } catch (error) {
          failures.push(`${source.name}：${error instanceof Error ? error.message : String(error)}`)
        }
      }
      if (failures.length > 0 && count === 0) await this.calendar.refreshFailed(manifest.id, failures.join('；'), this.clock.now())
      results.push({ game: manifest.id, ok: failures.length === 0 || count > 0, count, ...(failures.length === 0 ? {} : { detail: failures.join('；') }) })
      this.changed(manifest.id)
    }
    return results
  }

  // ── what the agent read ──

  private async record(gameId: string, from: 'screen' | 'site', events: readonly ReadEvent[], sessionId: string | undefined, keep: boolean): Promise<Array<{ activity: Activity; matched: boolean }>> {
    const { manifest } = this.game(gameId)
    const shot = from === 'screen' && keep && sessionId !== undefined ? this.ctx.get('adgIntervene')?.lastShot(sessionId) : undefined
    const written = await this.calendar.applyRead(gameId, from, events, {
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
  async read(gameId: string): Promise<string> {
    const { manifest } = this.game(gameId)
    const sessions = this.ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const conversations = sessionConversations(sessions, () => this.ctx.get('adgGateway')?.workspaceDir())
    const sessionId = await conversations.create(`游戏信息：${manifest.name}`)
    await this.calendar.setReading(manifest.id, { state: 'running', at: this.clock.now(), sessionId })
    this.changed(manifest.id)
    const screen = manifest.screen === undefined ? '游戏画面' : manifest.screen.target === 'emulator' ? '模拟器画面（screen_capture target=emulator）' : `游戏窗口（screen_capture target=window${manifest.screen.window === undefined ? '，先 window_list 找窗口' : `，window=${manifest.screen.window}`}）`
    const prompt = [
      `读取「${manifest.name}」现在的活动和进度（游戏 id：${manifest.id}）。按技能 game-intel 和 game-${manifest.id}：`,
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
    const script = manifest.scripts.find(id => runner.hasPack(id))
    if (script === undefined) throw new Error(`还没有安装玩${manifest.name}的脚本（${manifest.scripts.join('、') || '游戏包里没写'}），不知道怎么启动它；请用户先打开游戏，或先安装脚本并在脚本页设置「启动游戏」`)
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
    const script = manifest.scripts.find(id => runner.hasPack(id))
    if (script === undefined) throw new Error(`还没有安装玩${manifest.name}的脚本，不知道怎么找到它的进程；请用户自己关掉游戏`)
    const lines = await runner.closeGame(script, manifest.screen?.target === 'emulator' ? 'emulator' : 'pc', signal)
    return { script, lines }
  }

  // ── report ──

  preview(): { title: string; text: string } {
    const { title, text } = buildReport(this.games.map(g => ({ id: g.manifest.id, name: g.manifest.name, timezone: g.manifest.timezone })), this.calendar.list(), this.calendar.settings.report, this.clock.now())
    return { title, text }
  }

  /** Send the report to the chat channels. @returns the channels it reached. */
  private async sendReport(day: string): Promise<string[]> {
    const { title, text } = this.preview()
    let channels: string[] = []
    let result: string
    try {
      channels = await this.ctx.adgNotify.notify.send({ id: `games-report:${day}:${this.clock.now()}`, scope: 'games', title, text, severity: 'info' })
      result = channels.length === 0 ? '没有发出去：还没有设置好的聊天渠道' : `已发到${channels.join('、')}`
    } catch (error) {
      result = `发送失败：${error instanceof Error ? error.message : String(error)}`
    }
    await this.calendar.setReport({ ...this.calendar.report, lastResult: result, ...(channels.length > 0 ? { lastSentAt: this.clock.now(), lastDay: day } : {}) })
    this.changed()
    return channels
  }
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
