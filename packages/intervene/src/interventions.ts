/**
 * L1 / L2 (docs/PLAN.zh.md §5.4): what L0 recovery could not settle goes to
 * the agent before it goes to the user.
 *
 *   1. In `act` mode the script is paused (its process tree suspended), so
 *      it and the agent never fight over the screen.
 *   2. An agent session "干预：…" gets the incident, the recent log and the
 *      screenshot. It looks (`screen_capture`), and in `act` mode acts on the
 *      paused run's screen (emulator or desktop); it may also update the
 *      script, stop or rerun it. It ends with `intervention_done`.
 *   3. resolved → the script is resumed; retry → the task runs again;
 *      give-up / timeout → the script stays paused and the user decides
 *      (UI or Feishu: carry on, run again, stop) — the agent's summary and
 *      its last screenshot go with the notice.
 *
 * The user may take over at any point: the agent session is stopped and the
 * script stays paused until they release it.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Incident, Intervention } from '@adg/protocol'
import type { Conversations } from '@adg/notify'
import type { Runner } from '@adg/runner'
import { writeFileAtomic } from '@adg/protocol/node'

export interface InterventionDeps {
  readonly runner: Pick<Runner, 'get' | 'processId' | 'restart' | 'stop' | 'note'>
  /** Suspend or resume a process tree. @returns how many processes changed. */
  readonly suspend: (pid: number, resume: boolean) => Promise<number>
  /**
   * Settle the incident the way a person would (the monitor's 重试 / 继续 /
   * 忽略), for a conclusion that comes after the intervention ended.
   * @returns false when it could not (then the run is restarted or resumed directly).
   */
  readonly settle?: (incidentId: string, action: 'retry' | 'resume' | 'resolve') => Promise<boolean>
  readonly conversations: () => Conversations | undefined
  /** Why the agent cannot look at screenshots now (no image-capable model), if so. */
  readonly visionProblem: () => Promise<string | undefined>
  /** Where the agent can act, in words, for the prompt (e.g. "模拟器 127.0.0.1:16384（target=emulator）"). */
  readonly describeTargets: (run: { resources: readonly string[] }) => string
  readonly onChange: (intervention: Intervention) => void
  readonly dataDir: string
  readonly timeoutMs?: number
  readonly now?: () => number
  readonly log: { info(message: string): void; warn(message: string): void }
}

export interface Active {
  readonly id: string
  readonly runId: string | undefined
  readonly mode: 'diagnose' | 'act'
  /** Locks of the paused run the agent may act on (`desktop`, `adb:…`). */
  readonly allowedKeys: ReadonlySet<string>
  readonly controller: AbortController
  done?: { result: 'resolved' | 'retry' | 'give-up'; summary: string }
  lastShot?: Buffer
}

export interface Outcome {
  readonly state: Intervention['state']
  readonly summary: string
  readonly paused: boolean
  readonly image?: Buffer
  readonly sessionId?: string
}

const KEEP = 100
/** Sessions whose latest screenshot is kept. */
const KEEP_SHOTS = 20

export class Interventions {
  readonly #deps: InterventionDeps
  readonly #now: () => number
  readonly #items: Intervention[] = []
  readonly #active = new Map<string, Active>()
  readonly #bySession = new Map<string, string>()
  /** The latest screenshot of each recent session, for whoever wants to keep it as evidence. */
  readonly #shots = new Map<string, Buffer>()
  #seq = 0

