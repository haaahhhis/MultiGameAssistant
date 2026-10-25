/**
 * One scheduler per data folder. Two hosts on the same data (the desktop
 * app and `pnpm dev:host`, or one left behind by an app that did not exit)
 * would both run every timetable and start scripts twice, so whoever holds
 * `schedule.lock` runs schedules and the other waits. The holder rewrites
 * the lock every 30 s; a lock not touched for 90 s belongs to a host that
 * died without cleaning up, and is taken over.
 */
import { readFile, rm, writeFile, mkdir } from 'node:fs/promises'
import { dirname } from 'node:path'

const BEAT_MS = 30_000
const STALE_MS = 90_000

export interface Holder {
  readonly pid: number
  readonly at: number
}

export class ScheduleLock {
  readonly #file: string
  readonly #now: () => number
  readonly #pid: number
  #beat: ReturnType<typeof setInterval> | undefined

  constructor(file: string, options: { now?: () => number; pid?: number } = {}) {
    this.#file = file
    this.#now = options.now ?? Date.now
    this.#pid = options.pid ?? process.pid
  }

  /** Who else holds it, if someone does and is alive. */
  async holder(): Promise<Holder | undefined> {
    try {
      const held = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<Holder>
      if (typeof held.pid !== 'number' || typeof held.at !== 'number' || held.pid === this.#pid) return undefined
      return this.#now() - held.at < STALE_MS && alive(held.pid) ? { pid: held.pid, at: held.at } : undefined
    } catch {
      return undefined
    }
  }

  /** @returns false when another live host holds it. */
  async acquire(): Promise<boolean> {
    if (await this.holder() !== undefined) return false
    await this.#write()
    clearInterval(this.#beat)
    this.#beat = setInterval(() => void this.#write().catch(() => {}), BEAT_MS)
    this.#beat.unref?.()
    return true
  }

  async release(): Promise<void> {
    clearInterval(this.#beat)
    this.#beat = undefined
    try {
      const held = JSON.parse(await readFile(this.#file, 'utf8')) as Partial<Holder>
      if (held.pid === this.#pid) await rm(this.#file, { force: true })
    } catch { /* gone already */ }
  }

  async #write(): Promise<void> {
    await mkdir(dirname(this.#file), { recursive: true })
    await writeFile(this.#file, JSON.stringify({ pid: this.#pid, at: this.#now() }))
  }
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: it exists, it just is not ours to signal.
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}
