/**
 * @adg/intervene — the agent looking at the screen and acting on it
 * (`ctx.adgIntervene`): the `screen_*` / `window_*` tools for any
 * image-capable model, and interventions — the monitor hands over what L0
 * recovery could not settle; the script is paused, the agent handles it or
 * explains why it cannot. Contributes the `intervene@1` capability.
 *
 * Executors: ADB through `@adg/emulator` for the emulator; a small Windows
 * helper (Win32 calls, compiled once) for the desktop and windows.
 */
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent-default-model'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@adg/gateway'
import type {} from '@adg/notify'
import type {} from '@adg/runner'
import { sessionConversations } from '@adg/notify'
import { INTERVENE_CAPABILITY, type Incident, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { Interventions, type Outcome } from './interventions.ts'
import { Screens } from './screens.ts'
import { screenTools } from './tools.ts'
import { WinHelper } from './winhelper.ts'

export { Interventions, type Active, type InterventionDeps, type Outcome } from './interventions.ts'
export { Screens, toDevice, type AdbPort, type Frame, type Shot, type TargetKind } from './screens.ts'
export { screenTools, type ScreenToolDeps } from './tools.ts'
export { WinHelper, type WinWindow } from './winhelper.ts'
export { decodePng, encodePng, fitPng, pngSize, shrink, type Raster } from './png.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgIntervene: AdgIntervene
  }
}

const ConfigSchema = z.object({
  /** Intervention records: `<dataDir>/intervene/`. */
  dataDir: z.string().min(1),
  /** Screenshots are shrunk to this long edge for the model. @default 1280 */
  maxEdge: z.number().int().min(320).max(4096).default(1280),
  /** An intervention gives up after this many minutes. @default 15 */
  timeoutMinutes: z.number().int().min(1).max(120).default(15),
})
export type Config = z.input<typeof ConfigSchema>

