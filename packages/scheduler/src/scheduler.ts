/**
 * When pipelines run by themselves.
 *
 * - Times of day per pipeline (optionally only on some weekdays). Each tick
 *   looks at the interval since the previous check, so a time skipped by
 *   sleep, a busy machine or a DST jump is still seen; it runs when it was
 *   missed by no more than the pipeline's grace (`catchUpMinutes`), and is
 *   recorded as missed otherwise — a computer switched on hours late does not
 *   suddenly start the morning's tasks.
 * - Slots are local wall-clock keys (`2026-10-19 04:30`) remembered per
 *   pipeline, so a restart never runs the same slot twice, and the hour a DST
 *   change repeats runs once.
 * - "After" chains: a pipeline whose schedule says `after: X` starts when X
 *   finishes successfully.
 * - On start: each time the app is started (by hand or at logon, not when
 *   the desktop shell restarts a crashed dsh), the chosen pipelines run after
 *   a delay — optionally only on the first start of the day, and skipping
 *   those that already succeeded today.
 * - Timed wake (optional): the upcoming times, a little early, are handed to
 *   the wake port (a Task Scheduler task that wakes the computer from sleep);
 *   kept current once a minute, so edited pipelines are picked up.
 */
import type { Pipeline, PipelineRun, PipelineTrigger, ScheduleEntry, ScheduleSettings } from '@adg/protocol'
import type { WakePort } from './windows.ts'

export interface SavedState {
  settings: ScheduleSettings
  /** End of the last checked interval. */
  lastCheck?: number
  /** Pipeline → slot keys already handled (fired or missed). */
  handled: Record<string, string[]>
  history: ScheduleEntry[]
  /** The local day of the last app start, for "only on the first start of the day". */
  lastStartDay?: string
}

export interface ScheduleStore {
  load(): Promise<Partial<SavedState>>
  save(state: SavedState): Promise<void>
}

/** Starting MultiGameAssistant at logon (a Windows Task Scheduler task). */
export interface AutostartPort {
  available(): boolean
  /** `stale`: registered for this app at a place it no longer is (see `repairAutostart`). */
  status(): Promise<{ registered: boolean; stale?: boolean; detail?: string }>
  register(): Promise<void>
  unregister(): Promise<void>
}

export interface SchedulerDeps {
  readonly pipelines: () => Pipeline[]
  /** @throws Error when it cannot start (already running, check failed). */
  readonly start: (pipelineId: string, trigger: PipelineTrigger) => void
  readonly isRunning: (pipelineId: string) => boolean
  readonly lastSuccessDay: (pipelineId: string) => string | undefined
  readonly store: ScheduleStore
  readonly autostart: AutostartPort
  /** Waking from sleep for scheduled times; absent: not offered. */
  readonly wake?: WakePort
  /** This process was started at logon. */
  readonly autostarted: boolean
  /** The app was just started (not dsh restarted after a crash): run the on-start pipelines. */
  readonly appStart?: boolean
  /** Wait after a start by hand. @default 10000 */
  readonly manualStartDelayMs?: number
  readonly now?: () => number
  readonly changed: () => void
  readonly log: { info(message: string): void; warn(message: string): void }
}

export const DEFAULT_SETTINGS: ScheduleSettings = { autostart: false, autostartPipelines: [], autostartDelaySeconds: 60, skipIfRanToday: true, firstStartOnly: false, wakeToRun: false, powerCountdownSeconds: 60 }
/** Wait after a start by hand (the user is there; the network is up). */
const MANUAL_START_DELAY_MS = 10_000

const KEEP_HANDLED = 40
const KEEP_HISTORY = 100
/** A time is "on time" within this much even with no grace (the tick interval and a slow machine). */
const MIN_GRACE_MS = 90_000
/** Never look back further than this, however long the program was off. */
const MAX_LOOKBACK_MS = 2 * 24 * 3_600_000
/** Wake the computer this long before a scheduled time (the app may have to start first). */
export const WAKE_LEAD_MS = 2 * 60_000
/** At most this many wake-ups registered at once (Task Scheduler allows 48 triggers). */
const WAKE_SLOTS = 32

