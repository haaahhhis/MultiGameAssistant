/**
 * The daily report (docs/PLAN.zh.md §5.5): per game, the running events by
 * how soon they end, what is still to do in each, and what starts soon —
 * "昨日海还剩 2 天，活动商店还剩 3 项没换". With `ai` on, the agent writes
 * it instead from `recentDigest`, and this list is the fallback.
 */
import type { Activity, GamesSettings } from '@adg/protocol'
import { MS, daysLeft, leftText, shortDate, wallClock } from './time.ts'

export interface ReportGame {
  readonly id: string
  readonly name: string
  readonly timezone: string
}

/** Upcoming events within this long are mentioned. */
const UPCOMING_MS = 3 * MS.DAY

export function buildReport(games: readonly ReportGame[], activities: readonly Activity[], settings: GamesSettings['report'], now: number): { title: string; text: string; count: number } {
  const local = wallClock(now, Intl.DateTimeFormat().resolvedOptions().timeZone)
  const title = `今日活动日报（${local.month}月${local.day}日）`
  const chosen = settings.games.length === 0 ? games : games.filter(g => settings.games.includes(g.id))
  const sections: string[] = []
  const sources = new Set<string>()
  let lastRead: number | undefined
  let count = 0
  for (const game of chosen) {
    const mine = activities.filter(a => a.game === game.id)
    const running = mine.filter(a => (a.startsAt ?? 0) <= now && Math.max(a.endsAt ?? Infinity, a.shopEndsAt ?? 0) > now)
    const upcoming = mine.filter(a => a.startsAt !== undefined && a.startsAt > now && a.startsAt - now <= UPCOMING_MS)
    if (running.length === 0 && upcoming.length === 0) continue
    // Season-long modes (集成战略, 生息演算) get one line unless they end soon or something is left to do.
    const long = running.filter(a => isLong(a) && a.todo.length === 0 && daysLeft(a.endsAt!, now) >= settings.soonDays)
    const lines = running.filter(a => !long.includes(a)).map(a => {
      count++
      if (a.site !== undefined && a.site.source !== 'agent') sources.add(a.site.name)
      if (a.screen !== undefined) lastRead = Math.max(lastRead ?? 0, a.screen.at)
      return `· ${line(a, game.timezone, settings.soonDays, now)}`
    })
    for (const a of upcoming) lines.push(`· ${a.name}：${shortDate(a.startsAt!, game.timezone)} 开始`)
    if (long.length > 0) {
      count += long.length
      lines.push(`· 长期：${long.map(a => `${a.name}（${leftText(a.endsAt!, now)}）`).join('、')}`)
    }
    sections.push(`【${game.name}】\n${lines.join('\n')}`)
  }
  if (sections.length === 0) return { title, text: '今天没有进行中的活动（或者还没读到）。可以在「游戏」页刷新数据站，或让 agent 进游戏看看。', count: 0 }
  const footer = [
    sources.size === 0 ? undefined : `活动时间来自 ${[...sources].join('、')}`,
    lastRead === undefined ? '进度还没在游戏里读过' : `进度是 agent ${shortDate(lastRead, Intl.DateTimeFormat().resolvedOptions().timeZone)} 在游戏里看到的`,
  ].filter(Boolean).join('；')
  return { title, text: `${sections.join('\n\n')}\n\n${footer}。`, count }
}

/** Started this recently, an event is news. */
const RECENT_MS = 3 * MS.DAY

/**
 * What the agent summarizes for the AI report: only what is recent — events
 * that just started, end (or close their shop) within `soonDays` and are not
 * done, or start soon. Season-long modes and quiet mid-run events are left
 * out. @returns undefined when nothing is recent.
 */
export function recentDigest(games: readonly ReportGame[], activities: readonly Activity[], settings: GamesSettings['report'], now: number): string | undefined {
  const chosen = settings.games.length === 0 ? games : games.filter(g => settings.games.includes(g.id))
  const sections: string[] = []
  for (const game of chosen) {
    const lines: string[] = []
    for (const a of activities.filter(x => x.game === game.id)) {
      const end = a.endsAt !== undefined && a.endsAt > now ? a.endsAt : a.shopEndsAt !== undefined && a.shopEndsAt > now ? a.shopEndsAt : undefined
      const started = a.startsAt === undefined || a.startsAt <= now
      const tags: string[] = []
      if (!started && a.startsAt! - now <= UPCOMING_MS) tags.push(`即将开始（${shortDate(a.startsAt!, game.timezone)}）`)
      if (started && a.startsAt !== undefined && now - a.startsAt <= RECENT_MS && end !== undefined) tags.push(`新开始（${shortDate(a.startsAt, game.timezone)}）`)
      if (started && end !== undefined && a.finished === undefined && daysLeft(end, now) < settings.soonDays) tags.push(end === a.endsAt ? `快结束：${leftText(end, now)}（${shortDate(end, game.timezone)}）` : `活动已结束，商店${leftText(end, now)}`)
      if (tags.length === 0) continue
      let text = `· ${a.name}：${tags.join('；')}`
      if (a.finished !== undefined) text += '；用户说已做完'
      else if (a.todo.length > 0) text += `；还没做：${a.todo.join('、')}`
      if (a.progress !== undefined) text += `；进度 ${a.progress}`
      lines.push(text)
    }
    if (lines.length > 0) sections.push(`【${game.name}】\n${lines.join('\n')}`)
  }
  return sections.length === 0 ? undefined : sections.join('\n\n')
}

/** "⚠ 昨日海：还剩 2 天（10/23 03:59 结束），商店开到 10/29 · 还没做：活动商店还剩 3 项没换". */
function line(a: Activity, timeZone: string, soonDays: number, now: number): string {
  const parts: string[] = []
  if (a.endsAt !== undefined && a.endsAt > now) {
    parts.push(`${leftText(a.endsAt, now)}（${shortDate(a.endsAt, timeZone)} 结束）`)
    if (a.shopEndsAt !== undefined) parts.push(`商店开到 ${shortDate(a.shopEndsAt, timeZone)}`)
  } else if (a.shopEndsAt !== undefined && a.shopEndsAt > now) {
    parts.push(`活动已结束，商店${leftText(a.shopEndsAt, now)}`)
  } else if (a.screen?.remaining !== undefined) {
    parts.push(`游戏里显示${a.screen.remaining}`)
  } else {
    parts.push('结束时间未知')
  }
  const end = a.endsAt !== undefined && a.endsAt > now ? a.endsAt : a.shopEndsAt
  // The user said they are done: no warning, nothing left to list.
  const soon = a.finished === undefined && end !== undefined && daysLeft(end, now) < soonDays
  let text = `${soon ? '⚠ ' : ''}${a.name}：${parts.join('，')}`
  if (a.finished !== undefined) text += ' · 已做完'
  else if (a.todo.length > 0) text += ` · 还没做：${a.todo.join('、')}`
  else if (a.done.length > 0) text += ' · 都做完了'
  if (a.progress !== undefined) text += `（${a.progress}）`
  if (a.mismatch !== undefined) text += `\n  注意：${a.mismatch}`
  return text
}

/** Lasting longer than this, an event is a season rather than an event. */
const LONG_MS = 45 * MS.DAY

function isLong(a: Activity): boolean {
  return a.startsAt !== undefined && a.endsAt !== undefined && a.endsAt - a.startsAt > LONG_MS
}
