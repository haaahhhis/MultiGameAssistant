/**
 * Running pipelines (docs/PLAN.zh.md §5.3). A node starts when every edge
 * into it is settled and satisfied (`success` / `failure` / `always`); an edge
 * that can no longer be satisfied skips the node. Script tasks whose
 * resources are busy wait ("等待资源：…") and start when the resource frees
 * up — drawing two desktop tasks in parallel simply makes them take turns.
 * A failed node is retried per its policy, then the pipeline carries on with
 * the other branches or stops. A run the monitor restarts (L0) is followed to
 * its replacement.
 *
 * Pure apart from the injected runner, chat and agent ports; tests drive it
 * with fake scripts.
 */
import { isMarker, type Pipeline, type PipelineNode, type PipelineRun, type PipelineTrigger, type NodeRun, type RunInfo } from '@adg/protocol'
import type { Conversations } from '@adg/notify'
import { BusyError, type Runner } from '@adg/runner'
import { checkPipeline, nodeLabel, type CheckLibrary } from './check.ts'

export interface EngineNotice {
  readonly id: string
  readonly scope: 'pipeline'
  readonly title: string
  readonly text: string
  readonly severity: 'info' | 'success' | 'warning' | 'error'
  readonly actions?: readonly { id: string; label: string; style?: 'primary' | 'danger' | 'default' }[]
}

export interface EngineDeps {
  readonly runner: Pick<Runner, 'start' | 'check' | 'stop' | 'finished' | 'watch' | 'successor'>
  readonly library: CheckLibrary
  readonly notices: () => { send(notice: EngineNotice): Promise<readonly string[]>; update(id: string, patch: { done?: string }): Promise<void> } | undefined
  readonly conversations: () => Conversations | undefined
  readonly emulators: () => { stop(index?: number): Promise<void> } | undefined
  readonly onRun: (run: PipelineRun) => void
  readonly now?: () => number
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
  /** How often waiting nodes try again besides when a run ends. @default 5000 */
  readonly retryWaitingMs?: number
  readonly log: { info(message: string): void; warn(message: string): void }
}

interface Active {
  run: PipelineRun
  pipeline: Pipeline
  controller: AbortController
  executing: Set<string>
  gates: Map<string, (decision: 'continue' | 'stop') => void>
  agentSession?: string
  usedEmulator: boolean
  cancelReason?: string
  /** `user`: cancelled; `failure`: stopped because a node failed (the run counts as failed). */
  cancelKind?: 'user' | 'failure'
  pumping: boolean
  again: boolean
  retryWaiting: boolean
  finished: Promise<PipelineRun>
  resolve: (run: PipelineRun) => void
}

type Outcome = { ok: true; detail?: string } | { ok: false; detail: string; stopPipeline?: boolean }

const UNATTENDED = new Set<PipelineTrigger['kind']>(['schedule', 'autostart', 'after'])

export class Engine {
  readonly #deps: EngineDeps
  readonly #now: () => number
  readonly #active = new Map<string, Active>()
  readonly #sleep: (ms: number, signal: AbortSignal) => Promise<void>
  readonly #timer: ReturnType<typeof setInterval>
  readonly #unwatch: () => void
  readonly #ended = new Set<(run: PipelineRun) => void>()

  constructor(deps: EngineDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
    this.#sleep = deps.sleep ?? sleep
    // A run ending frees resources: waiting nodes may go now.
    this.#unwatch = deps.runner.watch({ state: run => { if (run.endedAt !== undefined) this.#pumpAll() } })
    this.#timer = setInterval(() => this.#pumpAll(), deps.retryWaitingMs ?? 5000)
    this.#timer.unref?.()
  }

