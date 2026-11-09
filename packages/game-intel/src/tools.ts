/**
 * Agent tools for game information: which games there are and how to read
 * them, the event calendar, reading the data sites, recording what the agent
 * read in the game (or on a web page), and the daily report.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { OWN_SOURCE, SCREEN_SOURCE, type Activity, type GameInfo } from '@adg/protocol'
import { z } from 'zod'
import type { OwnPatch, ReadEvent } from './calendar.ts'
import { leftText, parseDateText, shortDate } from './time.ts'

export interface GameToolDeps {
  readonly games: () => GameInfo[]
  readonly activities: (game?: string) => Activity[]
  readonly refresh: (game?: string) => Promise<Array<{ game: string; ok: boolean; count: number; detail?: string | undefined }>>
  readonly record: (game: string, from: 'screen' | 'site', events: readonly ReadEvent[], sessionId: string | undefined, keepScreenshot: boolean) => Promise<Array<{ activity: Activity; matched: boolean }>>
  readonly launch: (game: string, signal: AbortSignal) => Promise<{ script: string; lines: string[] }>
  readonly close: (game: string, signal: AbortSignal) => Promise<{ script: string; lines: string[] }>
  readonly report: () => { title: string; text: string }
  readonly sendReport: () => Promise<{ channels: string[] }>
  readonly now: () => number
  /** Write a game pack of the user's own. */
  readonly add: (manifest: unknown, guide: string | undefined) => Promise<GameInfo>
  /** Add an event of the user's own, or write their word on one (`id`); `image`: as the agent named it (https, a file, `screenshot`). */
  readonly saveActivity: (game: string, id: string | undefined, patch: OwnPatch, image: string | undefined, sessionId: string | undefined) => Promise<Activity>
  /** Which source an event's picture and dates come from; `null`: the default order. */
  readonly chooseSource: (id: string, source: string | null) => Promise<Activity>
  /** `mine`: take back only what the user wrote; `all`: drop the event. @returns it as it is now (undefined: gone). */
  readonly removeActivity: (id: string, what: 'mine' | 'all') => Promise<Activity | undefined>
}

/** The tool's names for the fields the user can write (OwnField). */
const OWN_KEYS = { name: 'name', starts_at: 'startsAt', ends_at: 'endsAt', kind: 'kind', description: 'description', url: 'url', image: 'cover' } as const

/** A source of an event (`Activity.shown`, `.chosen`), as the agent should read it. */
function sourceName(a: Activity, source: string | undefined): string {
  if (source === OWN_SOURCE) return '用户自己填的'
  if (source === SCREEN_SOURCE) return '游戏画面'
  return a.sources?.find(s => s.id === source)?.name ?? a.site?.name ?? (a.screen !== undefined ? '游戏画面' : '未知')
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
  return parsed.data
}

function tool(spec: {
  name: string
  description: string
  properties: Record<string, JsonSchemaNode>
  required?: string[]
  timeoutMs?: number
  readOnly?: boolean
  kind: 'read' | 'execute' | 'other'
  title(args: Record<string, unknown>): string
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties, ...(spec.required === undefined ? {} : { required: spec.required }), additionalProperties: false },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] },
    timeoutMs: spec.timeoutMs ?? 60_000,
    isConcurrencySafe: () => spec.readOnly === true,
    execute: async (args, exec) => JSON.parse(JSON.stringify(await spec.execute(args, exec) ?? null)) as never,
    presentCall: args => ({ card: 'generic', title: spec.title((args ?? {}) as Record<string, unknown>), kind: spec.kind }),
  }
}

const GAME: JsonSchemaNode = { type: 'string', description: '游戏 id（game_list 可查），例如 arknights、starrail、endfield。' }

