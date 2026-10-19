/**
 * When pipelines run by themselves (docs/PLAN.zh.md §5.9).
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
 * - Autostart: when this start was an automatic one (at logon), the chosen
 *   pipelines run after a delay, skipping those that already succeeded today.
 */
import type { Pipeline, PipelineRun, PipelineTrigger, ScheduleEntry, ScheduleSettings } from '@adg/protocol'

export interface SavedState {
  settings: ScheduleSettings
  /** End of the last checked interval. */
  lastCheck?: number
  /** Pipeline → slot keys already handled (fired or missed). */
  handled: Record<string, string[]>
  history: ScheduleEntry[]
}

export interface ScheduleStore {
  load(): Promise<Partial<SavedState>>
  save(state: SavedState): Promise<void>
}

/** Starting AutoDailyGamePlay at logon (a Windows Task Scheduler task). */
export interface AutostartPort {
  available(): boolean
  status(): Promise<{ registered: boolean; detail?: string }>
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
  /** This process was started at logon. */
  readonly autostarted: boolean
  readonly now?: () => number
  readonly changed: () => void
  readonly log: { info(message: string): void; warn(message: string): void }
}

export const DEFAULT_SETTINGS: ScheduleSettings = { autostart: false, autostartPipelines: [], autostartDelaySeconds: 60, skipIfRanToday: true }

const KEEP_HANDLED = 40
const KEEP_HISTORY = 100
/** A time is "on time" within this much even with no grace (the tick interval and a slow machine). */
const MIN_GRACE_MS = 90_000
/** Never look back further than this, however long the program was off. */
const MAX_LOOKBACK_MS = 2 * 24 * 3_600_000

export class Scheduler {
  readonly #deps: SchedulerDeps
  readonly #now: () => number
  #state: SavedState = { settings: DEFAULT_SETTINGS, handled: {}, history: [] }
  #timer: ReturnType<typeof setInterval> | undefined
  #autostartTimer: ReturnType<typeof setTimeout> | undefined
  #lastSaved = 0

  constructor(deps: SchedulerDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  /** Load, check once, and keep checking every `tickMs` (0: no timer, tests call `tick`). */
  async start(tickMs = 1000): Promise<void> {
    const saved = await this.#deps.store.load()
    this.#state = {
      settings: { ...DEFAULT_SETTINGS, ...saved.settings },
      handled: saved.handled ?? {},
      history: saved.history ?? [],
      // First start ever: nothing before now counts as missed.
      lastCheck: saved.lastCheck ?? this.#now(),
    }
    this.tick()
    if (tickMs > 0) {
      this.#timer = setInterval(() => this.tick(), tickMs)
      this.#timer.unref?.()
    }
    if (this.#deps.autostarted) {
      this.#autostartTimer = setTimeout(() => this.runAutostart(), this.#state.settings.autostartDelaySeconds * 1000)
      this.#autostartTimer.unref?.()
    }
  }

  stop(): void {
    clearInterval(this.#timer)
    clearTimeout(this.#autostartTimer)
    void this.#save(true)
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
  }

  /** A pipeline finished: start the ones chained after it. */
  pipelineEnded(run: PipelineRun): void {
    if (run.state !== 'succeeded') return
    for (const pipeline of this.#deps.pipelines()) {
      if (pipeline.schedule.after !== run.pipelineId || !pipeline.schedule.enabled || pipeline.draft === true) continue
      this.#fire(pipeline, `after ${run.id}`, { kind: 'after', detail: run.pipelineName })
    }
  }

  /** The pipelines chosen to run after an automatic start. */
  runAutostart(): void {
    const today = localDay(this.#now())
    const pipelines = new Map(this.#deps.pipelines().map(p => [p.id, p]))
    for (const id of this.#state.settings.autostartPipelines) {
      const pipeline = pipelines.get(id)
      if (pipeline === undefined) continue
      if (this.#state.settings.skipIfRanToday && this.#deps.lastSuccessDay(id) === today) {
        this.#record(pipeline, `开机 ${today}`, 'skipped', '今天已经成功运行过')
        continue
      }
      this.#fire(pipeline, `开机 ${today}`, { kind: 'autostart' })
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

  /** @throws Error when autostart cannot be registered here. */
  async configure(patch: { [K in keyof ScheduleSettings]?: ScheduleSettings[K] | undefined }): Promise<ScheduleSettings> {
    const next: ScheduleSettings = {
      autostart: patch.autostart ?? this.#state.settings.autostart,
      autostartPipelines: patch.autostartPipelines ?? this.#state.settings.autostartPipelines,
      autostartDelaySeconds: patch.autostartDelaySeconds ?? this.#state.settings.autostartDelaySeconds,
      skipIfRanToday: patch.skipIfRanToday ?? this.#state.settings.skipIfRanToday,
    }
    if (patch.autostart !== undefined && patch.autostart !== this.#state.settings.autostart) {
      if (patch.autostart) {
        if (!this.#deps.autostart.available()) throw new Error('只有桌面版能设置开机自启（用浏览器打开界面时不行）')
        await this.#deps.autostart.register()
      } else {
        await this.#deps.autostart.unregister()
      }
    }
    this.#state.settings = next
    await this.#save(true)
    this.#deps.changed()
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
