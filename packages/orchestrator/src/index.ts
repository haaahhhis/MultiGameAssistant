/**
 * @adg/orchestrator — pipelines: DAGs of script tasks, agent steps, waits,
 * messages and confirmations, run with resource-aware queueing and failure
 * policies (`ctx.adgOrchestrator`). Contributes the `pipeline_*` /
 * `schedule_set` agent tools and the `pipelines@1` capability; the scheduler
 * starts pipelines through this service.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-skill'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@adg/gateway'
import type {} from '@adg/runner'
import type {} from '@adg/script-registry'
import { finalText, MAIN, sessionConversations } from '@adg/notify'
import { PIPELINES_CAPABILITY, taskMessage, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { Engine, PIPELINE_ROLE } from './engine.ts'
import { Pipelines } from './pipelines.ts'
import { PipelineStore } from './store.ts'
import { AgentTasks, TASK_BY } from './tasks.ts'
import { pipelineTools, taskTools } from './tools.ts'

export { checkPipeline, graph, nodeLabel, topoOrder, type CheckLibrary } from './check.ts'
export { Engine, untilMs, waitsFor, type EngineDeps, type EngineNotice } from './engine.ts'
export { Pipelines, localDay } from './pipelines.ts'
export { PipelineStore } from './store.ts'
export { AgentTasks, TASK_BY, TASK_TIMEOUT_MS, type AgentTasksDeps, type TaskInput } from './tasks.ts'
export { draftToPipeline, pipelineTools, taskTools } from './tools.ts'

const GUIDE = new URL('../skills/pipeline-planning.md', import.meta.url)

/** `name` and `description` from a one-line-per-key frontmatter, and the body. */
export function parseGuide(text: string): { name: string; description: string; content: string } | undefined {
  const match = /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  const meta = Object.fromEntries(match[1]!.split(/\r?\n/).map(line => /^(\w+):\s*(.*)$/.exec(line)).filter(m => m !== null).map(m => [m[1]!, m[2]!.trim()]))
  if (!meta['name'] || !meta['description']) return undefined
  return { name: meta['name'], description: meta['description'], content: match[2]!.trim() }
}

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
  readonly tasks: AgentTasks
  readonly ready: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgOrchestrator')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-orchestrator')
    const scripts = ctx.adgScripts
    const library = { get: (id: string) => scripts.library.get(id), packOf: (id: string) => scripts.library.packOf(id) }
    let pipelines!: Pipelines
    const conversations = () => {
      const sessions = ctx.get('sessionController')
      return sessions === undefined ? undefined : sessionConversations(sessions, () => ctx.get('adgGateway')?.workspaceDir(), undefined, () => ctx.get('adgGateway'))
    }
    const engine = new Engine({
      runner: ctx.adgRunner.runner,
      library,
      notices: () => ctx.get('adgNotify'),
      conversations,
      skills: async () => {
        const registry = ctx.get('skills')
        if (registry === undefined) return []
        const workspace = ctx.get('adgGateway')?.workspaceDir()
        const list = await registry.list({ ...(workspace === undefined ? {} : { cwd: workspace }), signal: AbortSignal.timeout(10_000) })
        return list.filter(s => s.invocation.userInvocable).map(s => ({ name: s.name, description: s.description }))
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
    // A timed task goes to its agent's conversation; a role agent's reply then goes back to 助手, who says what matters.
    const tasks = new AgentTasks({
      file: join(spec.dataDir, 'pipelines', '_tasks.json'),
      hand: async (task, signal) => {
        const talk = conversations()
        if (talk === undefined) throw new Error('对话功能还没准备好')
        if (task.agent === MAIN) return talk.ask(await talk.home(MAIN), taskMessage(TASK_BY, task.title, task.prompt), signal)
        const agent = ctx.get('adgGateway')?.roles.list().find(r => r.id === task.agent)
        if (agent === undefined) throw new Error(`没有「${task.agent}」这个 agent 了`)
        return finalText(await talk.handOff({ to: { id: agent.id, name: agent.name }, by: TASK_BY, title: task.title, task: task.prompt, relay: true, signal }))
      },
      changed: () => ctx.get('adgGateway')?.broadcast('tasks/changed', {}),
      log: { warn: m => log.warn(m) },
    })
    this.engine = engine
    this.pipelines = pipelines
    this.tasks = tasks
    this.ready = scripts.ready.then(() => Promise.all([pipelines.load({ warn: m => log.warn(m) }), tasks.load()])).then(() => {})
    ctx.effect(() => () => engine.dispose(), 'adg-orchestrator engine')

    // Gate cards answered in a chat channel.
    ctx.inject(['adgNotify'], scoped => {
      scoped.effect(() => scoped.adgNotify.onAction('pipeline', async (noticeId, actionId) => {
        const [, runId, nodeId] = noticeId.split(':')
        if (runId === undefined || nodeId === undefined || (actionId !== 'continue' && actionId !== 'stop')) throw new Error('不认识这个按钮')
        try {
          engine.gate(runId, nodeId, actionId)
        } catch (error) {
          // Answered already, or its run is gone (the app restarted): the question is over wherever it shows.
          await scoped.adgNotify.update(noticeId, { done: '这次运行已经不在等确认了' })
          throw error
        }
        return actionId === 'continue' ? '已继续' : '已停止'
      }), 'adg-orchestrator gate actions')
    })

    // The planning guide (hardware first, serial by default, failures do not block the rest).
    ctx.inject(['skills', 'adgGateway'], scoped => {
      let dispose: (() => void) | undefined
      void readFile(GUIDE, 'utf8').then(text => {
        const skill = parseGuide(text)
        if (skill === undefined) { log.warn('skills/pipeline-planning.md has no usable frontmatter'); return }
        dispose = scoped.adgGateway.generalSkill({ ...skill, source: 'bundled' }, () => scoped.skills.register({ ...skill, source: 'bundled' }))
      }, error => log.warn(`pipeline-planning skill not loaded: ${String(error)}`))
      scoped.effect(() => () => dispose?.(), 'adg-orchestrator skill')
    })

    ctx.inject(['adgGateway'], gateway => gateway.adgGateway.agentPart('adg-orchestrator tools', agent => {
      const registered: Array<() => void> = []
      // Saving outright is 编排's and its sub-agents': the others draft, or hand the change to it.
      const mayNot = (name: string, session: string | undefined) => (name !== 'pipeline_save' || (session !== undefined && ctx.get('adgGateway')?.leadOf(session) === PIPELINE_ROLE.id)
        ? undefined
        : `只有「${PIPELINE_ROLE.name}」和它的子 agent 能直接保存流水线：用 agent_delegate 把要改的交给「${PIPELINE_ROLE.name}」，或者用 pipeline_draft 起草一条给用户确认`)
      for (const tool of [...pipelineTools(pipelines, engine, library), ...taskTools(tasks, () => ctx.get('adgGateway')?.roles.list() ?? [])]) {
        registered.push(agent.tools.register({
          ...tool,
          execute: async (args, exec) => {
            await this.ready
            const refusal = mayNot(tool.name, exec.agent?.session.id)
            if (refusal !== undefined) throw new Error(refusal)
            await ctx.get('adgGateway')?.guardTool(exec)
            return tool.execute(args, exec)
          },
        }))
      }
      return () => { for (const dispose of registered) dispose() }
    }))

    ctx.inject(['adgGateway'], scoped => {
      scoped.effect(() => scoped.adgGateway.role(PIPELINE_ROLE), 'adg-orchestrator role')
      scoped.adgGateway.register({
        id: PIPELINES_CAPABILITY,
        version: 1,
        methods: {
          'pipelines/list': async () => { await this.ready; return { items: pipelines.list() } },
          'pipelines/get': async params => { await this.ready; return pipelines.get((params as RequestParams<'pipelines/get'>).id) },
          'pipelines/save': async params => { await this.ready; return pipelines.save((params as RequestParams<'pipelines/save'>).pipeline, 'user') },
          'pipelines/remove': async params => { await this.ready; await pipelines.remove((params as RequestParams<'pipelines/remove'>).id); return {} },
          'pipelines/check': async params => { await this.ready; return pipelines.check((params as RequestParams<'pipelines/check'>).pipeline) },
          'pipelines/run': async params => { await this.ready; const p = params as RequestParams<'pipelines/run'>; return pipelines.run(p.id, { kind: 'manual' }, p.from) },
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
          'tasks/list': async params => { await this.ready; return { items: tasks.list((params as RequestParams<'tasks/list'>).agent) } },
          'tasks/save': async params => { await this.ready; return tasks.save((params as RequestParams<'tasks/save'>).task) },
          'tasks/remove': async params => { await this.ready; await tasks.remove((params as RequestParams<'tasks/remove'>).id); return {} },
          'tasks/run': async params => { await this.ready; return tasks.run((params as RequestParams<'tasks/run'>).id, { kind: 'manual' }) },
          'tasks/runs': async params => { await this.ready; return { items: tasks.runs((params as RequestParams<'tasks/runs'>).id) } },
        },
      })
    })
  }
}

export default AdgOrchestrator