export class Scheduler {
  readonly #deps: SchedulerDeps
  readonly #now: () => number
  #state: SavedState = { settings: DEFAULT_SETTINGS, handled: {}, history: [] }
  #timer: ReturnType<typeof setInterval> | undefined
  #autostartTimer: ReturnType<typeof setTimeout> | undefined
  #lastSaved = 0
  /** The wake-up times last handed to the wake port, and when that was checked. */
  #wakeSynced: string | undefined
  #wakeChecked = 0
  #wakeError: string | undefined
  /** Timetables are being run (`begin`); a host waiting for the lock only loaded. */
  #running = false

  constructor(deps: SchedulerDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  /** Load, check once, and keep checking every `tickMs` (0: no timer, tests call `tick`). */
  async start(tickMs = 1000): Promise<void> {
    await this.load()
    this.begin(tickMs)
  }

  /** Read the saved state (settings, what was handled) without running anything yet. */
  async load(): Promise<void> {
    const saved = await this.#deps.store.load()
    this.#state = {
      settings: { ...DEFAULT_SETTINGS, ...saved.settings },
      handled: saved.handled ?? {},
      history: saved.history ?? [],
      // First start ever: nothing before now counts as missed.
      lastCheck: saved.lastCheck ?? this.#now(),
      ...(saved.lastStartDay === undefined ? {} : { lastStartDay: saved.lastStartDay }),
    }
  }

