/**
 * The monitor: watches every run through the runner's
 * feed and raises incidents —
 *
 *   error / warning   a log rule of that level matched (the pack's rules)
 *   failed            the run ended failed with no earlier error incident
 *   stalled           no new script log line for the script's stall time: its
 *                     own (learned from its clean runs — 1.5 × their longest
 *                     quiet stretch — or set by the agent / the user), else
 *                     its pack's `logs.stallAfter`, else the default (30 s,
 *                     once the run has logged at least one line)
 *   overtime          running past twice the task's `expectedDuration`
 *
 * L0: the pack's `recovery` entries for the incident's tag (`stalled`,
 * `failed`, or a rule tag) run in order — reconnect ADB, restart the task,
 * stop it — each at most `max` times per run chain (a run and its restarts).
 * What L0 does not settle goes to the chat channels with stop / retry /
 * ignore buttons (L3). L1/L2 (agent diagnosis and intervention) are M5.
 *
 * Pure: no Cordis, no timers of its own except the optional `start()` tick;
 * tests drive `tick()` with an injected clock.
 */
import type { Recovery, ScriptManifest } from '@adg/pack-schema'
import type { Incident, IncidentKind, IncidentStep, MonitorSettings, RunInfo, RunLogLine, ScriptStall } from '@adg/protocol'
import type { EmulatorBridge, Runner } from '@adg/runner'
import { parseDuration } from '@adg/runner'

/** What the monitor needs from a chat layer (`@adg/notify`). */
export interface NoticeSink {
  /** @returns names of the channels reached (empty: none set up). */
  send(notice: MonitorNotice): Promise<readonly string[]>
  update(id: string, patch: { text?: string; done?: string }): Promise<void>
}

export interface MonitorNotice {
  readonly id: string
  readonly scope: 'monitor'
  readonly title: string
  readonly text: string
  readonly severity: 'warning' | 'error'
  readonly image?: Buffer
  readonly actions: readonly { id: 'stop' | 'retry' | 'resolve' | 'resume'; label: string; style: 'danger' | 'primary' | 'default' }[]
}

/** What the monitor needs from `@adg/intervene` (L1/L2). */
export interface InterventionPort {
  /** `related`: the other incidents open now, which may have the same cause. */
  handle(incident: Incident, mode: 'diagnose' | 'act', screenshot: Buffer | undefined, related?: readonly Incident[]): Promise<{ state: string; summary: string; paused: boolean; image?: Buffer; sessionId?: string }>
  countToday(): number
  resumeRun(runId: string): Promise<boolean>
  /**
   * The user acted on the incident while the agent is still on it (or waiting to start): the agent stops.
   * `summary`: what to record instead of "you pressed …" (it was settled otherwise, e.g. a later run succeeded).
   */
  cancel?(incidentId: string, why: string, summary?: string): void
  /**
   * The desktop, after bringing the run's windows in front when one of them
   * was out of sight (an error box behind another window, or minimized).
   * `raised`: titles brought into sight; `hidden`: still out of sight.
   */
  captureDesktop?(runId: string): Promise<{ png: Buffer; raised: readonly string[]; hidden: readonly string[] }>
}

export interface MonitorDeps {
  readonly runner: Pick<Runner, 'watch' | 'get' | 'list' | 'logs' | 'stop' | 'restart' | 'warn'> & Partial<Pick<Runner, 'hold' | 'readLog'>>
  readonly packOf: (scriptId: string) => { manifest: ScriptManifest } | undefined
  readonly emulators: () => EmulatorBridge | undefined
  readonly notices: () => NoticeSink | undefined
  readonly intervene?: () => InterventionPort | undefined
  /** A PNG of the whole desktop. */
  readonly desktopScreenshot: () => Promise<Buffer>
  readonly store: IncidentStore
  readonly onIncident: (incident: Incident) => void
  readonly now?: () => number
  /** How long a pipeline waits for the user after an incident was pushed. @default 5 minutes */
  readonly log: { info(message: string): void; warn(message: string): void }
}

/** Settings changes; `undefined` keeps a value. */
export type SettingsPatch = { [K in keyof MonitorSettings]?: MonitorSettings[K] | undefined }

export interface IncidentStore {
  load(): Promise<{ incidents: Incident[]; settings: SettingsPatch }>
  saveIncidents(incidents: readonly Incident[]): Promise<void>
  saveSettings(settings: MonitorSettings): Promise<void>
  saveScreenshot(incidentId: string, png: Buffer): Promise<void>
  readScreenshot(incidentId: string): Promise<Buffer | undefined>
}

