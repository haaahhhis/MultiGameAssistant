/**
 * @adg/scheduler — pipelines on a timetable, chained pipelines, and starting
 * at logon (`ctx.adgScheduler`). Needs the orchestrator. Contributes the
 * `schedule@1` capability.
 *
 * The desktop app passes `ADG_LAUNCH_COMMAND` (how to start it again) and,
 * when it was started at logon, `ADG_AUTOSTARTED=1`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@adg/gateway'
import type {} from '@adg/orchestrator'
import { SCHEDULE_CAPABILITY, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { windowsAutostart } from './autostart.ts'
import { Scheduler, type SavedState } from './scheduler.ts'

export { Scheduler, DEFAULT_SETTINGS, localDay, slotsBetween, type AutostartPort, type SavedState, type ScheduleStore, type SchedulerDeps } from './scheduler.ts'
export { joinArgs, taskXml, windowsAutostart, type ExecBuffer, type WindowsAutostartOptions } from './autostart.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgScheduler: AdgScheduler
  }
}

const ConfigSchema = z.object({
  /** `<dataDir>/schedule.json`. */
  dataDir: z.string().min(1),
  /** JSON array: the program and arguments that start the desktop app at logon. */
  launchCommand: z.string().optional(),
  autostarted: z.boolean().default(false),
  /** The desktop app was just started (not dsh restarted after a crash). */
  appStart: z.boolean().default(false),
  /** Windows task name. @default AutoDailyGamePlay */
  taskName: z.string().optional(),
})
export type Config = z.input<typeof ConfigSchema>

export class AdgScheduler extends Service {
  static inject = ['adgOrchestrator']
  readonly scheduler: Scheduler
  readonly ready: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgScheduler')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-scheduler')
    const orchestrator = ctx.adgOrchestrator
    const file = join(spec.dataDir, 'schedule.json')
    let command: string[] | undefined
    try {
      command = spec.launchCommand === undefined ? undefined : z.array(z.string().min(1)).min(1).parse(JSON.parse(spec.launchCommand))
    } catch {
      log.warn('ADG_LAUNCH_COMMAND is not a JSON array of strings; autostart is unavailable')
    }
    const autostart = windowsAutostart({ command, ...(spec.taskName === undefined ? {} : { taskName: spec.taskName }) })
    const changed = () => ctx.get('adgGateway')?.broadcast('schedule/changed', {})

    const scheduler = new Scheduler({
      pipelines: () => orchestrator.pipelines.all(),
      start: (id, trigger) => { orchestrator.pipelines.run(id, trigger) },
      isRunning: id => orchestrator.engine.isRunning(id),
      lastSuccessDay: id => orchestrator.pipelines.lastSuccessDay(id),
      store: {
        load: async () => {
          try { return JSON.parse(await readFile(file, 'utf8')) as Partial<SavedState> } catch { return {} }
        },
        save: async state => {
          await mkdir(spec.dataDir, { recursive: true })
          await writeFile(`${file}.tmp`, `${JSON.stringify(state, null, 2)}\n`)
          await rename(`${file}.tmp`, file)
        },
      },
      autostart,
      autostarted: spec.autostarted,
      appStart: spec.appStart,
      changed,
      log: { info: m => log.info(m), warn: m => log.warn(m) },
    })
    this.scheduler = scheduler
    this.ready = orchestrator.ready.then(() => scheduler.start())
    ctx.effect(() => () => scheduler.stop(), 'adg-scheduler timer')
    ctx.effect(() => orchestrator.engine.onEnded(run => scheduler.pipelineEnded(run)), 'adg-scheduler chains')
    if (spec.autostarted) log.info('started at logon')

    const status = async () => {
      await this.ready
      const registration = await autostart.status().catch(error => ({ registered: false, detail: error instanceof Error ? error.message : String(error) }))
      return {
        settings: scheduler.settings,
        autostart: {
          available: autostart.available(),
          registered: registration.registered,
          ...(registration.detail !== undefined ? { detail: registration.detail } : !autostart.available() ? { detail: '用浏览器或开发模式打开时不能设置；请用桌面版' } : {}),
        },
        autostarted: spec.autostarted,
        upcoming: scheduler.upcoming(12),
        history: scheduler.history().slice(0, 40),
      }
    }
    ctx.inject(['adgGateway'], scoped => {
      scoped.adgGateway.register({
        id: SCHEDULE_CAPABILITY,
        version: 1,
        methods: {
          'schedule/status': () => status(),
          'schedule/settings/set': async params => {
            await this.ready
            await scheduler.configure(params as RequestParams<'schedule/settings/set'>)
            return status()
          },
        },
      })
    })
  }
}

export default AdgScheduler