export function gameTools(deps: GameToolDeps): ToolDefinition[] {
  const known = (id: string) => {
    const game = deps.games().find(g => g.id === id || g.name === id || g.aliases.includes(id))
    if (game === undefined) throw new Error(`没有游戏「${id}」。有：${deps.games().map(g => `${g.id}（${g.name}）`).join('、') || '（没有游戏包）'}`)
    return game
  }
  const brief = (a: Activity, timeZone: string) => {
    const now = deps.now()
    return {
      id: a.id,
      name: a.name,
      ...(a.startsAt !== undefined && a.startsAt > now ? { starts: shortDate(a.startsAt, timeZone) } : {}),
      ends: a.endsAt === undefined ? '未知' : `${shortDate(a.endsAt, timeZone)}（${leftText(a.endsAt, now)}）`,
      ...(a.shopEndsAt === undefined ? {} : { shop_ends: shortDate(a.shopEndsAt, timeZone) }),
      dates_from: sourceName(a, a.shown?.endsAt ?? a.shown?.startsAt),
      ...(a.sources === undefined ? {} : { sources: a.sources.map(s => ({ id: s.id, name: s.name, ...(s.endsAt === undefined ? {} : { ends: shortDate(s.endsAt, timeZone) }) })) }),
      ...(a.chosen === undefined ? {} : { chosen_by_user: sourceName(a, a.chosen) }),
      ...(a.own === undefined ? {} : { set_by_user: a.own.fields.map(f => Object.entries(OWN_KEYS).find(([, v]) => v === f)![0]), ...(a.sources === undefined && a.screen === undefined ? { added_by_user: true } : {}) }),
      ...(a.kind === undefined ? {} : { kind: a.kind }),
      ...(a.cover === undefined ? {} : { image: a.cover.startsWith('own:') ? '用户的图片' : a.cover.startsWith('shot:') ? '游戏截图（优先级最低，没有别的图时用它）' : a.cover }),
      ...(a.screen === undefined ? {} : { read_in_game: shortDate(a.screen.at, timeZone), ...(a.progress === undefined ? {} : { progress: a.progress }) }),
      // The checklist (from the game screen or kept by the user on the board), and the user's own "done".
      ...(a.todo.length + a.done.length === 0 ? {} : { todo: a.todo, done: a.done }),
      ...(a.finished === undefined ? {} : { finished_by_user: true }),
      ...(a.mismatch === undefined ? {} : { mismatch: a.mismatch }),
      ...(a.url === undefined ? {} : { url: a.url }),
    }
  }

  return [
    tool({
      name: 'game_add',
      description: '给一个还没有游戏包的游戏建一个（用户自己的游戏包），之后游戏页就能显示它的活动。来源三种：sra（SRA 公共 API 的游戏 id）、smw（Semantic MediaWiki 的 api.php 查询，能读到活动起止时间）、只有 homepage（官网公告等，由 agent 读）。能自动读的会马上读一次。用户说「加一个 XX 游戏」或游戏页让你找来源时用。',
      properties: {
        id: { type: 'string', description: '小写英文、数字和短横线，例如 wuthering-waves。' },
        name: { type: 'string', description: '中文正式名。' },
        aliases: { type: 'array', items: { type: 'string' }, description: '常见简称、英文名（可选）。' },
        timezone: { type: 'string', description: '服务器时区，例如 Asia/Shanghai（默认）、Asia/Tokyo。' },
        daily_reset: { type: 'string', description: '每日刷新时间 HH:mm（默认 04:00）。' },
        sources: {
          type: 'array',
          description: '来源，可以多个；能自动读的放前面。',
          items: {
            type: 'object',
            properties: {
              id: { type: 'string', description: '来源 id，小写英文，例如 official、wiki。' },
              name: { type: 'string', description: '给人看的名字，例如「官网新闻」。' },
              homepage: { type: 'string', description: '人能打开的页面地址。' },
              sra_game: { type: 'string', description: 'SRA 公共 API 的游戏 id（可选）。' },
              smw: { type: 'object', description: 'Semantic MediaWiki 查询（可选）：{ api, conditions, title?, start, end, shopEnd?, dates: date|text, page? }。' },
            },
            required: ['id', 'name'],
            additionalProperties: false,
          },
        },
        guide: { type: 'string', description: 'GAME.md 正文（可选）：哪些来源看什么、公告页怎么找活动。' },
      },
      required: ['id', 'name', 'sources'],
      kind: 'other',
      title: a => `添加游戏：${String(a['name'] ?? a['id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({
          id: z.string(), name: z.string(), aliases: z.array(z.string()).nullish(), timezone: z.string().nullish(), daily_reset: z.string().nullish(),
          sources: z.array(z.object({ id: z.string(), name: z.string(), homepage: z.string().nullish(), sra_game: z.string().nullish(), smw: z.record(z.string(), z.unknown()).nullish() })).min(1),
          guide: z.string().nullish(),
        }), args)
        const manifest = {
          id: a.id, name: a.name,
          ...(a.aliases == null ? {} : { aliases: a.aliases }),
          ...(a.timezone == null ? {} : { timezone: a.timezone }),
          ...(a.daily_reset == null ? {} : { dailyReset: a.daily_reset }),
          sources: a.sources.map(s => ({
            id: s.id, name: s.name,
            ...(s.homepage == null ? {} : { homepage: s.homepage }),
            ...(s.sra_game == null ? {} : { sra: { game: s.sra_game } }),
            ...(s.smw == null ? {} : { smw: s.smw }),
          })),
        }
        const game = await deps.add(manifest, a.guide ?? undefined)
        return { added: game.id, name: game.name, sources: game.sources.map(s => `${s.name}（${s.auto ? '自动读' : 'agent 读'}）`), note: '已加到游戏页；能自动读的来源正在读取' }
      },
    }),
    tool({
      name: 'game_list',
      description: '列出已知的游戏（游戏包）：玩它的脚本、怎么看游戏画面、有哪些数据站（auto=true 的用 game_sites_refresh 直接读，其余用 web_fetch 看），以及上次刷新和上次进游戏读取的时间。读某个游戏的界面前先加载它的技能 game-<id>。',
      properties: {},
      readOnly: true,
      kind: 'read',
      title: () => '游戏列表',
      execute: async () => ({
        games: deps.games().map(g => ({
          id: g.id, name: g.name, aliases: g.aliases, scripts: g.scripts, skill: `game-${g.id}（这个游戏的技能；没有的话可能要先从技能库下载，见 skill_hub_list）`,
          screen: g.screen === undefined ? '未设置' : g.screen.target === 'emulator' ? 'target=emulator' : `target=window${g.screen.window === undefined ? '（先 window_list 找窗口）' : `，window=${g.screen.window}`}`,
          sources: g.sources.map(s => ({ name: s.name, auto: s.auto, ...(s.homepage === undefined ? {} : { homepage: s.homepage }) })),
          ...(g.refreshed === undefined ? {} : { refreshed: { at: new Date(g.refreshed.at).toISOString(), ok: g.refreshed.ok, count: g.refreshed.count, ...(g.refreshed.detail === undefined ? {} : { detail: g.refreshed.detail }) } }),
          ...(g.reading === undefined ? {} : { last_read_in_game: new Date(g.reading.at).toISOString() }),
        })),
      }),
    }),
    tool({
      name: 'game_activities',
      description: '活动日历：各游戏进行中和即将开始的活动、结束时间和剩余天数、在游戏里读到的未完成项。用户问「方舟有什么活动」「还剩几天」时先看这个；太久没刷新（refreshed 很旧）就先 game_sites_refresh。',
      properties: { game: { ...GAME, description: '只看这个游戏（不填看全部）。' } },
      readOnly: true,
      kind: 'read',
      title: a => `活动日历${typeof a['game'] === 'string' ? `：${a['game']}` : ''}`,
      execute: async args => {
        const a = parse(z.object({ game: z.string().nullish() }), args)
        const games = a.game == null ? deps.games() : [known(a.game)]
        return {
          games: games.map(g => ({ game: g.id, name: g.name, activities: deps.activities(g.id).map(x => brief(x, g.timezone)) })),
        }
      },
    }),
    tool({
      name: 'game_sites_refresh',
      description: '从数据站（PRTS、B 站 WIKI 等）读取活动的开始和结束时间，更新活动日历。不花模型调用；游戏包里没有可直接读的数据站时（例如终末地）会说明，那就用 web_fetch / web_search 看官网公告，再用 game_record（source=site）记下。',
      properties: { game: { ...GAME, description: '只刷新这个游戏（不填刷新全部）。' } },
      timeoutMs: 120_000,
      kind: 'read',
      title: a => `刷新数据站${typeof a['game'] === 'string' ? `：${a['game']}` : ''}`,
      execute: async args => {
        const a = parse(z.object({ game: z.string().nullish() }), args)
        const results = await deps.refresh(a.game == null ? undefined : known(a.game).id)
        return { results }
      },
    }),
    tool({
      name: 'game_record',
      description: '把读到的活动信息记进活动日历。source=screen：在游戏画面里看到的（剩余时间、没做完的事），会和数据站的结束时间核对，并保存这个对话最近一张截图作为依据；source=site：从网页（官网公告等）读到的起止时间，用于没有数据站的游戏。活动名用界面上的原文。',
      properties: {
        game: GAME,
        source: { type: 'string', enum: ['screen', 'site'], description: 'screen：游戏画面；site：网页。' },
        activities: {
          type: 'array',
          description: '每个活动一条。',
          items: {
            type: 'object',
            properties: {
              name: { type: 'string', description: '活动名（界面或公告上的原文）。' },
              remaining: { type: 'string', description: '界面上的剩余时间原文，例如「剩余 3天12小时」。' },
              ends_at: { type: 'string', description: '结束时间，写成 2026/10/25 03:59 或 10/25 03:59（游戏服务器时间）。' },
              starts_at: { type: 'string', description: 'source=site：开始时间，写法同上。' },
              todo: { type: 'array', items: { type: 'string' }, description: '还没做完的事，例如「活动商店还剩 3 项没换」「EX 关卡未通关」。' },
              done: { type: 'array', items: { type: 'string' }, description: '已经做完的事。' },
              progress: { type: 'string', description: '进度，例如「代币 1200」「每日实训 300/500」。' },
              url: { type: 'string', description: 'source=site：读到的网页地址。' },
              cover: { type: 'string', description: 'source=site：公告里这个活动的配图地址（https，可选），游戏页的活动卡片用它当背景。' },
            },
            required: ['name'],
            additionalProperties: false,
          },
        },
        keep_screenshot: { type: 'boolean', description: 'source=screen：保存这个对话最近一张截图作为依据（默认是）。' },
      },
      required: ['game', 'source', 'activities'],
      kind: 'other',
      title: a => `记录活动：${String(a['game'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({
          game: z.string(),
          source: z.enum(['screen', 'site']),
          activities: z.array(z.object({
            name: z.string().min(1),
            remaining: z.string().nullish(),
            ends_at: z.string().nullish(),
            starts_at: z.string().nullish(),
            todo: z.array(z.string()).nullish(),
            done: z.array(z.string()).nullish(),
            progress: z.string().nullish(),
            url: z.string().nullish(),
            cover: z.string().nullish(),
          })).min(1),
          keep_screenshot: z.boolean().nullish(),
        }), args)
        const game = known(a.game)
        const events: ReadEvent[] = a.activities.map(x => ({
          name: x.name,
          remaining: x.remaining ?? undefined,
          endsAt: x.ends_at ?? undefined,
          startsAt: x.starts_at ?? undefined,
          todo: x.todo ?? undefined,
          done: x.done ?? undefined,
          progress: x.progress ?? undefined,
          url: x.url ?? undefined,
          cover: x.cover ?? undefined,
        }))
        const sessionId = exec.agent?.session.id as string | undefined
        const written = await deps.record(game.id, a.source, events, sessionId, a.keep_screenshot !== false)
        return {
          recorded: written.map(w => ({ ...brief(w.activity, game.timezone), ...(w.matched ? {} : { note: '日历里原来没有这个活动，新加了一条' }) })),
          next: a.source === 'screen' ? '读完了就回到游戏主界面；有 mismatch 的告诉用户以数据站为准。' : '记下了。',
        }
      },
    }),
    tool({
      name: 'game_activity_save',
      description: [
        '替用户手动添加一个活动，或改一个已有活动（id 从 game_activities 查）。用户说「帮我加一个 XX 活动」「把 XX 的结束时间改成…」「给这个活动换张图」时用。',
        '写进去的字段是用户自己的说法：比数据站和网页优先，刷新不会改掉也不会删掉；和来源一样的值不单独保存。读到的网页或游戏画面用 game_record，不要用这个。',
        '活动图片分三级：用户设的 > 数据站和网页给的 > agent 的截图。image 写图片网址（https，会下载保存）或本机图片文件路径（相对路径按工作区）算用户设的；写 screenshot（这个对话最近一张截图）算 agent 的截图，只在没有别的图时显示。clear 里的字段收回用户的值，恢复成来源的。',
        'use_source 选这个活动的图片和时间用哪个来源（game_activities 的 sources 里的 id，或 own=用户自己填的、screen=游戏画面、default=恢复默认顺序）；用户说「用 PRTS 的时间」时用。',
      ].join(''),
      properties: {
        game: GAME,
        id: { type: 'string', description: '要改的活动 id（不填就是新加；同名的已有活动会当成同一个）。' },
        name: { type: 'string', description: '活动名；新加时必填。' },
        starts_at: { type: 'string', description: '开始时间，写成 2026/10/25 04:00 或 10/25 04:00（游戏服务器时间）。' },
        ends_at: { type: 'string', description: '结束时间，写法同上。' },
        kind: { type: 'string', description: '类型（可选），例如「SideStory」「签到」「限时商店」。' },
        description: { type: 'string', description: '说明（可选），500 字以内。' },
        url: { type: 'string', description: '活动页面地址（可选）。' },
        image: { type: 'string', description: '活动卡片的图片：https 图片网址、本机图片文件路径，或 screenshot（优先级最低）。' },
        use_source: { type: 'string', description: '图片和时间用哪个来源：来源 id、own、screen，或 default（恢复默认顺序）。要有 id。' },
        todo: { type: 'array', items: { type: 'string' }, description: '要做的事（可选，替换原来没做完的清单），例如「活动商店换完」。' },
        clear: { type: 'array', items: { type: 'string', enum: Object.keys(OWN_KEYS) }, description: '收回用户填过的这些字段（恢复成来源的值）。' },
      },
      required: ['game'],
      kind: 'other',
      title: a => `${typeof a['id'] === 'string' ? '修改' : '添加'}活动：${String(a['name'] ?? a['id'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({
          game: z.string(), id: z.string().nullish(),
          name: z.string().max(60).nullish(), starts_at: z.string().nullish(), ends_at: z.string().nullish(),
          kind: z.string().max(20).nullish(), description: z.string().max(500).nullish(),
          url: z.string().regex(/^https?:\/\/\S+$/, '只能是 http 或 https 网址').nullish(),
          image: z.string().nullish(), todo: z.array(z.string().min(1).max(80)).max(30).nullish(),
          use_source: z.string().nullish(),
          clear: z.array(z.enum(Object.keys(OWN_KEYS) as [keyof typeof OWN_KEYS])).nullish(),
        }), args)
        const game = known(a.game)
        if (a.id == null && (a.name == null || a.name.trim() === '')) throw new Error('新加活动要写 name；改已有的活动要写 id（game_activities 可查）')
        if (a.id == null && a.use_source != null) throw new Error('use_source 要和 id 一起用：先用 game_activities 查到这个活动')
        const when = (text: string | null | undefined, what: string) => {
          if (text == null) return undefined
          const at = parseDateText(text, game.timezone, deps.now())
          if (at == null) throw new Error(`${what}「${text}」看不懂：写成 2026/10/25 04:00 或 10/25 04:00`)
          return at
        }
        const patch: OwnPatch = {
          ...(a.name == null ? {} : { name: a.name }),
          ...(a.starts_at == null ? {} : { startsAt: when(a.starts_at, '开始时间') }),
          ...(a.ends_at == null ? {} : { endsAt: when(a.ends_at, '结束时间') }),
          ...(a.kind == null ? {} : { kind: a.kind }),
          ...(a.description == null ? {} : { description: a.description }),
          ...(a.url == null ? {} : { url: a.url }),
          ...(a.todo == null ? {} : { todo: a.todo }),
        }
        for (const key of a.clear ?? []) (patch as Record<string, unknown>)[OWN_KEYS[key]] = null
        const sessionId = exec.agent?.session.id as string | undefined
        const edited = Object.keys(patch).length > 0 || a.image != null
        let activity = edited || a.id == null ? await deps.saveActivity(game.id, a.id ?? undefined, patch, a.image ?? undefined, sessionId) : undefined
        if (a.use_source != null) activity = await deps.chooseSource(a.id!, a.use_source === 'default' ? null : a.use_source === 'own' ? OWN_SOURCE : a.use_source === 'screen' ? SCREEN_SOURCE : a.use_source)
        if (activity === undefined) throw new Error('没有要改的内容：写上要改的字段、image 或 use_source')
        return { saved: brief(activity, game.timezone), note: a.id == null ? '已加到活动日历；游戏页和日报里都能看到' : '已改好' }
      },
    }),
    tool({
      name: 'game_activity_remove',
      description: '去掉活动：what=mine 只收回用户自己填的内容（名字、时间、图片等恢复成来源的；只有用户填的活动会整个去掉）；what=all 把活动从日历去掉（数据站还列着的话，下次刷新会再出现）。只在用户要求时用。',
      properties: {
        id: { type: 'string', description: '活动 id（game_activities 可查）。' },
        what: { type: 'string', enum: ['mine', 'all'], description: 'mine：只收回用户填的；all：整个去掉（默认）。' },
      },
      required: ['id'],
      kind: 'other',
      title: a => `${a['what'] === 'mine' ? '恢复' : '去掉'}活动：${String(a['id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: z.string(), what: z.enum(['mine', 'all']).nullish() }), args)
        const activity = await deps.removeActivity(a.id, a.what ?? 'all')
        const game = activity === undefined ? undefined : deps.games().find(g => g.id === activity.game)
        return activity === undefined || game === undefined ? { removed: a.id } : { restored: brief(activity, game.timezone) }
      },
    }),
    tool({
      name: 'game_launch',
      description: '游戏没开时启动它：用玩它的脚本在「启动游戏」里的设置（模拟器里的游戏会先启动模拟器；PC 版打开设置好的程序或启动器），已经开着就什么都不做。有脚本正在用这台模拟器或鼠标键盘时会拒绝。启动后截图确认：关掉公告和更新提示，启动器需要点「开始游戏」就点；要输入账号密码或验证码时停下交给用户。',
      properties: { game: GAME },
      required: ['game'],
      timeoutMs: 300_000,
      kind: 'execute',
      title: a => `启动游戏：${String(a['game'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ game: z.string() }), args)
        const game = known(a.game)
        const { script, lines } = await deps.launch(game.id, exec.signal)
        return { game: game.name, via: script, done: lines, next: '截图看看游戏到了哪个界面，等它进到主界面再继续。' }
      },
    }),
    tool({
      name: 'game_close',
      description: '关闭游戏：模拟器里的游戏只关掉游戏本身（模拟器留着），PC 版先请它退出，一会儿还没退就强制结束。只在用户同意后调用（读完活动后用 ask_user_question 问过「要不要把游戏关掉」）。有脚本正在用这台模拟器或鼠标键盘时会拒绝。',
      properties: { game: GAME },
      required: ['game'],
      timeoutMs: 120_000,
      kind: 'execute',
      title: a => `关闭游戏：${String(a['game'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ game: z.string() }), args)
        const game = known(a.game)
        const { script, lines } = await deps.close(game.id, exec.signal)
        return { game: game.name, via: script, done: lines }
      },
    }),
    tool({
      name: 'game_report',
      description: '活动日报：各游戏进行中的活动、剩余天数和没做完的事。send=true 时发到飞书等聊天渠道（每天定时发的也是这份）。',
      properties: { send: { type: 'boolean', description: '发送到聊天渠道（默认只返回内容）。' } },
      kind: 'other',
      title: a => (a['send'] === true ? '发送活动日报' : '活动日报'),
      execute: async args => {
        const a = parse(z.object({ send: z.boolean().nullish() }), args)
        const report = deps.report()
        if (a.send !== true) return report
        const { channels } = await deps.sendReport()
        return { ...report, sent_to: channels.length === 0 ? '没有发出去：还没有设置好的聊天渠道（在「设置 → 飞书」里配置）' : channels.join('、') }
      },
    }),
  ]
}
