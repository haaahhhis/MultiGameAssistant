/**
 * @adg/monitor — incidents while scripts run, L0 recovery from the Script
 * Pack, and the push to chat channels (`ctx.adgMonitor`).
 *
 * Needs the runner and the script library; uses the emulator plugin for ADB
 * reconnects and screenshots, and `@adg/notify` for chat channels, when they
 * are loaded. Contributes the `monitor_incidents` agent tool, the stall-time
 * tools (`monitor_stall_check` reads a script's normal log rhythm,
 * `monitor_stall_set` sets how long it may be quiet) and the `monitor@1` capability.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@adg/gateway'
import type {} from '@adg/intervene'
import type {} from '@adg/notify'
import type {} from '@adg/runner'
import type {} from '@adg/script-registry'
import { MONITOR_CAPABILITY, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { Monitor } from './monitor.ts'
import { desktopScreenshot } from './screenshot.ts'
import { FileIncidentStore } from './store.ts'

export { Monitor, DEFAULT_SETTINGS, DEFAULT_STALL_SECONDS, type IncidentStore, type InterventionPort, type SettingsPatch, type MonitorDeps, type MonitorNotice, type NoticeSink } from './monitor.ts'
export { FileIncidentStore } from './store.ts'
export { desktopScreenshot } from './screenshot.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgMonitor: AdgMonitor
  }
}

const ConfigSchema = z.object({
  /** Incidents, settings and screenshots: `<dataDir>/monitor/`. */
  dataDir: z.string().min(1),
  /** Stall and overtime check interval: often enough for a 30-second stall time. @default 5000 */
  tickMs: z.number().int().min(0).default(5_000),
})
export type Config = z.input<typeof ConfigSchema>

export class AdgMonitor extends Service {
  static inject = ['adgRunner', 'adgScripts']
  readonly monitor: Monitor
  readonly ready: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgMonitor')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-monitor')
    const scripts = ctx.adgScripts
    const monitor = new Monitor({
      runner: ctx.adgRunner.runner,
      packOf: id => scripts.library.packOf(id),
      emulators: () => ctx.get('adgEmulators'),
      notices: () => ctx.get('adgNotify'),
      intervene: () => ctx.get('adgIntervene'),
      desktopScreenshot,
      store: new FileIncidentStore(spec.dataDir),
      onIncident: incident => ctx.get('adgGateway')?.broadcast('monitor/incident', incident),
      log: { info: m => log.info(m), warn: m => log.warn(m) },
    })
    this.monitor = monitor
    this.ready = monitor.start(spec.tickMs)
    ctx.effect(() => () => monitor.stop(), 'adg-monitor watch')

    // Buttons and "停止 / 重试 / 忽略" replies from chat channels.
    ctx.inject(['adgNotify'], scoped => {
      scoped.effect(() => scoped.adgNotify.onAction('monitor', async (noticeId, actionId, actor) => {
        await this.ready
        if (actionId !== 'stop' && actionId !== 'retry' && actionId !== 'resolve' && actionId !== 'resume') throw new Error(`未知操作 ${actionId}`)
        const incident = await monitor.act(noticeId, actionId, { by: 'user', name: actor.name ?? actor.userId })
        return incident.resolution ?? '已处理'
      }), 'adg-monitor notice actions')
    })

    ctx.inject(['adgGateway'], gateway => gateway.adgGateway.agentPart('adg-monitor tools', agent => {
      const registered: Array<() => void> = []
      registered.push(agent.tools.register(incidentsTool(monitor, this.ready)))
      registered.push(agent.tools.register(stallCheckTool(monitor, this.ready)))
      registered.push(agent.tools.register(stallSetTool(monitor, this.ready)))
      return () => { for (const dispose of registered) dispose() }
    }))

    ctx.inject(['adgGateway'], scoped => {
      scoped.adgGateway.register({
        id: MONITOR_CAPABILITY,
        version: 1,
        methods: {
          'monitor/incidents': async params => {
            await this.ready
            const p = params as RequestParams<'monitor/incidents'>
            return { items: monitor.incidents({ status: p.status, runId: p.runId, limit: p.limit }) }
          },
          'monitor/act': async params => {
            await this.ready
            const p = params as RequestParams<'monitor/act'>
            return monitor.act(p.incidentId, p.action)
          },
          'monitor/screenshot': async params => {
            const png = await monitor.screenshot((params as RequestParams<'monitor/screenshot'>).incidentId)
            if (png === undefined) throw new Error('这条异常没有截图')
            return { mime: 'image/png' as const, data: png.toString('base64') }
          },
          'monitor/settings': async () => { await this.ready; return monitor.settings },
          'monitor/settings/set': async params => { await this.ready; return monitor.configure(params as RequestParams<'monitor/settings/set'>) },
        },
      })
    })
  }
}

