/**
 * @adg/monitor — incidents while scripts run, L0 recovery from the Script
 * Pack, and the push to chat channels (`ctx.adgMonitor`).
 *
 * Needs the runner and the script library; uses the emulator plugin for ADB
 * reconnects and screenshots, and `@adg/notify` for chat channels, when they
 * are loaded. Contributes the `monitor_incidents` agent tool and the
 * `monitor@1` capability.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@adg/gateway'
import type {} from '@adg/notify'
import type {} from '@adg/runner'
import type {} from '@adg/script-registry'
import { MONITOR_CAPABILITY, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { Monitor } from './monitor.ts'
import { desktopScreenshot } from './screenshot.ts'
import { FileIncidentStore } from './store.ts'

export { Monitor, DEFAULT_SETTINGS, type IncidentStore, type SettingsPatch, type MonitorDeps, type MonitorNotice, type NoticeSink } from './monitor.ts'
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
  /** Stall and overtime check interval. @default 15000 */
  tickMs: z.number().int().min(0).default(15_000),
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
        if (actionId !== 'stop' && actionId !== 'retry' && actionId !== 'resolve') throw new Error(`未知操作 ${actionId}`)
        const incident = await monitor.act(noticeId, actionId, { by: 'user', name: actor.name ?? actor.userId })
        return incident.resolution ?? '已处理'
      }), 'adg-monitor notice actions')
    })

    ctx.inject(['tools'], scoped => {
      scoped.tools.register(incidentsTool(monitor, this.ready))
    })

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

export default AdgMonitor
