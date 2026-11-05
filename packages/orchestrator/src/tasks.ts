/**
 * Timed tasks (docs/design/agent-roles.md §11): one piece of work in plain
 * words for one agent, at its times — what used to need a pipeline with a
 * single agent step. The scheduler fires them like pipelines (`task:<id>`);
 * running one hands the work to its agent's conversation.
 *
 *   <dataDir>/pipelines/_tasks.json     the tasks and their last 200 runs
 */
import { randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { AgentTask, AgentTaskRun, type PipelineTrigger } from '@adg/protocol'
import { writeFileAtomic } from '@adg/protocol/node'
import { z } from 'zod'

const KEEP_RUNS = 200
/** How long an agent gets for one task. */
export const TASK_TIMEOUT_MS = 30 * 60_000
/** Who hands the work over, as the agent's conversation shows it. */
export const TASK_BY = '定时任务'

const Saved = z.object({ tasks: z.array(AgentTask).default([]), runs: z.array(AgentTaskRun).default([]) })

export interface AgentTasksDeps {
  readonly file: string
  /** Hand the task to its agent; resolves with the agent's reply. */
  readonly hand: (task: AgentTask, signal: AbortSignal) => Promise<string>
  readonly changed: () => void
  readonly now?: () => number
  readonly log: { warn(message: string): void }
}

export type TaskInput = Omit<AgentTask, 'id'> & { id?: string | undefined }

export class AgentTasks {
  readonly #deps: AgentTasksDeps
  readonly #now: () => number
  #tasks = new Map<string, AgentTask>()
  #runs: AgentTaskRun[] = []
  #writing: Promise<void> = Promise.resolve()

  constructor(deps: AgentTasksDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  async load(): Promise<void> {
    let text: string
    try { text = await readFile(this.#deps.file, 'utf8') } catch { return }
    try {
      const saved = Saved.parse(JSON.parse(text))
      this.#tasks = new Map(saved.tasks.map(t => [t.id, t]))
      this.#runs = saved.runs.map(r => (r.state === 'running' ? { ...r, state: 'failed', outcome: '软件关闭时还没做完', endedAt: r.endedAt ?? r.startedAt } : r))
    } catch (error) {
      this.#deps.log.warn(`timed tasks unreadable: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  all(): AgentTask[] {
    return [...this.#tasks.values()].sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }

  list(agent?: string): (AgentTask & { lastRun?: AgentTaskRun })[] {
    return this.all().filter(t => agent === undefined || t.agent === agent).map(t => {
      const lastRun = this.#lastRun(t.id)
      return lastRun === undefined ? t : { ...t, lastRun }
    })
  }

  get(id: string): AgentTask | undefined {
    return this.#tasks.get(id)
  }

  async save(input: TaskInput): Promise<AgentTask> {
    const before = input.id === undefined ? undefined : this.#tasks.get(input.id)
    const now = this.#now()
    const task = AgentTask.parse({ ...input, id: input.id ?? `task-${randomUUID().replace(/-/g, '').slice(0, 10)}`, createdAt: before?.createdAt ?? now, updatedAt: now })
    this.#tasks.set(task.id, task)
    await this.#save()
    return task
  }

  async remove(id: string): Promise<void> {
    if (!this.#tasks.delete(id)) return
    this.#runs = this.#runs.filter(r => r.taskId !== id)
    await this.#save()
  }

  runs(id: string, limit = 20): AgentTaskRun[] {
    return this.#runs.filter(r => r.taskId === id).slice(-limit).reverse()
  }

  isRunning(id: string): boolean {
    return this.#lastRun(id)?.state === 'running'
  }

  lastSuccessAt(id: string): number | undefined {
    return this.#runs.findLast(r => r.taskId === id && r.state === 'done')?.startedAt
  }

  /**
   * Hand the task to its agent now; the run ends when the agent has answered.
   * @throws Error when there is no such task or its last run has not ended.
   */
  run(id: string, trigger: PipelineTrigger): AgentTaskRun {
    const task = this.#tasks.get(id)
    if (task === undefined) throw new Error(`没有这个定时任务：${id}`)
    if (this.isRunning(id)) throw new Error(`「${task.title}」上一次还没做完`)
    const run: AgentTaskRun = { id: randomUUID(), taskId: id, trigger, state: 'running', startedAt: this.#now() }
    this.#runs.push(run)
    void this.#save()
    this.#deps.hand(task, AbortSignal.timeout(TASK_TIMEOUT_MS)).then(
      reply => this.#end(run, 'done', reply.trim() === '' ? '它没有留下回复' : reply),
      error => this.#end(run, 'failed', error instanceof Error ? error.message : String(error)),
    )
    return run
  }

  /** Settles once every change so far is written (tests, before removing the folder). */
  idle(): Promise<void> {
    return this.#writing
  }

  #end(run: AgentTaskRun, state: 'done' | 'failed', outcome: string): void {
    const ended: AgentTaskRun = { ...run, state, outcome: outcome.trim().slice(0, 300), endedAt: this.#now() }
    this.#runs = this.#runs.map(r => (r.id === run.id ? ended : r))
    void this.#save()
  }

  #lastRun(id: string): AgentTaskRun | undefined {
    return this.#runs.findLast(r => r.taskId === id)
  }

  #save(): Promise<void> {
    this.#runs = this.#runs.slice(-KEEP_RUNS)
    const text = `${JSON.stringify({ tasks: this.all(), runs: this.#runs }, null, 2)}\n`
    this.#writing = this.#writing.then(() => writeFileAtomic(this.#deps.file, text)).catch(error => this.#deps.log.warn(`timed tasks not saved: ${String(error)}`))
    this.#deps.changed()
    return this.#writing
  }
}