function incidentsTool(monitor: Monitor, ready: Promise<void>): ToolDefinition {
  return {
    name: 'monitor_incidents',
    description: '查看脚本运行中的异常：出错日志、运行失败、卡住（长时间没有新日志）、超时，以及已经自动做过的处理（重连模拟器、重新运行）。用户问「出什么问题了」「现在什么状态」时先看这里；要停止或重跑用 script_stop / script_run。',
    parameters: {
      type: 'object',
      properties: {
        status: { type: 'string', enum: ['open', 'all'], description: 'open：只看还没处理的（默认）；all：包括已处理的。' },
        run_id: { type: 'string', description: '只看这一次运行的异常。' },
      },
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] },
    timeoutMs: 30_000,
    isConcurrencySafe: () => true,
    execute: async args => {
      await ready
      const a = (args ?? {}) as { status?: unknown; run_id?: unknown }
      const items = monitor.incidents({ status: a.status === 'all' ? 'all' : 'open', runId: typeof a.run_id === 'string' ? a.run_id : undefined, limit: 20 })
      return JSON.parse(JSON.stringify({
        incidents: items.map(i => ({
          id: i.id, run_id: i.runId, script: i.scriptName, task: i.taskTitle, kind: i.kind, tag: i.tag, detail: i.detail,
          status: i.status, resolution: i.resolution, steps: i.steps.map(s => s.detail), last_lines: i.lines.slice(-5),
          at: new Date(i.createdAt).toISOString(),
        })),
      })) as never
    },
    presentCall: () => ({ card: 'generic', title: '查看运行异常', kind: 'read' }),
  }
}

const ScriptIdArg = z.string().trim().min(1).max(64)

function stallCheckTool(monitor: Monitor, ready: Promise<void>): ToolDefinition {
  return {
    name: 'monitor_stall_check',
    description: '看一个脚本正常运行时日志的节奏，用来定它「多久没动静算卡住」：最近几次成功运行里，两条日志之间最长和通常（95%）隔多久，以及现在用的卡住时间和来源（脚本自己的：学到的或设过的 / 脚本包写的 / 默认）。默认 30 秒没新日志就交给干预。',
    parameters: { type: 'object', properties: { id: { type: 'string', description: '脚本 id。' } }, required: ['id'], additionalProperties: false },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] },
    timeoutMs: 60_000,
    isConcurrencySafe: () => true,
    execute: async args => {
      await ready
      const id = ScriptIdArg.parse((args as { id?: unknown } | undefined)?.id)
      const now = monitor.stallFor(id)
      const rhythm = await monitor.rhythm(id)
      return JSON.parse(JSON.stringify({
        stall_seconds: now.seconds,
        source: now.source === 'script' ? (now.entry?.by === 'learned' ? '从这台电脑上的成功运行学到的' : now.entry?.by === 'agent' ? 'agent 设的' : '用户设的') : now.source === 'pack' ? '脚本包写的' : '默认值',
        note: now.entry?.note,
        learned_from: now.entry?.samples.length === 0 ? undefined : now.entry?.samples,
        default_seconds: monitor.settings.defaultStallSeconds,
        recent_successful_runs: rhythm.runs,
        suggested_seconds: rhythm.suggestedSeconds,
        how: '建议值 = 最近成功运行里最长的安静时间 × 1.5（不低于默认值）。脚本有正常的长时间安静（等加载、等体力、长战斗）时把卡住时间设得比它长；真卡住时越短越早发现。',
      })) as never
    },
    presentCall: args => ({ card: 'generic', title: `看日志节奏：${String((args as { id?: unknown } | undefined)?.id ?? '')}`, kind: 'read' }),
  }
}

function stallSetTool(monitor: Monitor, ready: Promise<void>): ToolDefinition {
  return {
    name: 'monitor_stall_set',
    description: '设一个脚本「多久没有新日志算卡住」（秒），先用 monitor_stall_check 看它正常时的日志节奏再定。seconds 填 null 恢复成自动：从它之后的成功运行里学（没学到之前用默认 30 秒）。一个「可能卡住了」的异常其实是这个脚本正常的安静期时，用它调大，再结束异常。',
    parameters: {
      type: 'object',
      properties: {
        id: { type: 'string', description: '脚本 id。' },
        seconds: { type: ['integer', 'null'], description: '秒数（5 以上）；null 恢复自动。' },
        note: { type: 'string', description: '为什么这样定，例如「战斗中最长 70 秒不输出」。' },
      },
      required: ['id', 'seconds'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value) }] },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    execute: async args => {
      await ready
      const a = z.object({ id: ScriptIdArg, seconds: z.number().int().min(5).max(24 * 3600).nullable(), note: z.string().max(300).optional() }).parse(args ?? {})
      const now = await monitor.setStall(a.id, a.seconds, 'agent', a.note)
      return { stall_seconds: now.seconds, source: now.source } as never
    },
    presentCall: args => {
      const a = (args ?? {}) as { id?: unknown; seconds?: unknown }
      return { card: 'generic', title: a.seconds === null ? `卡住时间恢复自动：${String(a.id ?? '')}` : `卡住时间设为 ${String(a.seconds)} 秒：${String(a.id ?? '')}`, kind: 'other' }
    },
  }
}

export default AdgMonitor
