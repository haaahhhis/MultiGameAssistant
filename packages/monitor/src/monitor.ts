/**
 * The monitor (docs/PLAN.zh.md §5.4): watches every run through the runner's
 * feed and raises incidents —
 *
 *   error / warning   a log rule of that level matched (the pack's rules)
 *   failed            the run ended failed with no earlier error incident
 *   stalled           no new script log line for `logs.stallAfter` (or the
 *                     default, once the run has logged at least one line)
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
import type { Incident, IncidentKind, IncidentStep, MonitorSettings, RunInfo, RunLogLine } from '@adg/protocol'
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
  handle(incident: Incident, mode: 'diagnose' | 'act', screenshot: Buffer | undefined): Promise<{ state: string; summary: string; paused: boolean; image?: Buffer; sessionId?: string }>
  countToday(): number
  resumeRun(runId: string): Promise<boolean>
  /** The user acted on the incident while the agent is still on it: the agent stops. */
  cancel?(incidentId: string, why: string): void
}

export interface MonitorDeps {
  readonly runner: Pick<Runner, 'watch' | 'get' | 'list' | 'logs' | 'stop' | 'restart' | 'warn'>
  readonly packOf: (scriptId: string) => { manifest: ScriptManifest } | undefined
  readonly emulators: () => EmulatorBridge | undefined
  readonly notices: () => NoticeSink | undefined
  readonly intervene?: () => InterventionPort | undefined
  /** A PNG of the whole desktop. */
  readonly desktopScreenshot: () => Promise<Buffer>
  readonly store: IncidentStore
  readonly onIncident: (incident: Incident) => void
  readonly now?: () => number
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

export const DEFAULT_SETTINGS: MonitorSettings = { defaultStallMinutes: 30, notifyWarnings: false, screenshot: true, intervene: 'act', interventionsPerDay: 10 }

const ACTION_WORD = { stop: '停止', retry: '重试', resolve: '忽略', resume: '继续' } as const

const KEEP_INCIDENTS = 300
const TAIL_LINES = 12

interface Watched {
  run: RunInfo
  /** The first run of its restart chain. */
  chain: string
  lastScriptLineAt: number
  sawScriptLine: boolean
  stalled?: string | undefined
  overtime: boolean
}

type Who = { by: IncidentStep['by']; name?: string }

export class Monitor {
  readonly #deps: MonitorDeps
  readonly #now: () => number
  readonly #watched = new Map<string, Watched>()
  readonly #chains = new Map<string, string>()
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
      await this.#deps.runner.stop(incident.runId, `按异常处理停止${by}`)
      this.#step(incident, { action: 'stop', by: who.by, ok: true, detail: `已停止运行${by}` })
      this.#resolve(incident, `已停止${by}`)
    } else if (action === 'retry') {
      const next = await this.#deps.runner.restart(incident.runId, `按异常处理重试${by}`)
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
      const declared = parseDuration(manifest?.logs.stallAfter)
      const stallMs = declared ?? (watched.sawScriptLine && this.#settings.defaultStallMinutes > 0 ? this.#settings.defaultStallMinutes * 60_000 : undefined)
      if (stallMs !== undefined && watched.stalled === undefined && now - watched.lastScriptLineAt > stallMs) {
        const minutes = Math.round((now - watched.lastScriptLineAt) / 60_000)
        const text = `已经 ${minutes} 分钟没有新的日志，可能卡住了`
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
      watched = { run, chain, lastScriptLineAt: this.#now(), sawScriptLine: false, overtime: false }
      this.#watched.set(run.id, watched)
    }
    watched.run = run
    return watched
  }

  #onLine(run: RunInfo, line: RunLogLine): void {
    if (run.kind !== 'task') return
    const watched = this.#track(run)
    if (line.source !== 'adg') {
      watched.lastScriptLineAt = line.at
      watched.sawScriptLine = true
      if (watched.stalled !== undefined) {
        const stalled = this.#incidents.find(i => i.id === watched.stalled)
        if (stalled !== undefined && stalled.status === 'open') this.#resolve(stalled, '脚本恢复了输出')
        watched.stalled = undefined
      }
    }
    if (line.level !== 'error' && line.level !== 'warning') return
    const tag = line.tag ?? line.level
    if (this.#incidents.some(i => i.runId === run.id && i.tag === tag && i.status === 'open')) return
    this.#raise(run, line.level, tag, line.text)
  }

  #onState(run: RunInfo): void {
    if (run.kind !== 'task') return
    const watched = this.#track(run)
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
      // A restart that went through settles the incidents of the runs before it.
      const chain = this.#chains.get(run.id) ?? run.id
      for (const incident of this.#incidents) {
        if (incident.status === 'open' && incident.runId !== run.id && this.#chains.get(incident.runId) === chain) this.#resolve(incident, `重新运行后成功（${run.id}）`)
      }
      for (const incident of open) if (incident.kind === 'warning' || incident.kind === 'overtime' || incident.kind === 'stalled') this.#resolve(incident, '运行最终成功')
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
    if (this.#incidents.length > KEEP_INCIDENTS) this.#incidents.splice(0, this.#incidents.length - KEEP_INCIDENTS)
    this.#deps.log.info(`incident ${incident.id} ${kind}/${tag} on ${run.id}: ${detail}`)
    this.#changed(incident)
    this.#enqueue(run.id, () => this.#handle(incident))
    return incident
  }

  /** L0 recovery, then the screenshot and the notice for whatever is left. */
  async #handle(incident: Incident): Promise<void> {
    const recovered = await this.#recover(incident)
    if (incident.severity === 'warning' && !this.#settings.notifyWarnings) return
    if (recovered) return
    let image: Buffer | undefined
    if ((this.#settings.screenshot || this.#settings.intervene !== 'off') && incident.severity === 'error') image = await this.#capture(incident)

    // L1/L2: the agent looks (and in `act` mode handles it, the script paused) before the user is told.
    let agent: Awaited<ReturnType<InterventionPort['handle']>> | undefined
    const port = this.#deps.intervene?.()
    if (incident.severity === 'error' && this.#settings.intervene !== 'off' && port !== undefined && incident.status === 'open') {
      if (port.countToday() >= this.#settings.interventionsPerDay) {
        this.#step(incident, { action: 'intervene', by: 'rule', ok: false, detail: `今天的 agent 处理次数（${this.#settings.interventionsPerDay}）已用完，直接交给你` })
      } else {
        this.#step(incident, { action: 'intervene', by: 'agent', ok: true, detail: this.#settings.intervene === 'act' ? '交给 agent 处理（脚本暂停，agent 看屏幕并操作）' : '交给 agent 诊断' })
        agent = await port.handle(incident, this.#settings.intervene, image)
        const fixed = agent.state === 'resolved' || agent.state === 'retried'
        this.#step(incident, { action: 'intervene', by: 'agent', ok: fixed, detail: `${AGENT_STATE[agent.state] ?? agent.state}：${agent.summary}` })
        if (fixed) {
          this.#resolve(incident, `agent 已处理：${agent.summary}`)
          return
        }
        if (agent.state === 'taken-over' || incident.status !== 'open') return
        if (agent.image !== undefined) image = agent.image
      }
    }

    const sink = this.#deps.notices()
    if (sink === undefined) return
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
    } catch (error) {
      this.#step(incident, { action: 'notify', by: 'rule', ok: false, detail: `推送失败：${message(error)}` })
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
      const png = address !== undefined && bridge?.screencap !== undefined
        ? await bridge.screencap(address, AbortSignal.timeout(30_000))
        : await this.#deps.desktopScreenshot()
      await this.#deps.store.saveScreenshot(incident.id, png)
      incident.screenshot = true
      this.#step(incident, { action: 'screenshot', by: 'rule', ok: true, detail: address === undefined ? '已截取桌面' : `已截取模拟器画面（${address}）` })
      return png
    } catch (error) {
      this.#step(incident, { action: 'screenshot', by: 'rule', ok: false, detail: `截图失败：${message(error)}` })
      return undefined
    }
  }

  #step(incident: Incident, step: Omit<IncidentStep, 'at'>): void {
    incident.steps.push({ at: this.#now(), ...step })
    this.#changed(incident)
  }

  #resolve(incident: Incident, resolution: string): void {
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

const TITLE: Readonly<Record<IncidentKind, string>> = {
  error: '出错', warning: '警告', failed: '运行失败', stalled: '可能卡住了', overtime: '运行超时',
}
const DO: Readonly<Record<Recovery['do'], string>> = { 'reconnect-adb': '重连模拟器', restart: '重新运行', stop: '停止运行' }

function withPatch(base: MonitorSettings, patch: SettingsPatch): MonitorSettings {
  return {
    defaultStallMinutes: patch.defaultStallMinutes ?? base.defaultStallMinutes,
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