/** Seconds a script may be quiet before the agent steps in, until its own normal rhythm is known (`scriptStall`). */
export const DEFAULT_STALL_SECONDS = 30
/** A learned stall time is this much longer than the longest quiet stretch of the recent clean runs. */
const STALL_HEADROOM = 1.5
/** Clean runs a learned stall time is drawn from. */
const STALL_SAMPLES = 5

export const DEFAULT_SETTINGS: MonitorSettings = { defaultStallSeconds: DEFAULT_STALL_SECONDS, scriptStall: {}, notifyWarnings: false, screenshot: true, intervene: 'act', interventionsPerDay: 10 }

const ACTION_WORD = { stop: '停止', retry: '重试', resolve: '忽略', resume: '继续' } as const

/** How long a pipeline waits for the user's answer to a pushed incident before going on. */
const KEEP_INCIDENTS = 300
/** Incidents opened this close together are shown to the agent with the one it handles. */
const RELATED_MS = 60 * 60_000
const TAIL_LINES = 12

interface Watched {
  run: RunInfo
  /** The first run of its restart chain. */
  chain: string
  lastScriptLineAt: number
  sawScriptLine: boolean
  stalled?: string | undefined
  overtime: boolean
  /** The longest stretch between two script log lines so far (ms). */
  longestQuietMs: number
  /** Something was wrong in this run: its quiet stretches do not show the normal rhythm. */
  troubled: boolean
}

type Who = { by: IncidentStep['by']; name?: string }

export class Monitor {
  readonly #deps: MonitorDeps
  readonly #now: () => number
  readonly #watched = new Map<string, Watched>()
  readonly #chains = new Map<string, string>()
  /** Incident → the release of its hold on the run (see Runner.hold). */
  readonly #holds = new Map<string, () => void>()
  /** Incidents whose run a person is stopping from the incident (act stop): they close in its own words. */
  readonly #stopping = new Set<string>()
  /** chain → recovery entry index → times used. */
  readonly #used = new Map<string, Map<number, number>>()
  readonly #incidents: Incident[] = []
  #settings: MonitorSettings = DEFAULT_SETTINGS
  #timer: ReturnType<typeof setInterval> | undefined
  #unwatch: (() => void) | undefined
  /** Serializes work per run so recovery steps never interleave. */
  readonly #queues = new Map<string, Promise<void>>()
  #seq = 0