  constructor(deps: InterventionDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  async load(): Promise<void> {
    try {
      const saved = JSON.parse(await readFile(this.#file(), 'utf8')) as Intervention[]
      // Ones cut off by a restart: the agent is gone; the script was killed with the host.
      for (const item of saved) if (item.state === 'running') Object.assign(item, { state: 'failed', summary: item.summary ?? '程序退出时中断', paused: false, endedAt: item.endedAt ?? item.startedAt })
      this.#items.push(...saved.slice(-KEEP))
    } catch { /* none yet */ }
  }

  list(limit = 30): Intervention[] {
    return this.#items.slice(-limit).reverse()
  }

  get(id: string): Intervention {
    const item = this.#items.find(i => i.id === id)
    if (item === undefined) throw new Error(`没有干预记录 ${id}`)
    return item
  }

  /** The intervention a session is doing, for the screen tools' permissions. */
  forSession(sessionId: string | undefined): Active | undefined {
    const id = sessionId === undefined ? undefined : this.#bySession.get(sessionId)
    return id === undefined ? undefined : this.#active.get(id)
  }

  /** Interventions today (for the daily cap). */
  countToday(): number {
    const start = new Date(this.#now())
    start.setHours(0, 0, 0, 0)
    return this.#items.filter(i => i.startedAt >= start.getTime() && i.state !== 'failed').length
  }

  /** `intervention_done` from the agent. @throws Error when the session is not handling one. */
  async done(sessionId: string | undefined, result: 'resolved' | 'retry' | 'give-up', summary: string): Promise<string> {
    const active = this.forSession(sessionId)
    if (active !== undefined) {
      active.done = { result, summary }
      return result === 'give-up' ? '已记录，会把情况和你的说明发给用户。现在结束这一轮回复。' : '已记录，脚本会按你的结论继续。现在结束这一轮回复。'
    }
    // The intervention ended (timed out, handed to the user) but the agent kept at it in the same session.
    const item = sessionId === undefined ? undefined : [...this.#items].reverse().find(i => i.sessionId === sessionId)
    if (item === undefined) throw new Error('这个会话不是在处理异常。要重新运行任务用 script_run，要停止用 script_stop')
    return this.#late(item, result, summary)
  }

  /** A conclusion after the intervention ended: carry it out as the user's button would. */
  async #late(item: Intervention, result: 'resolved' | 'retry' | 'give-up', summary: string): Promise<string> {
    Object.assign(item, { summary, endedAt: this.#now() })
    if (result === 'give-up' || item.runId === undefined) {
      item.state = result === 'give-up' ? 'gave-up' : item.state
      this.#changed(item)
      return '已记录。'
    }
    const settle = (action: 'retry' | 'resume' | 'resolve') => item.incidentId === undefined || this.#deps.settle === undefined
      ? Promise.resolve(false)
      : this.#deps.settle(item.incidentId, action).catch(() => false)
    if (result === 'retry') {
      if (!(await settle('retry'))) await this.#deps.runner.restart(item.runId, `agent 处理后重新运行：${summary}`)
      Object.assign(item, { state: 'retried', paused: false })
      this.#changed(item)
      return '已经重新运行这个任务（异常也标为已处理）。现在结束这一轮回复。'
    }
    if (item.paused) {
      if (!(await settle('resume'))) await this.#resume(item)
      item.paused = false
    } else {
      await settle('resolve')
    }
    item.state = 'resolved'
    this.#changed(item)
    return '已记录，脚本继续运行。现在结束这一轮回复。'
  }

  rememberShot(sessionId: string | undefined, png: Buffer): void {
    const active = this.forSession(sessionId)
    if (active !== undefined) active.lastShot = png
    if (sessionId === undefined) return
    this.#shots.delete(sessionId)
    this.#shots.set(sessionId, png)
    while (this.#shots.size > KEEP_SHOTS) this.#shots.delete(this.#shots.keys().next().value!)
  }

  /** The latest screenshot taken in a session (the last few sessions only). */
  lastShot(sessionId: string): Buffer | undefined {
    return this.#shots.get(sessionId)
  }

  /** Hand an incident to the agent and wait for it to finish. Never throws. */
  async handle(incident: Incident, mode: 'diagnose' | 'act', screenshot: Buffer | undefined): Promise<Outcome> {
    const now = this.#now()
    const item: Intervention = {
      id: `iv-${new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${(++this.#seq).toString(36)}`,
      incidentId: incident.id, runId: incident.runId, title: incident.title, mode, state: 'running', paused: false, startedAt: now,
    }
    this.#items.push(item)
    if (this.#items.length > KEEP) this.#items.splice(0, this.#items.length - KEEP)
    this.#changed(item)

    const finish = (state: Intervention['state'], summary: string, extra: Partial<Outcome> = {}): Outcome => {
      Object.assign(item, { state, summary, endedAt: this.#now() })
      this.#changed(item)
      return { state, summary, paused: item.paused, ...(item.sessionId === undefined ? {} : { sessionId: item.sessionId }), ...extra }
    }

    const problem = await this.#deps.visionProblem().catch(error => (error instanceof Error ? error.message : String(error)))
    if (problem !== undefined) return finish('failed', problem)
    const conversations = this.#deps.conversations()
    if (conversations === undefined) return finish('failed', 'agent 现在不可用（会话服务没有加载）')

    let run: ReturnType<InterventionDeps['runner']['get']> | undefined
    try { run = this.#deps.runner.get(incident.runId) } catch { run = undefined }
    const alive = run !== undefined && run.endedAt === undefined
    // Pause the script so it and the agent do not both drive the screen.
    if (mode === 'act' && alive) {
      const pid = this.#deps.runner.processId(incident.runId)
      if (pid !== undefined) {
        const changed = await this.#deps.suspend(pid, false).catch(error => { this.#deps.log.warn(`pausing ${incident.runId} failed: ${String(error)}`); return 0 })
        item.paused = changed > 0
        if (item.paused) this.#deps.runner.note(incident.runId, 'agent 正在处理异常，脚本已暂停')
      }
    }
    const active: Active = {
      id: item.id, runId: incident.runId, mode, controller: new AbortController(),
      allowedKeys: new Set(mode === 'act' && alive ? (run?.resources ?? []).filter(r => r === 'desktop' || r.startsWith('adb:')) : []),
    }
    this.#active.set(item.id, active)

    let answer = ''
    const limitMs = this.#deps.timeoutMs ?? 15 * 60_000
    const timeout = AbortSignal.timeout(limitMs)
    try {
      const sessionId = await conversations.create(`干预：${incident.title}`, { defaultModel: true })
      item.sessionId = sessionId
      this.#bySession.set(sessionId, item.id)
      this.#changed(item)
      answer = await conversations.ask(sessionId, this.#prompt(incident, mode, item.paused, alive, run?.resources ?? []), AbortSignal.any([active.controller.signal, timeout]), screenshot === undefined ? [] : [screenshot])
    } catch (error) {
      if (item.state === 'taken-over') return { state: 'taken-over', summary: item.summary ?? '你接管了', paused: item.paused }
      if (timeout.aborted && active.done === undefined) return finish('timeout', `agent 在 ${Math.round(limitMs / 60_000)} 分钟内没有处理完`, imageOf(active, screenshot))
      if (active.done === undefined) return finish('gave-up', `agent 处理时出错：${error instanceof Error ? error.message : String(error)}`, imageOf(active, screenshot))
    } finally {
      this.#active.delete(item.id)
    }
    if (item.state === 'taken-over') return { state: 'taken-over', summary: item.summary ?? '你接管了', paused: item.paused }

    const done = active.done ?? { result: 'give-up' as const, summary: answer.slice(0, 600) || 'agent 没有给出结论' }
    if (done.result === 'resolved') {
      await this.#resume(item)
      return finish('resolved', done.summary)
    }
    if (done.result === 'retry') {
      try {
        await this.#deps.runner.restart(incident.runId, `agent 处理后重新运行：${done.summary}`)
        item.paused = false
        return finish('retried', done.summary)
      } catch (error) {
        return finish('gave-up', `${done.summary}（重新运行没有成功：${error instanceof Error ? error.message : String(error)}）`, imageOf(active, screenshot))
      }
    }
    return finish('gave-up', done.summary, imageOf(active, screenshot))
  }

  /** The user takes over: the agent stops; the script stays paused. */
  takeover(id: string): Intervention {
    const item = this.get(id)
    if (item.state !== 'running') throw new Error('这次干预已经结束了')
    Object.assign(item, { state: 'taken-over', summary: '你接管了，agent 已停止', endedAt: this.#now() })
    this.#active.get(id)?.controller.abort(new Error('用户接管'))
    this.#changed(item)
    return item
  }

  /** The user stopped, reran, ignored or resumed the incident's run while the agent was on it. */
  cancel(incidentId: string, why: string): void {
    const item = this.#items.find(i => i.incidentId === incidentId && i.state === 'running')
    if (item === undefined) return
    Object.assign(item, { state: 'taken-over', summary: `你已经点了「${why}」，agent 已停止`, endedAt: this.#now() })
    this.#active.get(item.id)?.controller.abort(new Error(`用户点了「${why}」`))
    this.#changed(item)
  }

  /** Done by hand (or after a give-up): resume, run again, or stop the script. */
  async release(id: string, then: 'resume' | 'restart' | 'stop'): Promise<Intervention> {
    const item = this.get(id)
    if (item.state === 'running') this.takeover(id)
    if (item.runId === undefined) return item
    if (then === 'resume') await this.#resume(item)
    else if (then === 'restart') { await this.#deps.runner.restart(item.runId, '处理完后重新运行'); item.paused = false }
    else { await this.#deps.runner.stop(item.runId, '处理异常后停止'); item.paused = false }
    this.#changed(item)
    return item
  }

  /** Resume a run paused by an intervention (the "继续" button). @returns false when none paused it. */
  async resumeRun(runId: string): Promise<boolean> {
    const item = [...this.#items].reverse().find(i => i.runId === runId && i.paused)
    if (item === undefined) return false
    await this.#resume(item)
    this.#changed(item)
    return true
  }

  async #resume(item: Intervention): Promise<void> {
    if (!item.paused || item.runId === undefined) return
    const pid = this.#deps.runner.processId(item.runId)
    if (pid !== undefined) await this.#deps.suspend(pid, true)
    item.paused = false
    try { this.#deps.runner.note(item.runId, '异常已处理，脚本继续运行') } catch { /* the run is gone */ }
  }

  #prompt(incident: Incident, mode: 'diagnose' | 'act', paused: boolean, alive: boolean, resources: readonly string[]): string {
    const targets = this.#deps.describeTargets({ resources })
    return [
      `自动脚本运行中出了问题，需要你看一下。`,
      `脚本与任务：${incident.scriptName} · ${incident.taskTitle}（脚本 id ${incident.scriptId}，运行 id ${incident.runId}）`,
      `问题：${incident.title}`,
      `详情：${incident.detail}`,
      '',
      '最近日志：',
      ...incident.lines.slice(-10),
      `（完整日志用 script_run_log 查看，run_id 是 ${incident.runId}，可以搜索文字或只看错误）`,
      '',
      '附图是发现问题时的截图。',
      '',
      mode === 'act'
        ? [
            alive ? (paused ? '脚本已经暂停，你操作时它不会动。' : '注意：脚本没能暂停，还在运行。') : '这次运行已经结束了。',
            `你可以操作：${targets}。先用 screen_capture 截图看清楚，再用 screen_tap / screen_swipe / screen_key / screen_type 操作；每做一步都重新截图确认。坐标用最新那张截图的像素坐标。`,
            '常见情况：游戏更新提示（点确认或更新，等它下载完）、网络错误（点重试）、公告或活动弹窗（关掉）、掉线需要重连（点重新连接）。脚本版本太旧导致识别失败时，可以用 script_update 更新脚本，然后选择 retry。',
          ].join('\n')
        : '这次只做诊断：可以用 screen_capture 截图查看，但不要点击或输入。说明原因和建议。',
      '不要修改脚本的文件；不要付费、不要输入密码或验证码（需要的话交给用户）。',
      '',
      '最后必须调用 intervention_done：resolved（已经恢复，脚本可以继续）、retry（需要重新运行这个任务）或 give-up（处理不了）。summary 用一两句话写清楚原因、你做了什么、需要用户做什么。',
    ].join('\n')
  }

  #changed(item: Intervention): void {
    this.#deps.onChange(structuredClone(item))
    void this.#save()
  }

  async #save(): Promise<void> {
    try {
      await writeFileAtomic(this.#file(), JSON.stringify(this.#items))
    } catch (error) {
      this.#deps.log.warn(`saving interventions failed: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  #file(): string {
    return join(this.#deps.dataDir, 'intervene', 'interventions.json')
  }
}

function imageOf(active: Active, fallback: Buffer | undefined): Partial<Outcome> {
  const image = active.lastShot ?? fallback
  return image === undefined ? {} : { image }
}