export class AdgIntervene extends Service {
  static inject = ['adgRunner']
  readonly interventions: Interventions
  readonly ready: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgIntervene')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-intervene')
    const runner = ctx.adgRunner.runner
    // The compiled desktop helper is kept with the plugin's data, so it is built once.
    const helper = new WinHelper({ cacheDir: join(spec.dataDir, 'intervene', 'bin') })
    ctx.effect(() => () => helper.dispose(), 'adg-intervene helper')

    const screens = new Screens({ adb: () => ctx.get('adgEmulators'), win: helper, maxEdge: () => spec.maxEdge })

    /** Whether a model accepts images. */
    const sees = async (provider: string, model: string, signal?: AbortSignal): Promise<boolean> => {
      const llm = ctx.get('llm')
      if (llm === undefined) return true
      const info = await llm.resolveModelInfo(provider, model, signal)
      return info.inputModalities?.includes('image') === true
    }

    const interventions = new Interventions({
      runner,
      suspend: (pid, resume) => helper.call<number>('suspend', { pid, resume }),
      conversations: () => {
        const sessions = ctx.get('sessionController')
        return sessions === undefined ? undefined : sessionConversations(sessions, () => ctx.get('adgGateway')?.workspaceDir(), (id, f) => ctx.get('adgGateway')?.skillScope.setFocus(id, f) ?? Promise.resolve())
      },
      visionProblem: async () => {
        const selection = ctx.get('agentDefaultModel')?.currentSelection()
        if (selection === undefined) return undefined
        return (await sees(selection.provider, selection.model)) ? undefined : `默认模型 ${selection.model} 不能看图片，agent 没法查看截图；在「设置 → 模型」把默认模型换成能看图的（例如 Claude、GPT-4o、Gemini、通义 VL）`
      },
      describeTargets: run => {
        const parts = run.resources.flatMap(r => r.startsWith('adb:') ? [`模拟器 ${r.slice(4)}（target=emulator）`] : r === 'desktop' ? ['桌面（target=desktop；用 window_list 找到游戏窗口后也可以 target=window 只截这个窗口）'] : [])
        return parts.length > 0 ? parts.join('；') : '没有（这个任务不用模拟器也不用桌面，只能截图查看、更新或重新运行脚本）'
      },
      onChange: item => ctx.get('adgGateway')?.broadcast('intervene/changed', item),
      settle: async (incidentId, action) => {
        // The monitor depends on this plugin, so it is looked up by name, not imported.
        const monitor = (ctx.get('adgMonitor' as never) as { monitor?: { act(id: string, action: 'retry' | 'resume' | 'resolve', who: { by: 'agent'; name: string }): Promise<unknown> } } | undefined)?.monitor
        if (monitor === undefined) return false
        await monitor.act(incidentId, action, { by: 'agent', name: 'agent' })
        return true
      },
      dataDir: spec.dataDir,
      timeoutMs: spec.timeoutMinutes * 60_000,
      log: { info: m => log.info(m), warn: m => log.warn(m) },
    })
    this.interventions = interventions
    this.ready = interventions.load()

    ctx.inject(['tools'], scoped => {
      const tools = screenTools({
        screens,
        interventions,
        locks: runner.locks,
        saveImage: async png => {
          const attachments = ctx.get('attachments')
          if (attachments === undefined) throw new Error('没有图片存储服务，无法把截图交给模型')
          return { ...(await attachments.saveImage({ data: png, mediaType: 'image/png', name: 'screen.png' })) } as unknown as Record<string, unknown>
        },
        checkVision: async exec => {
          const routed = exec.agent?.session.requestHeader()?.config
          const provider = routed?.provider ?? exec.agent?.options.provider
          const model = routed?.model ?? exec.agent?.options.model
          if (provider === undefined || model === undefined) return
          if (!(await sees(provider, model, exec.signal))) throw new Error(`当前模型 ${model} 不能看图片：在输入框旁边换一个能看图的模型（例如 Claude、GPT-4o、Gemini）再试`)
        },
        approve: async (exec, reason) => {
          const approval = ctx.get('approval')
          if (approval === undefined || exec.agent === undefined) return false
          return (await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason, signal: exec.signal })) === 'allowed-once'
        },
        sendToSession: async (sessionId, title, png) => {
          const notify = ctx.get('adgNotify')
          if (notify === undefined) return false
          return notify.sendToSession(sessionId, { id: `shot:${Date.now()}`, scope: 'intervene', title: `截图：${title}`, text: new Date().toLocaleString('zh-CN', { hour12: false }), severity: 'info', image: png })
        },
      })
      // 设置 → 权限 decides per area (the gateway's guardTool).
      for (const tool of tools) scoped.tools.register({ ...tool, execute: async (args, exec) => { await ctx.get('adgGateway')?.guardTool(exec); return tool.execute(args, exec) } })
    })

    ctx.inject(['adgGateway'], scoped => {
      scoped.adgGateway.register({
        id: INTERVENE_CAPABILITY,
        version: 1,
        methods: {
          'intervene/list': async params => { await this.ready; return { items: interventions.list((params as RequestParams<'intervene/list'>).limit ?? 30) } },
          'intervene/takeover': async params => { await this.ready; return interventions.takeover((params as RequestParams<'intervene/takeover'>).id) },
          'intervene/release': async params => {
            await this.ready
            const p = params as RequestParams<'intervene/release'>
            return interventions.release(p.id, p.then)
          },
        },
      })
    })
  }

  /** The monitor hands over an incident. Never throws. */
  async handle(incident: Incident, mode: 'diagnose' | 'act', screenshot: Buffer | undefined): Promise<Outcome> {
    await this.ready
    return this.interventions.handle(incident, mode, screenshot)
  }

  countToday(): number {
    return this.interventions.countToday()
  }

  cancel(incidentId: string, why: string): void {
    this.interventions.cancel(incidentId, why)
  }

  /** The latest screenshot the screen tools took in a session. */
  lastShot(sessionId: string): Buffer | undefined {
    return this.interventions.lastShot(sessionId)
  }

  resumeRun(runId: string): Promise<boolean> {
    return this.interventions.resumeRun(runId)
  }
}

export default AdgIntervene
