/**
 * @adg/runner — runs Script Pack tasks as a Cordis service (`ctx.adgRunner`).
 *
 * Needs the script library (`ctx.adgScripts`); uses the emulator plugin
 * (`ctx.adgEmulators`) for `adb` tasks when it is loaded. Contributes the
 * `script_tasks` / `script_run` / `script_stop` / `script_runs` agent tools and
 * the `runs@1` gateway capability.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@adg/gateway'
import type {} from '@adg/script-registry'
import { RUNS_CAPABILITY, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { Runner, type EmulatorBridge, type LibraryView } from './runs.ts'
import { configStatus, importConfig } from './config.ts'
import { runnerTools } from './tools.ts'

export { Runner, killTree, parseDuration, type EmulatorBridge, type LibraryView, type RunListener, type RunnerOptions } from './runs.ts'
export { applyPatches, editText, setIn } from './patch.ts'
export { ConfigProfiles, declaredFiles, type Injection, type ProfileStatus } from './profiles.ts'
export { BusyError, ResourceLocks, describe as describeResource, type Holder } from './locks.ts'
export { LogTail } from './tail.ts'
export { TOOL_NAMES } from './tools.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgRunner: AdgRunner
    /** Provided by `@adg/emulator`; declared here so the runner can use it without depending on it. */
    adgEmulators?: EmulatorBridge
  }
}

const ConfigSchema = z.object({
  /** Run records, logs and config backups: `<dataDir>/runs/<id>/`. */
  dataDir: z.string().min(1),
})
export type Config = z.input<typeof ConfigSchema>

export class AdgRunner extends Service {
  static inject = ['adgScripts']
  readonly runner: Runner

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgRunner')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-runner')
    const scripts = ctx.adgScripts
    this.runner = new Runner({
      library: { get: id => scripts.library.get(id), packOf: id => scripts.library.packOf(id) },
      dataDir: spec.dataDir,
      emulators: () => ctx.get('adgEmulators'),
      onState: run => ctx.get('adgGateway')?.broadcast('runs/state', run),
      onLog: (runId, lines) => ctx.get('adgGateway')?.broadcast('runs/log', { runId, lines }),
      log: { info: m => log.info(m), warn: m => log.warn(m) },
    })
    const runner = this.runner
    const library: LibraryView = { get: id => scripts.library.get(id), packOf: id => scripts.library.packOf(id) }
    ctx.effect(() => () => { void runner.dispose() }, 'adg-runner runs')

    ctx.inject(['tools'], scoped => {
      for (const tool of runnerTools(runner, { library, dataDir: spec.dataDir })) {
        scoped.tools.register({ ...tool, execute: async (args, exec) => { await scripts.ready; return tool.execute(args, exec) } })
      }
    })

    ctx.inject(['adgGateway'], scoped => {
      scoped.adgGateway.register({
        id: RUNS_CAPABILITY,
        version: 1,
        methods: {
          'runs/tasks': async params => { await scripts.ready; return runner.tasks((params as RequestParams<'runs/tasks'>).scriptId) },
          'runs/start': async params => {
            await scripts.ready
            const p = params as RequestParams<'runs/start'>
            return runner.start(p.scriptId, p.taskId, p.params ?? {})
          },
          'runs/stop': async params => { await runner.stop((params as RequestParams<'runs/stop'>).runId); return {} },
          'runs/list': params => ({ items: runner.list((params as RequestParams<'runs/list'>).scriptId) }),
          'runs/logs': params => {
            const p = params as RequestParams<'runs/logs'>
            return { lines: runner.logs(p.runId, p.limit ?? 200) }
          },
          'configs/status': async params => {
            await scripts.ready
            return configStatus(library, runner.profiles, (params as RequestParams<'configs/status'>).scriptId)
          },
          'configs/import': async params => {
            await scripts.ready
            return { imported: await importConfig(library, runner.profiles, (params as RequestParams<'configs/import'>).scriptId) }
          },
          'configs/open': async params => {
            await scripts.ready
            return runner.settings((params as RequestParams<'configs/open'>).scriptId)
          },
        },
      })
    })
  }
}

export default AdgRunner
