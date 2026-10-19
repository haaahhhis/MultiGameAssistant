/**
 * @adg/orchestrator — pipelines: DAGs of script tasks, agent steps, waits,
 * messages and confirmations, run with resource-aware queueing and failure
 * policies (`ctx.adgOrchestrator`). Contributes the `pipeline_*` /
 * `schedule_set` agent tools and the `pipelines@1` capability; the scheduler
 * starts pipelines through this service.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@adg/gateway'
import type {} from '@adg/runner'
import type {} from '@adg/script-registry'
import { sessionConversations } from '@adg/notify'
import { PIPELINES_CAPABILITY, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { Engine } from './engine.ts'
import { Pipelines } from './pipelines.ts'
import { PipelineStore } from './store.ts'
import { pipelineTools } from './tools.ts'

export { checkPipeline, graph, nodeLabel, topoOrder, type CheckLibrary } from './check.ts'
export { Engine, untilMs, type EngineDeps, type EngineNotice } from './engine.ts'
export { Pipelines, localDay } from './pipelines.ts'
export { PipelineStore } from './store.ts'
export { draftToPipeline, pipelineTools } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgOrchestrator: AdgOrchestrator
  }
}

const ConfigSchema = z.object({
  /** Pipelines and their recent runs: `<dataDir>/pipelines/`. */
  dataDir: z.string().min(1),
})
export type Config = z.input<typeof ConfigSchema>

export class AdgOrchestrator extends Service {
  static inject = ['adgRunner', 'adgScripts']
  readonly engine: Engine
  readonly pipelines: Pipelines
  readonly ready: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgOrchestrator')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-orchestrator')
    const scripts = ctx.adgScripts
    const library = { get: (id: string) => scripts.library.get(id), packOf: (id: string) => scripts.library.packOf(id) }
    let pipelines!: Pipelines
    const engine = new Engine({
      runner: ctx.adgRunner.runner,
      library,
      notices: () => ctx.get('adgNotify'),
      conversations: () => {
        const sessions = ctx.get('sessionController')
        return sessions === undefined ? undefined : sessionConversations(sessions)
      },
      emulators: () => {
        const emulators = ctx.get('adgEmulators') as { stop?: (index?: number) => Promise<void> } | undefined
        return emulators?.stop === undefined ? undefined : { stop: () => emulators.stop!() }
      },
      onRun: run => {
        pipelines.recordRun(run)
        ctx.get('adgGateway')?.broadcast('pipelines/run', run)
      },
      log: { info: m => log.info(m), warn: m => log.warn(m) },
    })
    pipelines = new Pipelines({ store: new PipelineStore(spec.dataDir), library, engine, changed: () => ctx.get('adgGateway')?.broadcast('pipelines/changed', {}) })
    this.engine = engine
    this.pipelines = pipelines
    this.ready = scripts.ready.then(() => pipelines.load({ warn: m => log.warn(m) }))
    ctx.effect(() => () => engine.dispose(), 'adg-orchestrator engine')

    // Gate cards answered in a chat channel.
    ctx.inject(['adgNotify'], scoped => {
      scoped.effect(() => scoped.adgNotify.onAction('pipeline', async (noticeId, actionId) => {
        const [, runId, nodeId] = noticeId.split(':')
        if (runId === undefined || nodeId === undefined || (actionId !== 'continue' && actionId !== 'stop')) throw new Error('不认识这个按钮')
        engine.gate(runId, nodeId, actionId)
        return actionId === 'continue' ? '已继续' : '已停止'
      }), 'adg-orchestrator gate actions')
    })

    ctx.inject(['tools'], scoped => {
      for (const tool of pipelineTools(pipelines, engine, library)) {
        scoped.tools.register({ ...tool, execute: async (args, exec) => { await this.ready; return tool.execute(args, exec) } })
      }
    })

    ctx.inject(['adgGateway'], scoped => {
      scoped.adgGateway.register({
        id: PIPELINES_CAPABILITY,
        version: 1,
        methods: {
          'pipelines/list': async () => { await this.ready; return { items: pipelines.list() } },
          'pipelines/get': async params => { await this.ready; return pipelines.get((params as RequestParams<'pipelines/get'>).id) },
          'pipelines/save': async params => { await this.ready; return pipelines.save((params as RequestParams<'pipelines/save'>).pipeline, 'user') },
          'pipelines/remove': async params => { await this.ready; await pipelines.remove((params as RequestParams<'pipelines/remove'>).id); return {} },
          'pipelines/check': async params => { await this.ready; return pipelines.check((params as RequestParams<'pipelines/check'>).pipeline) },
          'pipelines/run': async params => { await this.ready; return pipelines.run((params as RequestParams<'pipelines/run'>).id, { kind: 'manual' }) },
          'pipelines/cancel': params => { engine.cancel((params as RequestParams<'pipelines/cancel'>).runId); return {} },
          'pipelines/runs': async params => {
            await this.ready
            const p = params as RequestParams<'pipelines/runs'>
            return { items: pipelines.runs(p.pipelineId, p.limit ?? 30) }
          },
          'pipelines/gate': params => {
            const p = params as RequestParams<'pipelines/gate'>
            engine.gate(p.runId, p.nodeId, p.decision)
            return {}
          },
        },
      })
    })
  }
}

export default AdgOrchestrator