  /** Start running timetables (and the on-start pipelines) after `load`. Once only. */
  begin(tickMs = 1000): void {
    if (this.#running) return
    this.#running = true
    this.tick()
    if (tickMs > 0) {
      this.#timer = setInterval(() => this.tick(), tickMs)
      this.#timer.unref?.()
    }
    if (this.#deps.autostarted || this.#deps.appStart === true) {
      const today = localDay(this.#now())
      const firstToday = this.#state.lastStartDay !== today
      this.#state.lastStartDay = today
      void this.#save(true)
      if (this.#state.settings.firstStartOnly && !firstToday) {
        this.#deps.log.info('not the first start today: on-start pipelines skipped')
      } else {
        const delay = this.#deps.autostarted ? this.#state.settings.autostartDelaySeconds * 1000 : this.#deps.manualStartDelayMs ?? MANUAL_START_DELAY_MS
        this.#autostartTimer = setTimeout(() => this.runAutostart(), delay)
        this.#autostartTimer.unref?.()
      }
    }
  }

  stop(): void {
    clearInterval(this.#timer)
    clearTimeout(this.#autostartTimer)
    // Only the host that ran the timetables writes them back; one that only waited holds an old copy.
    if (this.#running) void this.#save(true)
  }

  get settings(): ScheduleSettings {
    return this.#state.settings
  }

  history(): ScheduleEntry[] {
    return [...this.#state.history].reverse()
  }

  /** Look at every planned time in (last check, now]. */
  tick(): void {
    const now = this.#now()
    const from = Math.max(this.#state.lastCheck ?? now, now - MAX_LOOKBACK_MS)
    let changed = false
    if (now > from) {
      for (const pipeline of this.#deps.pipelines()) {
        if (!pipeline.schedule.enabled || pipeline.draft === true || pipeline.schedule.times.length === 0) continue
        for (const slot of slotsBetween(pipeline, from, now)) {
          const handled = this.#state.handled[pipeline.id] ?? []
          if (handled.includes(slot.key)) continue
          this.#state.handled[pipeline.id] = [...handled, slot.key].slice(-KEEP_HANDLED)
          changed = true
          const late = now - slot.at
          const grace = Math.max(pipeline.schedule.catchUpMinutes * 60_000, MIN_GRACE_MS)
          if (late > grace) {
            this.#record(pipeline, slot.key, 'missed', `晚了 ${Math.round(late / 60_000)} 分钟，超过补跑宽限 ${pipeline.schedule.catchUpMinutes} 分钟，没有运行`)
            continue
          }
          this.#fire(pipeline, slot.key, { kind: 'schedule', detail: slot.key.slice(11) })
        }
      }
    }
    this.#state.lastCheck = now
    void this.#save(changed)
    if (changed) this.#deps.changed()
    if (now - this.#wakeChecked >= 60_000) void this.syncWake().catch(() => {})
  }

  /** Give the wake port the upcoming times (none when timed wake is off). @throws Error when registering failed. */
  async syncWake(force = false): Promise<void> {
    const wake = this.#deps.wake
    if (wake === undefined || !wake.available()) return
    const now = this.#now()
    this.#wakeChecked = now
    const times = this.#state.settings.wakeToRun
      ? [...new Set(this.upcoming(WAKE_SLOTS).map(u => u.at - WAKE_LEAD_MS).filter(t => t > now + 30_000))]
      : []
    const key = times.join(',')
    if (!force && key === this.#wakeSynced) return
    this.#wakeSynced = key
    try {
      if (times.length > 0) await wake.sync(times)
      else await wake.remove()
      this.#wakeError = undefined
    } catch (error) {
      this.#wakeSynced = undefined
      this.#wakeError = error instanceof Error ? error.message : String(error)
      this.#deps.log.warn(`timed wake: ${this.#wakeError}`)
      throw error
    } finally {
      this.#deps.changed()
    }
  }

  /** Whether the wake-ups are registered, and the next one. */
  async wakeStatus(): Promise<{ available: boolean; registered: boolean; next?: number; detail?: string }> {
    const wake = this.#deps.wake
    if (wake === undefined || !wake.available()) return { available: false, registered: false, detail: '用浏览器或开发模式打开时不能设置；请用桌面版' }
    const status = await wake.status().catch(error => ({ registered: false, detail: error instanceof Error ? error.message : String(error) }))
    const detail = this.#wakeError ?? status.detail
    return { available: true, ...status, ...(detail === undefined ? {} : { detail }) }
  }

  /** A pipeline finished: start the ones chained after it. */
  pipelineEnded(run: PipelineRun): void {
    if (run.state !== 'succeeded') return
    for (const pipeline of this.#deps.pipelines()) {
      if (pipeline.schedule.after !== run.pipelineId || !pipeline.schedule.enabled || pipeline.draft === true) continue
      this.#fire(pipeline, `after ${run.id}`, { kind: 'after', detail: run.pipelineName })
    }
  }

  /** The pipelines chosen to run when the app starts. */
  runAutostart(): void {
    const today = localDay(this.#now())
    const slot = `${this.#deps.autostarted ? '开机' : '启动'} ${today}`
    const pipelines = new Map(this.#deps.pipelines().map(p => [p.id, p]))
    for (const id of this.#state.settings.autostartPipelines) {
      const pipeline = pipelines.get(id)
      if (pipeline === undefined) continue
      if (this.#state.settings.skipIfRanToday && this.#deps.lastSuccessDay(id) === today) {
        this.#record(pipeline, slot, 'skipped', '今天已经成功运行过')
        continue
      }
      this.#fire(pipeline, slot, { kind: 'autostart' })
    }
    this.#deps.changed()
  }

  /** The next planned times, soonest first. */
  upcoming(limit = 10): { pipelineId: string; pipelineName: string; at: number }[] {
    const now = this.#now()
    const out: { pipelineId: string; pipelineName: string; at: number }[] = []
    for (const pipeline of this.#deps.pipelines()) {
      if (!pipeline.schedule.enabled || pipeline.draft === true) continue
      for (const slot of slotsBetween(pipeline, now, now + 8 * 24 * 3_600_000)) out.push({ pipelineId: pipeline.id, pipelineName: pipeline.name, at: slot.at })
    }
    return out.sort((a, b) => a.at - b.at).slice(0, limit)
  }

  /**
   * With autostart on, a logon task that is gone or stale (it starts this app
   * from where it no longer is: a moved folder, reinstalled dependencies) is
   * registered again, so logon starts the app where it is now.
   * @returns whether it was. @throws Error when registering failed.
   */
  async repairAutostart(): Promise<boolean> {
    const port = this.#deps.autostart
    if (!this.#state.settings.autostart || !port.available()) return false
    const status = await port.status()
    if (status.registered && status.stale !== true) return false
    await port.register()
    return true
  }

  /** @throws Error when autostart cannot be registered here. */
  async configure(patch: { [K in keyof ScheduleSettings]?: ScheduleSettings[K] | undefined }): Promise<ScheduleSettings> {
    const next: ScheduleSettings = {
      autostart: patch.autostart ?? this.#state.settings.autostart,
      autostartPipelines: patch.autostartPipelines ?? this.#state.settings.autostartPipelines,
      autostartDelaySeconds: patch.autostartDelaySeconds ?? this.#state.settings.autostartDelaySeconds,
      skipIfRanToday: patch.skipIfRanToday ?? this.#state.settings.skipIfRanToday,
      firstStartOnly: patch.firstStartOnly ?? this.#state.settings.firstStartOnly,
      wakeToRun: patch.wakeToRun ?? this.#state.settings.wakeToRun,
      powerCountdownSeconds: patch.powerCountdownSeconds ?? this.#state.settings.powerCountdownSeconds,
    }
    if (next.wakeToRun && !this.#state.settings.wakeToRun && this.#deps.wake?.available() !== true) throw new Error('只有桌面版能设置定时唤醒（用浏览器打开界面时不行）')
    if (patch.autostart !== undefined && patch.autostart !== this.#state.settings.autostart) {
      if (patch.autostart) {
        if (!this.#deps.autostart.available()) throw new Error('只有桌面版能设置开机自启（用浏览器打开界面时不行）')
        await this.#deps.autostart.register()
      } else {
        await this.#deps.autostart.unregister()
      }
    }
    const wakeChanged = next.wakeToRun !== this.#state.settings.wakeToRun
    this.#state.settings = next
    await this.#save(true)
    this.#deps.changed()
    if (wakeChanged) {
      try {
        await this.syncWake(true)
      } catch (error) {
        if (next.wakeToRun) {
          this.#state.settings = { ...next, wakeToRun: false }
          await this.#save(true)
          throw error
        }
      }
    }
    return next
  }

  #fire(pipeline: Pipeline, slot: string, trigger: PipelineTrigger): void {
    if (this.#deps.isRunning(pipeline.id)) {
      this.#record(pipeline, slot, 'skipped', '上一次还没有结束')
      return
    }
    try {
      this.#deps.start(pipeline.id, trigger)
      this.#record(pipeline, slot, 'fired')
      this.#deps.log.info(`scheduled ${pipeline.id} (${trigger.kind} ${slot})`)
    } catch (error) {
      this.#record(pipeline, slot, 'failed', error instanceof Error ? error.message : String(error))
    }
  }

  #record(pipeline: Pipeline, slot: string, outcome: ScheduleEntry['outcome'], detail?: string): void {
    this.#state.history.push({ pipelineId: pipeline.id, pipelineName: pipeline.name, slot, at: this.#now(), outcome, ...(detail === undefined ? {} : { detail }) })
    if (this.#state.history.length > KEEP_HISTORY) this.#state.history.splice(0, this.#state.history.length - KEEP_HISTORY)
  }

  /** Persist now when something changed, else at most once a minute (lastCheck). */
  async #save(force: boolean): Promise<void> {
    const now = this.#now()
    if (!force && now - this.#lastSaved < 60_000) return
    this.#lastSaved = now
    await this.#deps.store.save(this.#state).catch(error => this.#deps.log.warn(`saving the schedule failed: ${error instanceof Error ? error.message : String(error)}`))
  }
}

/** Planned times of a pipeline in (from, to], with their local slot keys. */
export function slotsBetween(pipeline: Pipeline, from: number, to: number): { key: string; at: number }[] {
  const out: { key: string; at: number }[] = []
  const day = new Date(from)
  day.setHours(0, 0, 0, 0)
  // One day back too: a slot normalized forward by a DST jump can land after midnight.
  day.setDate(day.getDate() - 1)
  for (let guard = 0; guard < 12 && day.getTime() <= to; guard++, day.setDate(day.getDate() + 1)) {
    const y = day.getFullYear()
    const m = day.getMonth()
    const d = day.getDate()
    const weekday = new Date(y, m, d, 12).getDay()
    if (pipeline.schedule.days.length > 0 && !pipeline.schedule.days.includes(weekday)) continue
    for (const time of pipeline.schedule.times) {
      const [hh, mm] = time.split(':').map(Number) as [number, number]
      const at = new Date(y, m, d, hh, mm, 0, 0).getTime()
      if (at > from && at <= to) out.push({ key: `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')} ${time}`, at })
    }
  }
  return out.sort((a, b) => a.at - b.at)
}

export function localDay(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
