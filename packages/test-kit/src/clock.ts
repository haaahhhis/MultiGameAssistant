/**
 * Injectable time. Production code takes a `Clock`; tests pass a `ManualClock`
 * and move it forward, so schedules, catch-up windows and stall detection are
 * tested without waiting.
 */
export interface Clock {
  /** Milliseconds since the epoch. */
  now(): number
  /** Run `fn` once after `ms`. @returns a function that cancels it. */
  setTimeout(fn: () => void, ms: number): () => void
}

interface Timer {
  readonly id: number
  readonly at: number
  readonly fn: () => void
}

export class ManualClock implements Clock {
  #now: number
  #timers: Timer[] = []
  #nextId = 1

  constructor(start: number | Date = Date.UTC(2026, 0, 1)) {
    this.#now = typeof start === 'number' ? start : start.getTime()
  }

  now(): number {
    return this.#now
  }

  setTimeout(fn: () => void, ms: number): () => void {
    const timer = { id: this.#nextId++, at: this.#now + Math.max(0, ms), fn }
    this.#timers.push(timer)
    return () => { this.#timers = this.#timers.filter(t => t.id !== timer.id) }
  }

  /** Timers not yet fired. */
  get pending(): number {
    return this.#timers.length
  }

  /**
   * Move time forward, firing due timers in time order (ties in creation
   * order). Timers scheduled by a firing timer also fire if they fall due.
   */
  advance(ms: number): void {
    if (ms < 0) throw new Error('a clock cannot go backwards; use set() to model a wall-clock change')
    const target = this.#now + ms
    for (;;) {
      const due = this.#timers.filter(t => t.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0]
      if (due === undefined) break
      this.#timers = this.#timers.filter(t => t.id !== due.id)
      this.#now = due.at
      due.fn()
    }
    this.#now = target
  }

  /** Jump the wall clock (a DST change, a manual correction) without firing timers. */
  set(time: number | Date): void {
    this.#now = typeof time === 'number' ? time : time.getTime()
  }
}
