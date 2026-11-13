/**
 * The pipeline library and its runs, without Cordis: what the capability,
 * the agent tools and the scheduler all use.
 */
import { isMarker, Pipeline, type PipelineCheck, type PipelineRun, type PipelineSummary, type PipelineTrigger } from '@adg/protocol'
import { checkPipeline, type CheckLibrary } from './check.ts'
import type { Engine } from './engine.ts'
import type { PipelineStore } from './store.ts'

export class Pipelines {
  readonly #store: PipelineStore
  readonly #library: CheckLibrary
  readonly #engine: Engine
  readonly #changed: () => void
  readonly #now: () => number
  readonly #pipelines = new Map<string, Pipeline>()
  #runs: PipelineRun[] = []

  constructor(options: { store: PipelineStore; library: CheckLibrary; engine: Engine; changed: () => void; now?: () => number }) {
    this.#store = options.store
    this.#library = options.library
    this.#engine = options.engine
    this.#changed = options.changed
    this.#now = options.now ?? Date.now
  }

  async load(log: { warn(message: string): void }): Promise<void> {
    const { pipelines, runs } = await this.#store.load(log)
    for (const p of pipelines) this.#pipelines.set(p.id, p)
    this.#runs = runs
  }

  /** Keep the run list current (the engine reports every change). */
  recordRun(run: PipelineRun): void {
    const index = this.#runs.findIndex(r => r.id === run.id)
    if (index === -1) this.#runs.push(run)
    else this.#runs[index] = run
    if (run.state !== 'running' || index === -1) void this.#store.saveRuns(this.#runs)
  }

  list(): PipelineSummary[] {
    return [...this.#pipelines.values()].sort((a, b) => a.name.localeCompare(b.name, 'zh-CN')).map(p => {
      const last = this.runs(p.id, 1)[0]
      return {
        id: p.id, name: p.name, nodes: p.nodes.filter(n => !isMarker(n)).length, draft: p.draft === true, schedule: p.schedule,
        ...(p.description === undefined ? {} : { description: p.description }),
        ...(p.updatedAt === undefined ? {} : { updatedAt: p.updatedAt }),
        ...(last === undefined ? {} : { lastRun: { id: last.id, state: last.state, startedAt: last.startedAt, ...(last.endedAt === undefined ? {} : { endedAt: last.endedAt }) } }),
      }
    })
  }

  all(): Pipeline[] {
    return [...this.#pipelines.values()]
  }

  get(id: string): Pipeline {
    const pipeline = this.#pipelines.get(id)
    if (pipeline === undefined) throw new Error(`没有流水线 ${id}`)
    return pipeline
  }

  has(id: string): boolean {
    return this.#pipelines.has(id)
  }

  check(pipeline: Pipeline): PipelineCheck {
    return checkPipeline(pipeline, this.#library)
  }

  /**
   * Save. The user's save, and 编排's (`orchestrator`: the agent whose work
   * pipelines are, and its sub-agents), is the pipeline as it now is: `draft`
   * is cleared. Another agent's (`agent`) is a draft for the user to look at.
   * @throws Error when a draft would overwrite a saved pipeline.
   */
  async save(input: Pipeline, by: 'user' | 'orchestrator' | 'agent'): Promise<{ pipeline: Pipeline; check: PipelineCheck }> {
    const existing = this.#pipelines.get(input.id)
    if (by === 'agent' && existing !== undefined && existing.draft !== true) {
      throw new Error(`已经有一条保存过的流水线叫 ${input.id}，草稿不能覆盖它：要改它，用 agent_delegate 交给「编排」（它可以直接修改保存）；要另起一条，换一个 id`)
    }
    const now = this.#now()
    const pipeline = Pipeline.parse({ ...input, createdAt: existing?.createdAt ?? now, updatedAt: now })
    if (by === 'agent') pipeline.draft = true
    else delete pipeline.draft
    this.#pipelines.set(pipeline.id, pipeline)
    await this.#store.save(pipeline)
    this.#changed()
    return { pipeline, check: this.check(pipeline) }
  }

  async remove(id: string): Promise<void> {
    if (this.#engine.isRunning(id)) throw new Error('这条流水线正在运行，先取消')
    this.#pipelines.delete(id)
    await this.#store.remove(id)
    this.#changed()
  }

  run(id: string, trigger: PipelineTrigger, from?: string): PipelineRun {
    return this.#engine.start(this.get(id), trigger, { from })
  }

  runs(pipelineId?: string, limit = 30): PipelineRun[] {
    const live = new Map(this.#engine.active().map(r => [r.id, r]))
    return this.#runs
      .map(r => live.get(r.id) ?? r)
      .filter(r => pipelineId === undefined || r.pipelineId === pipelineId)
      .sort((a, b) => b.startedAt - a.startedAt)
      .slice(0, limit)
  }

  /** When the pipeline's last successful run started. */
  lastSuccessAt(pipelineId: string): number | undefined {
    return this.#runs.filter(r => r.pipelineId === pipelineId && r.state === 'succeeded').sort((a, b) => b.startedAt - a.startedAt)[0]?.startedAt
  }
}

export function localDay(at: number): string {
  const d = new Date(at)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}