  constructor(deps: MonitorDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  /** Load saved incidents and settings, follow the runner; `tickMs` 0 = no timer (tests). */
  async start(tickMs = 15_000): Promise<void> {
    const saved = await this.#deps.store.load()
    this.#incidents.push(...saved.incidents.slice(-KEEP_INCIDENTS))
    this.#settings = withPatch(DEFAULT_SETTINGS, saved.settings)
    for (const run of this.#deps.runner.list()) if (run.endedAt === undefined) this.#track(run)
    this.#unwatch = this.#deps.runner.watch({ state: run => this.#onState(run), line: (run, line) => this.#onLine(run, line) })
    if (tickMs > 0) this.#timer = setInterval(() => this.tick(), tickMs)
  }

  stop(): void {
    clearInterval(this.#timer)
    this.#unwatch?.()
  }

  get settings(): MonitorSettings {
    return this.#settings
  }

  async configure(patch: SettingsPatch): Promise<MonitorSettings> {
    this.#settings = withPatch(this.#settings, patch)
    await this.#deps.store.saveSettings(this.#settings)
    return this.#settings
  }

  /**
   * How long this script may be quiet before it counts as stalled: its own (learned from its normal runs, or set
   * by the agent or the user), else what its pack says, else the default.
   */
  stallFor(scriptId: string): { seconds: number; source: 'script' | 'pack' | 'default'; entry?: ScriptStall } {
    const own = this.#settings.scriptStall[scriptId]
    if (own !== undefined) return { seconds: own.seconds, source: 'script', entry: own }
    const declared = parseDuration(this.#deps.packOf(scriptId)?.manifest.logs.stallAfter)
    if (declared !== undefined) return { seconds: Math.round(declared / 1000), source: 'pack' }
    return { seconds: this.#settings.defaultStallSeconds, source: 'default' }
  }

  /** Set (the agent after looking at its normal logs, or the user) or clear (`null`: back to learning from the default) a script's stall time. */
  async setStall(scriptId: string, seconds: number | null, by: 'agent' | 'user', note?: string): Promise<{ seconds: number; source: 'script' | 'pack' | 'default' }> {
    const scriptStall = { ...this.#settings.scriptStall }
    if (seconds === null) delete scriptStall[scriptId]
    else scriptStall[scriptId] = { seconds: Math.max(5, Math.round(seconds)), by, ...(note === undefined || note === '' ? {} : { note: note.slice(0, 300) }), samples: scriptStall[scriptId]?.samples ?? [], at: this.#now() }
    await this.configure({ scriptStall })
    const now = this.stallFor(scriptId)
    return { seconds: now.seconds, source: now.source }
  }

  /**
   * The script's normal rhythm, from the saved logs of its recent runs that went through: the longest and the
   * usual (95%) quiet stretch between two of its log lines in each, for choosing its stall time.
   */
  async rhythm(scriptId: string, runs = 5): Promise<{ runs: { id: string; task: string; lines: number; longestQuietSeconds: number; p95QuietSeconds: number; minutes: number }[]; suggestedSeconds: number | undefined }> {
    const done = this.#deps.runner.list(scriptId).filter(r => r.kind === 'task' && r.state === 'succeeded').sort((a, b) => b.startedAt - a.startedAt).slice(0, runs)
    const out: { id: string; task: string; lines: number; longestQuietSeconds: number; p95QuietSeconds: number; minutes: number }[] = []
    for (const run of done) {
      const times: number[] = []
      for (let from = 1; ; from += 2000) {
        const page = await this.#deps.runner.readLog?.(run.id, { fromLine: from, limit: 2000 }).catch(() => undefined)
        if (page === undefined) break
        for (const line of page.lines) if (line.source !== 'adg') times.push(line.at)
        if (page.lines.length < 2000) break
      }
      const gaps = times.slice(1).map((t, i) => t - times[i]!).sort((a, b) => a - b)
      if (gaps.length === 0) continue
      out.push({
        id: run.id, task: run.taskTitle, lines: times.length,
        longestQuietSeconds: Math.round(gaps.at(-1)! / 1000), p95QuietSeconds: Math.round(gaps[Math.floor(gaps.length * 0.95)]! / 1000),
        minutes: Math.round(((run.endedAt ?? run.startedAt) - run.startedAt) / 60_000),
      })
    }
    const longest = Math.max(0, ...out.map(r => r.longestQuietSeconds))
    return { runs: out, suggestedSeconds: out.length === 0 ? undefined : Math.max(this.#settings.defaultStallSeconds, Math.ceil(longest * STALL_HEADROOM)) }
  }

  /** A clean run went through: its longest quiet stretch is one more sample of the script's normal rhythm. */
  #learn(watched: Watched): void {
    const { run } = watched
    if (watched.troubled || !watched.sawScriptLine) return
    const current = this.#settings.scriptStall[run.scriptId]
    const samples = [...(current?.samples ?? []), Math.round(watched.longestQuietMs / 1000)].slice(-STALL_SAMPLES)
    // Set by the agent or the user: theirs stays; the samples are kept for the next look.
    const seconds = current !== undefined && current.by !== 'learned' ? current.seconds : Math.max(this.#settings.defaultStallSeconds, Math.ceil(Math.max(...samples) * STALL_HEADROOM))
    // Still as quick as the default: nothing to keep yet.
    if (current === undefined && seconds === this.#settings.defaultStallSeconds && this.stallFor(run.scriptId).source === 'default') return
    const entry: ScriptStall = { seconds, by: current?.by ?? 'learned', ...(current?.note === undefined ? {} : { note: current.note }), samples, at: this.#now() }
    void this.configure({ scriptStall: { ...this.#settings.scriptStall, [run.scriptId]: entry } }).catch(error => this.#deps.log.warn(`saving the stall time of ${run.scriptId} failed: ${message(error)}`))
  }

  incidents(filter: { status?: 'open' | 'all' | undefined; runId?: string | undefined; limit?: number | undefined } = {}): Incident[] {
    return this.#incidents
      .filter(i => (filter.status !== 'open' || i.status === 'open') && (filter.runId === undefined || i.runId === filter.runId))
      .slice(-(filter.limit ?? 100))
      .reverse()
  }

  incident(id: string): Incident {
    const found = this.#incidents.find(i => i.id === id)
    if (found === undefined) throw new Error(`没有异常记录 ${id}`)
    return found
  }

  screenshot(id: string): Promise<Buffer | undefined> {
    return this.#deps.store.readScreenshot(id)
  }

  /** Wait until queued recovery work has finished (tests). */
  async idle(): Promise<void> {
    while (this.#queues.size > 0) await Promise.all([...this.#queues.values()])
  }

  /**
   * The user's stop / retry / ignore, from the UI or a chat channel.
   * @throws Error when the action does not apply (e.g. stopping a run that ended).
   */
  async act(id: string, action: 'stop' | 'retry' | 'resolve' | 'resume', who: Who = { by: 'user' }): Promise<Incident> {
    const incident = this.incident(id)
    const by = who.name === undefined ? '' : `（${who.name}）`
    if (who.by === 'user') this.#deps.intervene?.()?.cancel?.(incident.id, ACTION_WORD[action])
    if (action === 'stop') {
      const run = this.#deps.runner.get(incident.runId)
      if (run.endedAt !== undefined) throw new Error(`这次运行已经结束（${run.outcome ?? run.state}）`)
      // Closed below in its own words, not as one of the stopped run's other incidents.
      this.#stopping.add(incident.id)
      try {
        await this.#deps.runner.stop(incident.runId, `按异常处理停止${by}`)
      } finally {
        this.#stopping.delete(incident.id)
      }
      this.#step(incident, { action: 'stop', by: who.by, ok: true, detail: `已停止运行${by}` })
      this.#resolve(incident, `已停止${by}`)
    } else if (action === 'retry') {
      const next = await this.#deps.runner.restart(incident.runId, `按异常处理重试${by}`, { byUser: who.by === 'user' })
      if (next.state === 'failed') throw new Error(`重新运行没有启动：${next.outcome ?? ''}`)
      this.#step(incident, { action: 'restart', by: who.by, ok: true, detail: `已重新运行${by}（${next.id}）` })
      this.#resolve(incident, `已重新运行${by}`)
    } else if (action === 'resume') {
      if (!(await this.#deps.intervene?.()?.resumeRun(incident.runId))) throw new Error('这次运行没有被暂停')
      this.#step(incident, { action: 'resolve', by: who.by, ok: true, detail: `脚本继续运行${by}` })
      this.#resolve(incident, `已继续${by}`)
    } else {
      this.#resolve(incident, `已忽略${by}`)
    }
    return incident
  }

  /** Check every running run for stalls and overtime. */
  tick(): void {
    const now = this.#now()
    for (const watched of this.#watched.values()) {
      const { run } = watched
      if (run.endedAt !== undefined || run.state !== 'running') continue
      const manifest = this.#deps.packOf(run.scriptId)?.manifest
      const stall = this.stallFor(run.scriptId)
      const stallMs = stall.seconds > 0 && (watched.sawScriptLine || stall.source !== 'default') ? stall.seconds * 1000 : undefined
      if (stallMs !== undefined && watched.stalled === undefined && now - watched.lastScriptLineAt > stallMs) {
        const text = `已经 ${quiet(now - watched.lastScriptLineAt)}没有新的日志，可能卡住了（这个脚本超过 ${quiet(stallMs)}没动静就算卡住${stall.source === 'default' ? '，默认值' : ''}）`
        this.#deps.runner.warn(run.id, text)
        watched.stalled = this.#raise(run, 'stalled', 'stalled', text).id
      }
      const expected = parseDuration(manifest?.tasks.find(t => t.id === run.taskId)?.expectedDuration)
      if (expected !== undefined && !watched.overtime && now - run.startedAt > expected * 2) {
        watched.overtime = true
        const text = `已运行超过预计时长的 2 倍（预计 ${manifest?.tasks.find(t => t.id === run.taskId)?.expectedDuration}）`
        this.#deps.runner.warn(run.id, text)
        this.#raise(run, 'overtime', 'overtime', text)
      }
    }
  }

  // ── runner feed ───────────────────────────────────────────────────────

  #track(run: RunInfo): Watched {
    let watched = this.#watched.get(run.id)
    if (watched === undefined) {
      const chain = run.retryOf === undefined ? run.id : this.#chains.get(run.retryOf) ?? run.retryOf
      this.#chains.set(run.id, chain)
      watched = { run, chain, lastScriptLineAt: this.#now(), sawScriptLine: false, overtime: false, longestQuietMs: 0, troubled: false }
      this.#watched.set(run.id, watched)
    }
    watched.run = run
    return watched
  }

  #onLine(run: RunInfo, line: RunLogLine): void {
    if (run.kind !== 'task') return
    const watched = this.#track(run)
    if (line.source !== 'adg') {
      if (watched.sawScriptLine) watched.longestQuietMs = Math.max(watched.longestQuietMs, line.at - watched.lastScriptLineAt)
      watched.lastScriptLineAt = line.at
      watched.sawScriptLine = true
      if (watched.stalled !== undefined) {
        const stalled = this.#incidents.find(i => i.id === watched.stalled)
        if (stalled !== undefined && stalled.status === 'open') this.#resolve(stalled, '脚本恢复了输出')
        watched.stalled = undefined
      }
    }
    if (line.level !== 'error' && line.level !== 'warning') return
    // What a run prints while it is being stopped (or after it was stopped on purpose) is the stop, not a problem.
    if (run.halted === true || run.state === 'stopping') return
    // Read after the run already went through (its log flushed at the end): nothing to handle.
    if (run.state === 'succeeded') return
    const tag = line.tag ?? line.level
    if (this.#incidents.some(i => i.runId === run.id && i.tag === tag && i.status === 'open')) return
    this.#raise(run, line.level, tag, line.text)
  }

  #onState(run: RunInfo): void {
    if (run.kind !== 'task') return
    const watched = this.#track(run)
    // Stopped on purpose (the user, a pipeline being stopped), from the moment it is asked: nothing more to handle
    // for it or the runs it restarted, and an agent handling one of them stops too (it must not launch the game again).
    if (run.halted === true) {
      const chain = this.#chains.get(run.id) ?? run.id
      for (const incident of this.#incidents) {
        if (incident.status !== 'open' || this.#stopping.has(incident.id) || (incident.runId !== run.id && this.#chains.get(incident.runId) !== chain)) continue
        this.#deps.intervene?.()?.cancel?.(incident.id, '停止')
        this.#resolve(incident, '运行已被停止，不再处理')
      }
      if (run.endedAt !== undefined) this.#watched.delete(watched.run.id)
      return
    }
    if (run.endedAt === undefined) return
    this.#watched.delete(watched.run.id)
    const open = this.#incidents.filter(i => i.runId === run.id && i.status === 'open')
    if (run.state === 'failed') {
      if (open.some(i => i.severity === 'error')) {
        for (const incident of open) this.#step(incident, { action: 'notify', by: 'rule', ok: false, detail: `运行结束：失败（${run.outcome ?? ''}）` })
      } else {
        this.#raise(run, 'failed', 'failed', run.outcome ?? '运行失败')
      }
    } else if (run.state === 'succeeded') {
      this.#learn(watched)
      // The task went through after all: what was open about it — this run's (the script got over it itself, e.g.
      // fixed the resolution and went on) and earlier runs' (a restart, or a run the agent or the user started after
      // fixing it) — needs nothing more, and an agent still about to handle one is called off.
      const chain = this.#chains.get(run.id) ?? run.id
      for (const incident of this.#incidents) {
        if (incident.status !== 'open' || incident.scriptId !== run.scriptId || incident.taskId !== run.taskId) continue
        const why = incident.runId === run.id ? '运行最终成功（脚本自己恢复了）'
          : this.#chains.get(incident.runId) === chain ? `重新运行后成功（${run.id}）`
          : `之后同一任务运行成功了（${run.id}），不用再处理`
        this.#deps.intervene?.()?.cancel?.(incident.id, '已解决', `不用再处理：${why}`)
        this.#resolve(incident, why)
      }
    }
  }

  // ── incidents ─────────────────────────────────────────────────────────

  #raise(run: RunInfo, kind: IncidentKind, tag: string, detail: string): Incident {
    const now = this.#now()
    const severity: Incident['severity'] = kind === 'warning' || kind === 'overtime' ? 'warning' : 'error'
    const incident: Incident = {
      id: `inc-${new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${(++this.#seq).toString(36)}${Math.random().toString(36).slice(2, 5)}`,
      runId: run.id, scriptId: run.scriptId, scriptName: run.scriptName, taskId: run.taskId, taskTitle: run.taskTitle,
      kind, severity, tag,
      title: `${run.scriptName} · ${run.taskTitle}：${TITLE[kind]}`,
      detail,
      lines: safeLogs(this.#deps.runner, run.id).map(l => `[${l.source === 'adg' ? '平台' : l.source}] ${l.text}`),
      status: 'open', createdAt: now, updatedAt: now, steps: [], screenshot: false,
    }
    this.#incidents.push(incident)
    const watched = this.#watched.get(run.id)
    if (watched !== undefined) watched.troubled = true
    if (this.#incidents.length > KEEP_INCIDENTS) this.#incidents.splice(0, this.#incidents.length - KEEP_INCIDENTS)
    this.#deps.log.info(`incident ${incident.id} ${kind}/${tag} on ${run.id}: ${detail}`)
    this.#changed(incident)
    // A pipeline following this run waits until the problem is settled — handled, 重试 / 忽略 / 停止, or the task
    // run again successfully (by the agent, the user) — not on a timer: the next step must not start meanwhile.
    if (severity === 'error') {
      const release = this.#deps.runner.hold?.(run.id)
      if (release !== undefined) this.#holds.set(incident.id, release)
    }
    // One script's problems one at a time (often one cause): a later one starts after the earlier is handled, and is
    // checked again first — the earlier handling may have settled it.
    this.#enqueue(run.scriptId, async () => {
      try {
        await this.#handle(incident)
      } finally {
        if (incident.status !== 'open') this.#release(incident.id)
      }
    })
    return incident
  }

  #release(incidentId: string): void {
    this.#holds.get(incidentId)?.()
    this.#holds.delete(incidentId)
  }

  /** L0 recovery, then the screenshot and the notice for whatever is left. */
  /** @returns whether the user was told (a notice went out). */
  async #handle(incident: Incident): Promise<boolean> {
    if (this.#settled(incident)) return false
    const now = this.#now()
    const recovered = await this.#recover(incident)
    if (this.#settled(incident)) return false
    if (incident.severity === 'warning' && !this.#settings.notifyWarnings) return false
    if (recovered) return false
    let image: Buffer | undefined
    if ((this.#settings.screenshot || this.#settings.intervene !== 'off') && incident.severity === 'error') image = await this.#capture(incident)

    // L1/L2: the agent looks (and in `act` mode handles it, the script paused) before the user is told.
    let agent: Awaited<ReturnType<InterventionPort['handle']>> | undefined
    const port = this.#deps.intervene?.()
    if (incident.severity === 'error' && this.#settings.intervene !== 'off' && port !== undefined && !this.#settled(incident)) {
      if (port.countToday() >= this.#settings.interventionsPerDay) {
        this.#step(incident, { action: 'intervene', by: 'rule', ok: false, detail: `今天的 agent 处理次数（${this.#settings.interventionsPerDay}）已用完，直接交给你` })
      } else {
        this.#step(incident, { action: 'intervene', by: 'agent', ok: true, detail: this.#settings.intervene === 'act' ? '交给 agent 处理（脚本暂停，agent 看屏幕并操作）' : '交给 agent 诊断' })
        // The others open now, often the same cause (the game logged out, a resolution, the network): the agent sees them together.
        const related = this.#incidents.filter(i => i.status === 'open' && i.id !== incident.id && now - i.createdAt < RELATED_MS)
        agent = await port.handle(incident, this.#settings.intervene, image, related)
        const fixed = agent.state === 'resolved' || agent.state === 'retried'
        this.#step(incident, { action: 'intervene', by: 'agent', ok: fixed, detail: `${AGENT_STATE[agent.state] ?? agent.state}：${agent.summary}` })
        if (fixed) {
          this.#resolve(incident, `agent 已处理：${agent.summary}`)
          return false
        }
        if (agent.state === 'taken-over' || incident.status !== 'open') return false
        if (agent.image !== undefined) image = agent.image
      }
    }

    const sink = this.#deps.notices()
    if (sink === undefined) return false
    const run = safeGet(this.#deps.runner, incident.runId)
    const paused = agent?.paused === true
    const actions: MonitorNotice['actions'] = [
      ...(paused ? [{ id: 'resume' as const, label: '继续', style: 'primary' as const }] : []),
      ...(run?.endedAt === undefined ? [{ id: 'stop' as const, label: '停止', style: 'danger' as const }] : []),
      { id: 'retry', label: '重试', style: paused ? 'default' : 'primary' },
      { id: 'resolve', label: '忽略', style: 'default' },
    ]
    const tried = incident.steps.filter(s => s.by === 'rule' && s.action !== 'notify' && s.action !== 'intervene').map(s => `${s.ok ? '✓' : '✗'} ${s.detail}`)
    const text = [
      incident.detail,
      ...(agent === undefined ? [] : ['', `agent 看过了：${agent.summary}`, ...(paused ? ['脚本暂停中：处理好以后点「继续」。'] : [])]),
      ...(tried.length > 0 ? ['', '已尝试自动处理：', ...tried] : []),
      '',
      '最近日志：',
      ...incident.lines.slice(-6),
      '',
      paused ? '回复「继续」「停止」「重试」或「忽略」，或直接告诉我怎么处理。' : '回复「停止」「重试」或「忽略」，或直接告诉我怎么处理。',
    ].join('\n')
    try {
      const reached = await sink.send({ id: incident.id, scope: 'monitor', title: incident.title, text, severity: incident.severity, actions, ...(image === undefined ? {} : { image }) })
      this.#step(incident, reached.length > 0
        ? { action: 'notify', by: 'rule', ok: true, detail: `已推送（${reached.join('、')}）` }
        : { action: 'notify', by: 'rule', ok: false, detail: '没有可用的消息渠道，未推送（在「设置 → 飞书」配置）' })
      return reached.length > 0
    } catch (error) {
      this.#step(incident, { action: 'notify', by: 'rule', ok: false, detail: `推送失败：${message(error)}` })
      return false
    }
  }

  /** @returns true when a recovery action ran and the run is being taken care of. */
  async #recover(incident: Incident): Promise<boolean> {
    const manifest = this.#deps.packOf(incident.scriptId)?.manifest
    const entries = (manifest?.recovery ?? []).map((entry, index) => ({ entry, index })).filter(e => e.entry.on === incident.tag)
    if (entries.length === 0) return false
    const chain = this.#chains.get(incident.runId) ?? incident.runId
    const used = this.#used.get(chain) ?? new Map<number, number>()
    this.#used.set(chain, used)
    let acted = false
    for (const { entry, index } of entries) {
      // Stopped meanwhile: no restart behind the user's back.
      if (this.#settled(incident)) return true
      const count = used.get(index) ?? 0
      if (count >= entry.max) {
        this.#step(incident, { action: entry.do, by: 'rule', ok: false, detail: `${DO[entry.do]}已用过 ${count} 次（上限 ${entry.max}），交给你处理` })
        return false
      }
      used.set(index, count + 1)
      try {
        const detail = await this.#perform(incident, entry)
        this.#step(incident, { action: entry.do, by: 'rule', ok: true, detail })
        acted = true
      } catch (error) {
        this.#step(incident, { action: entry.do, by: 'rule', ok: false, detail: `${DO[entry.do]}失败：${message(error)}` })
        return false
      }
    }
    return acted
  }

  async #perform(incident: Incident, entry: Recovery): Promise<string> {
    const run = this.#deps.runner.get(incident.runId)
    switch (entry.do) {
      case 'reconnect-adb': {
        const address = run.resources.find(r => r.startsWith('adb:'))?.slice(4)
        if (address === undefined) throw new Error('这次运行没有使用模拟器')
        const bridge = this.#deps.emulators()
        if (bridge?.reconnect === undefined) throw new Error('模拟器插件没有加载')
        return bridge.reconnect(address, AbortSignal.timeout(10 * 60_000))
      }
      case 'restart': {
        const next = await this.#deps.runner.restart(run.id, `${TITLE[incident.kind]}（${incident.tag}），自动重启`)
        if (next.state === 'failed') throw new Error(next.outcome ?? '没有启动')
        return `已重新运行（${next.id}）`
      }
      case 'stop':
        await this.#deps.runner.stop(run.id, `${TITLE[incident.kind]}，按脚本包设置停止`)
        return '已停止运行'
    }
  }

  async #capture(incident: Incident): Promise<Buffer | undefined> {
    const run = safeGet(this.#deps.runner, incident.runId)
    const address = run?.resources.find(r => r.startsWith('adb:'))?.slice(4)
    try {
      const bridge = this.#deps.emulators()
      let png: Buffer
      let detail: string
      if (address !== undefined && bridge?.screencap !== undefined) {
        png = await bridge.screencap(address, AbortSignal.timeout(30_000))
        detail = `已截取模拟器画面（${address}）`
      } else {
        const desktop = await this.#desktop(incident.runId)
        png = desktop.png
        detail = `已截取桌面${desktop.note}`
      }
      await this.#deps.store.saveScreenshot(incident.id, png)
      incident.screenshot = true
      this.#step(incident, { action: 'screenshot', by: 'rule', ok: true, detail })
      return png
    } catch (error) {
      this.#step(incident, { action: 'screenshot', by: 'rule', ok: false, detail: `截图失败：${message(error)}` })
      return undefined
    }
  }

  /** The desktop, with the run's covered windows brought forward when the intervene plugin can; else as it is. */
  async #desktop(runId: string): Promise<{ png: Buffer; note: string }> {
    const port = this.#deps.intervene?.()
    if (port?.captureDesktop !== undefined) {
      try {
        const shot = await port.captureDesktop(runId)
        const titles = (list: readonly string[]) => list.slice(0, 3).map(t => `「${t}」`).join('、')
        const notes = [
          ...(shot.raised.length > 0 ? [`先把被挡住的${titles(shot.raised)}提到了最前`] : []),
          ...(shot.hidden.length > 0 ? [`${titles(shot.hidden)}还被挡着（可能在置顶窗口下面，或以管理员身份运行）`] : []),
        ]
        return { png: shot.png, note: notes.length > 0 ? `（${notes.join('；')}）` : '' }
      } catch (error) {
        this.#deps.log.warn(`capturing the run's windows failed, taking the desktop as it is: ${message(error)}`)
      }
    }
    return { png: await this.#deps.desktopScreenshot(), note: '' }
  }

  #step(incident: Incident, step: Omit<IncidentStep, 'at'>): void {
    incident.steps.push({ at: this.#now(), ...step })
    this.#changed(incident)
  }

  /** Nothing more to do for it: it was settled, or its run was stopped on purpose. */
  #settled(incident: Incident): boolean {
    return incident.status !== 'open' || safeGet(this.#deps.runner, incident.runId)?.halted === true
  }

  #resolve(incident: Incident, resolution: string): void {
    this.#release(incident.id)
    if (incident.status === 'resolved') return
    incident.status = 'resolved'
    incident.resolution = resolution
    this.#changed(incident)
    void this.#deps.notices()?.update(incident.id, { done: resolution }).catch(() => {})
  }

  #changed(incident: Incident): void {
    incident.updatedAt = this.#now()
    this.#deps.onIncident(structuredClone(incident))
    void this.#deps.store.saveIncidents(this.#incidents).catch(error => this.#deps.log.warn(`saving incidents failed: ${message(error)}`))
  }

  #enqueue(runId: string, work: () => Promise<void>): void {
    const previous = this.#queues.get(runId) ?? Promise.resolve()
    const next = previous.then(work).catch(error => this.#deps.log.warn(`incident handling failed: ${message(error)}`))
    this.#queues.set(runId, next)
    void next.then(() => { if (this.#queues.get(runId) === next) this.#queues.delete(runId) })
  }
}

const AGENT_STATE: Readonly<Record<string, string>> = {
  resolved: '已处理，脚本继续', retried: '已处理，重新运行', 'gave-up': '处理不了', timeout: '超时', failed: '没能开始', 'taken-over': '你接管了',
}

/** A quiet stretch in words: 45 秒, 3 分钟. */
function quiet(ms: number): string {
  const seconds = Math.round(ms / 1000)
  return seconds < 120 ? `${seconds} 秒` : `${Math.round(seconds / 60)} 分钟`
}

const TITLE: Readonly<Record<IncidentKind, string>> = {
  error: '出错', warning: '警告', failed: '运行失败', stalled: '可能卡住了', overtime: '运行超时',
}
const DO: Readonly<Record<Recovery['do'], string>> = { 'reconnect-adb': '重连模拟器', restart: '重新运行', stop: '停止运行' }

function withPatch(base: MonitorSettings, patch: SettingsPatch): MonitorSettings {
  return {
    defaultStallSeconds: patch.defaultStallSeconds ?? base.defaultStallSeconds,
    scriptStall: patch.scriptStall ?? base.scriptStall,
    notifyWarnings: patch.notifyWarnings ?? base.notifyWarnings,
    screenshot: patch.screenshot ?? base.screenshot,
    intervene: patch.intervene ?? base.intervene,
    interventionsPerDay: patch.interventionsPerDay ?? base.interventionsPerDay,
  }
}

function safeGet(runner: Pick<Runner, 'get'>, runId: string): RunInfo | undefined {
  try { return runner.get(runId) } catch { return undefined }
}

function safeLogs(runner: Pick<Runner, 'logs'>, runId: string): RunLogLine[] {
  try { return runner.logs(runId, TAIL_LINES) } catch { return [] }
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