  dispose(): void {
    clearInterval(this.#timer)
    this.#unwatch()
    for (const active of this.#active.values()) this.#cancel(active, '程序正在退出')
  }

  /** Called with every finished pipeline run (the scheduler chains "after" pipelines). */
  onEnded(listener: (run: PipelineRun) => void): () => void {
    this.#ended.add(listener)
    return () => { this.#ended.delete(listener) }
  }

  active(): PipelineRun[] {
    return [...this.#active.values()].map(a => structuredClone(a.run))
  }

  isRunning(pipelineId: string): boolean {
    return [...this.#active.values()].some(a => a.pipeline.id === pipelineId)
  }

  /**
   * Start a pipeline; returns at once with the run.
   * @throws Error when the check finds errors or the pipeline is already running.
   */
  start(pipeline: Pipeline, trigger: PipelineTrigger): PipelineRun {
    const check = checkPipeline(pipeline, this.#deps.library)
    const firstError = check.issues.find(i => i.level === 'error')
    if (firstError !== undefined) throw new Error(`流水线有问题，没有运行：${firstError.message}`)
    if (this.isRunning(pipeline.id)) throw new Error(`「${pipeline.name}」正在运行，等它结束再运行`)
    const now = this.#now()
    const run: PipelineRun = {
      id: `pl-${new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`,
      pipelineId: pipeline.id, pipelineName: pipeline.name, trigger, state: 'running',
      nodes: Object.fromEntries(pipeline.nodes.map(n => [n.id, { state: 'pending', runIds: [], attempts: 0 } satisfies NodeRun])),
      startedAt: now,
    }
    let resolve!: (run: PipelineRun) => void
    const finished = new Promise<PipelineRun>(r => { resolve = r })
    const active: Active = { run, pipeline, controller: new AbortController(), executing: new Set(), gates: new Map(), usedEmulator: false, pumping: false, again: false, retryWaiting: false, finished, resolve }
    this.#active.set(run.id, active)
    this.#deps.log.info(`pipeline ${pipeline.id} started (${trigger.kind}) as ${run.id}`)
    this.#emit(active)
    this.#pump(active)
    return structuredClone(run)
  }

  /** Settles when the run ends. */
  finished(runId: string): Promise<PipelineRun> {
    const active = this.#active.get(runId)
    if (active === undefined) throw new Error(`没有正在进行的流水线运行 ${runId}`)
    return active.finished
  }

  cancel(runId: string, reason = '已取消'): void {
    const active = this.#active.get(runId)
    if (active === undefined) throw new Error(`没有正在进行的流水线运行 ${runId}`)
    this.#cancel(active, reason)
  }

  /** Answer a gate node. @throws Error when it is not waiting for an answer. */
  gate(runId: string, nodeId: string, decision: 'continue' | 'stop'): void {
    const answer = this.#active.get(runId)?.gates.get(nodeId)
    if (answer === undefined) throw new Error('这一步没有在等确认（可能已经回答过了）')
    answer(decision)
  }

  // ── scheduling nodes ──────────────────────────────────────────────────

  /** A run ended or the timer ticked: waiting nodes may try again. */
  #pumpAll(): void {
    for (const active of this.#active.values()) this.#pump(active, true)
  }

  #pump(active: Active, retryWaiting = false): void {
    if (active.pumping) { active.again = true; active.retryWaiting ||= retryWaiting; return }
    active.pumping = true
    active.retryWaiting ||= retryWaiting
    try {
      do {
        active.again = false
        const retry = active.retryWaiting
        active.retryWaiting = false
        this.#step(active, retry)
      } while (active.again)
    } finally {
      active.pumping = false
    }
  }

  #step(active: Active, retryWaiting: boolean): void {
    const { run, pipeline } = active
    if (run.state !== 'running') return
    for (const node of pipeline.nodes) {
      const state = run.nodes[node.id]!
      if ((state.state !== 'pending' && state.state !== 'waiting') || active.executing.has(node.id)) continue
      if (state.state === 'waiting' && !retryWaiting && active.cancelReason === undefined) continue
      if (active.cancelReason !== undefined) {
        this.#set(active, node.id, { state: 'cancelled', detail: active.cancelReason })
        continue
      }
      const incoming = pipeline.edges.filter(e => e.to === node.id)
      // 结束 waits for everything else, whatever its edges say; it is never skipped.
      if (node.kind === 'end' && pipeline.nodes.some(n => n.id !== node.id && !final(run.nodes[n.id]!.state))) continue
      if (incoming.some(e => !final(run.nodes[e.from]!.state))) continue
      const blocked = node.kind === 'end' ? undefined : incoming.find(e => !satisfied(e.when, run.nodes[e.from]!.state))
      if (blocked !== undefined) {
        const from = pipeline.nodes.find(n => n.id === blocked.from)!
        this.#set(active, node.id, { state: 'skipped', detail: `「${nodeLabel(from, this.#deps.library)}」${STATE_WORD[run.nodes[blocked.from]!.state]}，按连线条件跳过` })
        active.again = true
        continue
      }
      active.executing.add(node.id)
      void this.#runNode(active, node)
        .catch(error => this.#set(active, node.id, { state: 'failed', detail: message(error) }))
        .finally(() => {
          active.executing.delete(node.id)
          this.#pump(active)
        })
    }
    if (active.executing.size === 0 && pipeline.nodes.every(n => final(run.nodes[n.id]!.state))) {
      void this.#finish(active)
    }
  }

  async #runNode(active: Active, node: PipelineNode): Promise<void> {
    const state = active.run.nodes[node.id]!
    if (node.kind === 'script-task') {
      const { busy } = await this.#deps.runner.check(node.scriptId, node.taskId)
      if (busy !== undefined) {
        this.#set(active, node.id, { state: 'waiting', detail: `等待资源：${busy.resource}` })
        return
      }
    }
    this.#set(active, node.id, { state: 'running', attempts: state.attempts + 1, ...(state.startedAt === undefined ? { startedAt: this.#now() } : {}), detail: '' })
    let outcome: Outcome
    try {
      outcome = await this.#execute(active, node)
    } catch (error) {
      if (error instanceof BusyError) {
        // Someone took the resource between the check and the start: wait, and do not count the attempt.
        this.#set(active, node.id, { state: 'waiting', attempts: state.attempts - 1, detail: `等待资源：${error.resource}` })
        return
      }
      outcome = { ok: false, detail: message(error) }
    }
    if (active.cancelReason !== undefined) {
      this.#set(active, node.id, { state: 'cancelled', endedAt: this.#now(), detail: active.cancelReason })
      return
    }
    if (outcome.ok) {
      this.#set(active, node.id, { state: 'succeeded', endedAt: this.#now(), ...(outcome.detail === undefined ? {} : { detail: outcome.detail }) })
      return
    }
    const policy = node.onFailure ?? active.pipeline.onFailure
    const attempts = active.run.nodes[node.id]!.attempts
    if (!outcome.stopPipeline && attempts <= policy.retries) {
      this.#set(active, node.id, { state: 'pending', detail: `第 ${attempts} 次失败（${outcome.detail}），重试` })
      return
    }
    this.#set(active, node.id, { state: 'failed', endedAt: this.#now(), detail: outcome.detail })
    if (outcome.stopPipeline) this.#cancel(active, '你选择了停止', 'failure')
    else if (policy.then === 'stop') this.#cancel(active, `「${nodeLabel(node, this.#deps.library)}」失败，按设置停止流水线`, 'failure')
  }

  async #execute(active: Active, node: PipelineNode): Promise<Outcome> {
    const signal = active.controller.signal
    switch (node.kind) {
      case 'script-task': {
        let current: RunInfo = await this.#deps.runner.start(node.scriptId, node.taskId, node.params)
        for (;;) {
          this.#addRun(active, node.id, current)
          if (current.endedAt !== undefined && current.state === 'failed') return { ok: false, detail: current.outcome ?? '没有启动' }
          const ended = await this.#deps.runner.finished(current.id)
          const next = await this.#deps.runner.successor(current.id)
          if (next === undefined || active.cancelReason !== undefined) {
            return ended.state === 'succeeded' ? { ok: true, detail: ended.outcome ?? '成功' } : { ok: false, detail: ended.outcome ?? ended.state }
          }
          current = next
        }
      }
      case 'agent': {
        const conversations = this.#deps.conversations()
        if (conversations === undefined) return { ok: false, detail: 'agent 现在不可用（会话服务没有加载）' }
        active.agentSession ??= await conversations.create(`编排：${active.pipeline.name}`)
        const answer = await conversations.ask(active.agentSession, node.prompt, signal)
        const clipped = answer.length > 300 ? `${answer.slice(0, 300)}…` : answer
        return answer.startsWith('（这一轮没有完成') ? { ok: false, detail: clipped } : { ok: true, detail: clipped }
      }
      case 'wait': {
        const ms = node.minutes !== undefined ? node.minutes * 60_000 : untilMs(node.until!, this.#now())
        this.#set(active, node.id, { detail: `等到 ${new Date(this.#now() + ms).toLocaleTimeString('zh-CN', { hour12: false })}` })
        await this.#sleep(ms, signal).catch(() => {})
        return { ok: true }
      }
      case 'notify': {
        const sink = this.#deps.notices()
        const reached = sink === undefined ? [] : await sink.send({ id: `pipeline:${active.run.id}:${node.id}`, scope: 'pipeline', title: active.pipeline.name, text: node.text, severity: 'info' })
        return { ok: true, detail: reached.length > 0 ? `已发送（${reached.join('、')}）` : '没有可用的消息渠道，未发送' }
      }
      case 'start':
        return { ok: true }
      case 'end': {
        const failed = active.pipeline.nodes.filter(n => active.run.nodes[n.id]!.state === 'failed').length
        return { ok: true, detail: failed > 0 ? `结束（${failed} 个失败）` : '全部完成' }
      }
      case 'gate': {
        const noticeId = `pipeline:${active.run.id}:${node.id}`
        const decision = new Promise<'continue' | 'stop'>(resolve => active.gates.set(node.id, resolve))
        this.#set(active, node.id, { detail: '等你确认（界面或飞书）' })
        const sink = this.#deps.notices()
        await sink?.send({
          id: noticeId, scope: 'pipeline', title: `${active.pipeline.name}：需要你确认`, text: node.text, severity: 'warning',
          actions: [{ id: 'continue', label: '继续', style: 'primary' }, { id: 'stop', label: '停止', style: 'danger' }],
        }).catch(() => {})
        const aborted = new Promise<'abort'>(resolve => signal.addEventListener('abort', () => resolve('abort'), { once: true }))
        const answer = await Promise.race([decision, aborted])
        active.gates.delete(node.id)
        void sink?.update(noticeId, { done: answer === 'continue' ? '已继续' : '已停止' }).catch(() => {})
        if (answer === 'continue') return { ok: true, detail: '已确认继续' }
        return { ok: false, detail: answer === 'stop' ? '你选择了停止' : '流水线已取消', stopPipeline: answer === 'stop' }
      }
    }
  }

  #addRun(active: Active, nodeId: string, run: RunInfo): void {
    const state = active.run.nodes[nodeId]!
    if (!state.runIds.includes(run.id)) this.#set(active, nodeId, { runIds: [...state.runIds, run.id] })
    if (run.resources.some(r => r.startsWith('adb:'))) active.usedEmulator = true
  }

  #cancel(active: Active, reason: string, kind: 'user' | 'failure' = 'user'): void {
    if (active.cancelReason !== undefined || active.run.state !== 'running') return
    active.cancelReason = reason
    active.cancelKind = kind
    active.controller.abort(new Error(reason))
    for (const node of active.pipeline.nodes) {
      const state = active.run.nodes[node.id]!
      if (state.state !== 'running') continue
      for (const runId of state.runIds) void this.#deps.runner.stop(runId, `流水线「${active.pipeline.name}」${reason}`).catch(() => {})
    }
    this.#pump(active)
  }

  async #finish(active: Active): Promise<void> {
    const { run, pipeline } = active
    if (run.state !== 'running') return
    const states = pipeline.nodes.filter(n => !isMarker(n)).map(n => run.nodes[n.id]!.state)
    const count = (s: NodeRun['state']) => states.filter(x => x === s).length
    run.state = active.cancelKind === 'user' ? 'cancelled' : count('failed') > 0 ? 'failed' : 'succeeded'
    run.outcome = [
      `${count('succeeded')} 个成功`,
      ...(count('failed') > 0 ? [`${count('failed')} 个失败`] : []),
      ...(count('skipped') > 0 ? [`${count('skipped')} 个跳过`] : []),
      ...(count('cancelled') > 0 ? [`${count('cancelled')} 个取消`] : []),
    ].join('，') + (active.cancelReason === undefined ? '' : `（${active.cancelReason}）`)
    run.endedAt = this.#now()
    this.#active.delete(run.id)
    this.#deps.log.info(`pipeline run ${run.id} ${run.state}: ${run.outcome}`)
    if (pipeline.stopEmulatorAfter && active.usedEmulator) {
      await this.#deps.emulators()?.stop().catch(error => this.#deps.log.warn(`stopping the emulator failed: ${message(error)}`))
    }
    this.#emit(active)
    if (UNATTENDED.has(run.trigger.kind)) {
      const failed = pipeline.nodes.filter(n => run.nodes[n.id]!.state === 'failed').map(n => `✗ ${nodeLabel(n, this.#deps.library)}：${run.nodes[n.id]!.detail ?? ''}`)
      void this.#deps.notices()?.send({
        id: `pipeline:${run.id}:summary`, scope: 'pipeline', severity: run.state === 'succeeded' ? 'success' : 'warning',
        title: `${pipeline.name}：${run.state === 'succeeded' ? '已完成' : run.state === 'failed' ? '有失败' : '已取消'}`,
        text: [`${TRIGGER[run.trigger.kind]}运行，${run.outcome}`, `用时 ${Math.max(1, Math.round((run.endedAt - run.startedAt) / 60_000))} 分钟`, ...failed].join('\n'),
      }).catch(() => {})
    }
    const snapshot = structuredClone(run)
    active.resolve(snapshot)
    for (const listener of this.#ended) {
      try { listener(snapshot) } catch { /* the listener's problem */ }
    }
  }

  #set(active: Active, nodeId: string, patch: Partial<NodeRun>): void {
    const current = active.run.nodes[nodeId]!
    const next: NodeRun = { ...current, ...patch }
    if (patch.detail === '') delete next.detail
    if (JSON.stringify(next) === JSON.stringify(current)) return
    active.run.nodes[nodeId] = next
    this.#emit(active)
  }

  #emit(active: Active): void {
    this.#deps.onRun(structuredClone(active.run))
  }
}

const TRIGGER: Readonly<Record<PipelineTrigger['kind'], string>> = { manual: '手动', schedule: '定时', autostart: '开机后', agent: 'agent ', after: '接续' }
const STATE_WORD: Readonly<Record<NodeRun['state'], string>> = {
  pending: '还没运行', waiting: '在等待', running: '在运行', succeeded: '成功了', failed: '失败了', skipped: '被跳过', cancelled: '被取消',
}

function final(state: NodeRun['state']): boolean {
  return state === 'succeeded' || state === 'failed' || state === 'skipped' || state === 'cancelled'
}

function satisfied(when: 'success' | 'failure' | 'always', state: NodeRun['state']): boolean {
  if (when === 'success') return state === 'succeeded'
  if (when === 'failure') return state === 'failed'
  return state === 'succeeded' || state === 'failed'
}

/** Milliseconds until the next local HH:MM (tomorrow when it has passed today). */
export function untilMs(clock: string, now: number): number {
  const [h, m] = clock.split(':').map(Number) as [number, number]
  const at = new Date(now)
  at.setHours(h, m, 0, 0)
  if (at.getTime() <= now) at.setDate(at.getDate() + 1)
  return at.getTime() - now
}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
