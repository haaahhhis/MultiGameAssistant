/**
 * When the daily report goes out: each day at the set local time; at start,
 * today's report is sent late if the computer was off at that time (within
 * a few hours), and never twice on one day.
 */

export interface Clock {
  now(): number
  /** @returns a function that cancels it. */
  setTimeout(fn: () => void, ms: number): () => void
}

export const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const timer = setTimeout(fn, Math.min(ms, 2 ** 31 - 1))
    timer.unref?.()
    return () => clearTimeout(timer)
  },
}

/** A report missed by more than this (the computer was off) is skipped for the day. */
const CATCH_UP_MS = 6 * 3_600_000

export interface DailyDeps {
  readonly clock: Clock
  /** The report time `HH:mm`, or undefined when the report is off. */
  readonly at: () => string | undefined
  /** The local day (YYYY-MM-DD) the last report was for. */
  readonly lastDay: () => string | undefined
  readonly send: (day: string) => Promise<void>
  readonly log: { warn(message: string): void }
}

/** `YYYY-MM-DD` on the host's wall clock. */
export function localDay(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** That day's `HH:mm` on the host's wall clock, as epoch ms. */
function timeOn(day: number, at: string): number {
  const d = new Date(day)
  const [h, m] = at.split(':').map(Number)
  return new Date(d.getFullYear(), d.getMonth(), d.getDate(), h, m).getTime()
}

export class DailyReport {
  readonly #deps: DailyDeps
  #cancel: (() => void) | undefined
  #sending: Promise<void> | undefined
  #stopped = false
  /** The day last tried, so a failed send is not retried in a loop (the next try is tomorrow, or 立即发送). */
  #tried: string | undefined

  constructor(deps: DailyDeps) {
    this.#deps = deps
  }

  /** When it goes out next; undefined when off. */
  next(): number | undefined {
    const at = this.#deps.at()
    if (at === undefined) return undefined
    const now = this.#deps.clock.now()
    const today = timeOn(now, at)
    if (today > now && this.#deps.lastDay() !== localDay(now) && this.#tried !== localDay(now)) return today
    // Tomorrow: a day later on the wall clock (DST-safe via the Date constructor).
    const d = new Date(now)
    return timeOn(new Date(d.getFullYear(), d.getMonth(), d.getDate() + 1, 12).getTime(), at)
  }

  /** Start, or pick up changed settings. Sends a late report for today when it was missed. */
  start(): void {
    this.#stopped = false
    this.#cancel?.()
    this.#cancel = undefined
    const at = this.#deps.at()
    if (at === undefined) return
    const now = this.#deps.clock.now()
    const due = timeOn(now, at)
    const today = localDay(now)
    if (now >= due && now - due < CATCH_UP_MS && this.#deps.lastDay() !== today && this.#tried !== today) {
      void this.#fire(today)
      return
    }
    const next = this.next()
    if (next === undefined) return
    this.#cancel = this.#deps.clock.setTimeout(() => void this.#fire(localDay(next)), next - now)
  }

  stop(): void {
    this.#stopped = true
    this.#cancel?.()
    this.#cancel = undefined
  }

  async #fire(day: string): Promise<void> {
    this.#cancel = undefined
    if (this.#stopped) return
    if (this.#deps.lastDay() !== day && this.#sending === undefined) {
      this.#tried = day
      this.#sending = this.#deps.send(day).catch(error => this.#deps.log.warn(`daily game report failed: ${error instanceof Error ? error.message : String(error)}`))
      await this.#sending
      this.#sending = undefined
    }
    if (!this.#stopped) this.start()
  }
}
