/**
 * In-process job board for installs, updates and environment fixes: one job
 * per script at a time, progress published as it changes, cancellation by id.
 * Finished jobs are kept briefly so a UI that reconnects can still show them.
 */
import type { ScriptJob, ScriptJobPhase } from '@adg/protocol'

const KEEP_FINISHED = 20

export class JobBoard {
  readonly #jobs = new Map<string, { job: ScriptJob; controller: AbortController }>()
  readonly #publish: (job: ScriptJob) => void
  readonly #now: () => number

  constructor(publish: (job: ScriptJob) => void, now: () => number = Date.now) {
    this.#publish = publish
    this.#now = now
  }

  /** The unfinished job on a script, if any. */
  active(scriptId: string): ScriptJob | undefined {
    for (const { job } of this.#jobs.values()) if (job.scriptId === scriptId && job.endedAt === undefined) return job
    return undefined
  }

  list(): ScriptJob[] {
    return [...this.#jobs.values()].map(e => e.job).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(id: string): ScriptJob | undefined {
    return this.#jobs.get(id)?.job
  }

  /**
   * Start `work` as a job; it reports through `update` and resolves with the version it produced.
   * @throws Error when the script already has an unfinished job.
   */
  start(kind: ScriptJob['kind'], scriptId: string, work: (ctl: JobControl) => Promise<string | undefined>): { job: ScriptJob; done: Promise<ScriptJob> } {
    const busy = this.active(scriptId)
    if (busy !== undefined) throw new Error(`${scriptId} 正在进行另一个任务（${busy.kind}），请等它结束`)
    const controller = new AbortController()
    const job: ScriptJob = { id: `job-${crypto.randomUUID()}`, kind, scriptId, phase: 'queued', startedAt: this.#now() }
    this.#jobs.set(job.id, { job, controller })
    this.#publish(job)
    const update = (patch: Partial<Omit<ScriptJob, 'id' | 'kind' | 'scriptId' | 'startedAt'>>) => {
      const entry = this.#jobs.get(job.id)
      if (entry === undefined || entry.job.endedAt !== undefined) return
      entry.job = { ...entry.job, ...patch }
      this.#publish(entry.job)
    }
    const done = (async () => {
      try {
        const version = await work({ signal: controller.signal, phase: (phase, extra = {}) => update({ phase, ...extra }) })
        update({ phase: 'done', endedAt: this.#now(), ...(version === undefined ? {} : { version }) })
      } catch (error) {
        const cancelled = controller.signal.aborted
        update({
          phase: cancelled ? 'cancelled' : 'failed',
          endedAt: this.#now(),
          error: cancelled ? '已取消' : error instanceof Error ? error.message : String(error),
        })
      }
      this.#prune()
      return this.#jobs.get(job.id)!.job
    })()
    return { job, done }
  }

  cancel(id: string): boolean {
    const entry = this.#jobs.get(id)
    if (entry === undefined || entry.job.endedAt !== undefined) return false
    entry.controller.abort(new Error('cancelled by user'))
    return true
  }

  /** Abort everything (plugin unload). */
  dispose(): void {
    for (const { controller } of this.#jobs.values()) controller.abort(new Error('script registry stopped'))
  }

  #prune(): void {
    const finished = [...this.#jobs.values()].filter(e => e.job.endedAt !== undefined).sort((a, b) => b.job.startedAt - a.job.startedAt)
    for (const entry of finished.slice(KEEP_FINISHED)) this.#jobs.delete(entry.job.id)
  }
}

export interface JobControl {
  readonly signal: AbortSignal
  phase(phase: ScriptJobPhase, extra?: { message?: string; received?: number; total?: number }): void
}
