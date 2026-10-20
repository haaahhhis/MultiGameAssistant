/**
 * Dates as games and wikis write them: wall-clock times in the server's time
 * zone ("2026/10/25 03:59"), remaining times as the game shows them
 * ("剩余 3天12小时", "05:12:30"), and how many days are left.
 */

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000

/** The zone's offset from UTC at `at`, in ms (Asia/Shanghai: +8h). */
export function zoneOffset(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit',
  }).formatToParts(new Date(at))
  const get = (type: string) => Number(parts.find(p => p.type === type)?.value)
  const wall = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour'), get('minute'), get('second'))
  return wall - Math.floor(at / 1000) * 1000
}

/** A wall-clock time in `timeZone` as epoch ms. */
export function zonedTime(year: number, month: number, day: number, hour: number, minute: number, timeZone: string): number {
  const guess = Date.UTC(year, month - 1, day, hour, minute)
  const first = guess - zoneOffset(guess, timeZone)
  // Once more, for a guess on the other side of a DST change.
  return guess - zoneOffset(first, timeZone)
}

/** Year, month, day … of `at` on the wall clock of `timeZone`. */
export function wallClock(at: number, timeZone: string): { year: number; month: number; day: number; hour: number; minute: number } {
  const d = new Date(at + zoneOffset(at, timeZone))
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hour: d.getUTCHours(), minute: d.getUTCMinutes() }
}

/** Years past this are "permanent" on the wikis (9999/01/01). */
const FAR_FUTURE_YEAR = 2100

/**
 * A date written as text: `2026/10/25 03:59`, `2026-10-25 03:59:00`,
 * `2026年10月25日 03:59`, or `10/25 03:59` (the year nearest `now`), in
 * `timeZone`. A date without a time means the start of that day.
 * @returns epoch ms; `null` for a "permanent" date; undefined when unreadable.
 */
export function parseDateText(text: string, timeZone: string, now: number): number | null | undefined {
  const t = text.trim()
  if (/^(长期|永久|常驻)$/.test(t)) return null
  let m = /^(\d{4})\s*[/\-.年]\s*(\d{1,2})\s*[/\-.月]\s*(\d{1,2})(?:\s*日)?(?:[ T]+(\d{1,2})[:：](\d{2})(?::\d{2})?)?/.exec(t)
  let year: number
  let rest: RegExpExecArray
  if (m !== null) {
    year = Number(m[1])
    rest = m
  } else {
    m = /^(\d{1,2})\s*[/\-.月]\s*(\d{1,2})(?:\s*日)?(?:[ T]+(\d{1,2})[:：](\d{2}))?/.exec(t)
    if (m === null) return undefined
    const here = wallClock(now, timeZone).year
    const at = (y: number) => zonedTime(y, Number(m![1]), Number(m![2]), Number(m![3] ?? 0), Number(m![4] ?? 0), timeZone)
    // The year that puts it closest to now: "01/05" read in December is next January.
    return [here - 1, here, here + 1].map(at).sort((a, b) => Math.abs(a - now) - Math.abs(b - now))[0]
  }
  if (year >= FAR_FUTURE_YEAR) return null
  const [, , month, day, hour, minute] = rest
  if (Number(month) < 1 || Number(month) > 12 || Number(day) < 1 || Number(day) > 31) return undefined
  return zonedTime(year, Number(month), Number(day), Number(hour ?? 0), Number(minute ?? 0), timeZone)
}

/**
 * How long is left, as the game shows it: "剩余 3天12小时", "3天", "12小时30分",
 * "3d 12h", "05:12:30" (hours:minutes:seconds), "不足1小时".
 * @returns milliseconds; undefined when there is no duration in the text.
 */
export function parseRemaining(text: string): number | undefined {
  const t = text.replace(/\s+/g, '')
  if (/不足1(小时|时)|<1h/i.test(t)) return 30 * MINUTE
  let total = 0
  let found = false
  for (const [re, unit] of [[/(\d+)(?:天|日|d)/i, DAY], [/(\d+)(?:小时|时|h)/i, HOUR], [/(\d+)(?:分钟|分|m(?!s))/i, MINUTE]] as const) {
    const m = re.exec(t)
    if (m !== null) { total += Number(m[1]) * unit; found = true }
  }
  if (found) return total
  const clock = /(\d{1,3}):(\d{2})(?::(\d{2}))?/.exec(t)
  if (clock !== null) return Number(clock[1]) * HOUR + Number(clock[2]) * MINUTE
  return undefined
}

/** Whole days left until `end` (0 on its last day). */
export function daysLeft(end: number, now: number): number {
  return Math.max(0, Math.floor((end - now) / DAY))
}

/** "还剩 3 天", "今天结束（还剩 5 小时）", "已结束". */
export function leftText(end: number, now: number): string {
  const ms = end - now
  if (ms <= 0) return '已结束'
  if (ms < DAY) {
    const hours = Math.floor(ms / HOUR)
    return hours === 0 ? '不到 1 小时后结束' : `还剩 ${hours} 小时`
  }
  return `还剩 ${daysLeft(end, now)} 天`
}

/** "10/25 03:59" on the wall clock of `timeZone`. */
export function shortDate(at: number, timeZone: string): string {
  const w = wallClock(at, timeZone)
  const pad = (n: number) => String(n).padStart(2, '0')
  return `${pad(w.month)}/${pad(w.day)} ${pad(w.hour)}:${pad(w.minute)}`
}

export const MS = { DAY, HOUR, MINUTE } as const
