/**
 * Agent tools for game information: which games there are and how to read
 * them, the event calendar, reading the data sites, recording what the agent
 * read in the game (or on a web page), and the daily report.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Activity, GameInfo } from '@adg/protocol'
import { z } from 'zod'
import type { ReadEvent } from './calendar.ts'
import { leftText, shortDate } from './time.ts'

export interface GameToolDeps {
  readonly games: () => GameInfo[]
  readonly activities: (game?: string) => Activity[]
  readonly refresh: (game?: string) => Promise<Array<{ game: string; ok: boolean; count: number; detail?: string | undefined }>>
  readonly record: (game: string, from: 'screen' | 'site', events: readonly ReadEvent[], sessionId: string | undefined, keepScreenshot: boolean) => Promise<Array<{ activity: Activity; matched: boolean }>>
  readonly report: () => { title: string; text: string }
  readonly sendReport: () => Promise<{ channels: string[] }>
  readonly now: () => number
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
      dates_from: a.site?.name ?? (a.screen !== undefined ? '游戏画面' : '未知'),
      ...(a.screen === undefined ? {} : { read_in_game: shortDate(a.screen.at, timeZone), todo: a.todo, done: a.done, ...(a.progress === undefined ? {} : { progress: a.progress }) }),
      ...(a.mismatch === undefined ? {} : { mismatch: a.mismatch }),
      ...(a.url === undefined ? {} : { url: a.url }),
    }
  }

  return [
    tool({
      name: 'game_list',
      description: '列出已知的游戏（游戏包）：玩它的脚本、怎么看游戏画面、有哪些数据站（auto=true 的用 game_sites_refresh 直接读，其余用 web_fetch 看），以及上次刷新和上次进游戏读取的时间。读某个游戏的界面前先加载它的技能 game-<id>。',
      properties: {},
      readOnly: true,
      kind: 'read',
      title: () => '游戏列表',
      execute: async () => ({
        games: deps.games().map(g => ({
          id: g.id, name: g.name, aliases: g.aliases, scripts: g.scripts, skill: `game-${g.id}`,
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
