import { finalText, type Reply } from '@adg/notify'
import type { GameReading } from '@adg/protocol'

interface ReadingWork {
  owner: string
  id: string
  run(instruction: string, signal: AbortSignal): Promise<string>
}

interface ReadingRequest {
  key: string
  screen: boolean
  scope?: string
  remainingUrls?: string[]
  open(): Promise<ReadingWork>
  run(work: ReadingWork, signal: AbortSignal, checkpoint: (urls: string[], summary: string) => Promise<void>): Promise<Reply>
}

interface ActiveReading {
  controller: AbortController
  finished: Promise<void>
}

/** Each probe has a child ID and its role’s stable home. Only probes operating the game screen wait for one another. */
export class ReadingTasks {
  private readonly keys = new Set<string>()
  private readonly active = new Map<string, ActiveReading>()
  private screen: Promise<void> = Promise.resolve()
  private stopped = false
  private readonly save: (key: string, reading: GameReading) => Promise<void>
  private readonly now: () => number
  private readonly warn: (message: string) => void

  constructor(save: ReadingTasks['save'], now: () => number, warn: (message: string) => void) {
    this.save = save
    this.now = now
    this.warn = warn
  }

  async start(request: ReadingRequest): Promise<string> {
    if (this.stopped) throw new Error('探查服务已停止')
    if (this.keys.has(request.key)) throw new Error('这个游戏已有同类探查，请查看当前任务')
    this.keys.add(request.key)
    const prior = request.screen ? this.screen : Promise.resolve()
    const slot = Promise.withResolvers<void>()
    if (request.screen) this.screen = Promise.all([prior, slot.promise]).then(() => {})
    try {
      const work = await request.open()
      if (this.stopped) throw new Error('探查服务已停止')
      const controller = new AbortController()
      let pending = request.remainingUrls ?? []
      let progress: string | undefined
      const write = (state: GameReading['state'], summary?: string) =>
        this.save(request.key, { sessionId: work.owner, taskId: work.id, state, ...(request.scope === undefined ? {} : { scope: request.scope }), ...(pending.length ? { remainingUrls: [...pending] } : {}), at: this.now(), ...(summary ? { summary: summary.slice(0, 400) } : {}) })
      await write('queued')
      const execute = async () => {
        // Web discovery and residual-link reconciliation each own a model deadline.
        const signal = request.scope === undefined ? AbortSignal.any([controller.signal, AbortSignal.timeout(20 * 60_000)]) : controller.signal
        try {
          signal.throwIfAborted()
          await write('running')
          signal.throwIfAborted()
          const reply = await request.run(work, signal, async (urls, summary) => {
            pending = urls
            progress = summary
            await write('running', summary)
          })
          signal.throwIfAborted()
          const summary = finalText(reply).trim()
          if (reply.outcome === 'cancelled') await write('cancelled', reply.ended)
          else if (reply.outcome !== 'completed' || !summary) await write(progress || pending.length ? 'partial' : 'failed', reply.ended ?? '探查结束时没有返回结论')
          else { pending = []; await write('done', summary) }
        } catch (error) {
          const reason = signal.aborted ? signal.reason : error
          const cancelled = controller.signal.aborted || (reason instanceof Error && reason.name === 'AbortError')
          const detail = reason instanceof Error ? reason.message : String(reason)
          await write(cancelled ? 'cancelled' : progress || pending.length ? 'partial' : 'failed', [progress, detail].filter(Boolean).join('\n'))
        }
      }
      // A cancelled waiter can finish immediately; the screen stays reserved until the preceding owner exits.
      const whenCancelled = Promise.withResolvers<void>()
      controller.signal.addEventListener('abort', () => whenCancelled.resolve(), { once: true })
      const finished = Promise.race([prior, whenCancelled.promise]).then(execute).catch(error => this.warn(String(error))).finally(() => {
        this.keys.delete(request.key)
        this.active.delete(work.id)
        slot.resolve()
      })
      this.active.set(work.id, { controller, finished })
      if (this.stopped) controller.abort(new Error('探查服务已停止'))
      return work.owner
    } catch (error) {
      slot.resolve()
      this.keys.delete(request.key)
      throw error
    }
  }

  async cancel(taskId: string): Promise<boolean> {
    const task = this.active.get(taskId)
    if (!task) return false
    task.controller.abort(new Error('已取消这项探查'))
    await task.finished
    return true
  }

  async stop(): Promise<void> {
    this.stopped = true
    const tasks = [...this.active.values()]
    for (const task of tasks) task.controller.abort(new Error('探查服务已停止'))
    await Promise.all(tasks.map(task => task.finished))
  }
}
