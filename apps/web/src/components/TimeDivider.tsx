/**
 * When things were said, in a chat: a centred line before a message that
 * comes after a pause (or on another day), as chat apps do.
 */

/** A pause this long or longer gets a time line. */
export const TIME_GAP = 5 * 60_000

const WEEKDAY = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

const dayOf = (ms: number) => { const d = new Date(ms); return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime() }
const clock = (d: Date) => `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`

/**
 * What a time line shows: the older, the more it says. 「15:05」 today, 「昨天 15:05」,
 * 「周五 15:05」 within the week, 「11月6日 15:05」 this year, 「2025年11月6日 15:05」 before.
 */
export function timeLabel(ms: number, now = Date.now()): string {
  const d = new Date(ms)
  const days = Math.round((dayOf(now) - dayOf(ms)) / 86_400_000)
  if (days <= 0) return clock(d)
  if (days === 1) return `昨天 ${clock(d)}`
  if (days < 7) return `${WEEKDAY[d.getDay()]} ${clock(d)}`
  const year = d.getFullYear() === new Date(now).getFullYear() ? '' : `${d.getFullYear()}年`
  return `${year}${d.getMonth() + 1}月${d.getDate()}日 ${clock(d)}`
}

/** Whether a message at `at` needs a time line, the one before it with a time being at `before`. */
export function needsTime(at: number | undefined, before: number | undefined): boolean {
  if (at === undefined) return false
  return before === undefined || at - before >= TIME_GAP || dayOf(at) !== dayOf(before)
}

/** The day and time in full, without seconds: what a time line shows while the pointer is on it. */
export function dayAndTime(ms: number): string {
  const d = new Date(ms)
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日${WEEKDAY[d.getDay()]} ${clock(d)}`
}

/** As much of the date as its age needs; the pointer on it shows the day and time in full. */
export function TimeDivider({ at }: { at: number }) {
  return (
    <div className="time-divider">
      <span className="time-short">{timeLabel(at)}</span>
      <span className="time-full" aria-hidden>{dayAndTime(at)}</span>
    </div>
  )
}
