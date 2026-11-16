/**
 * @adg/browser — the agent's `browser_*` tools for the built-in browser of
 * the desktop app (apps/desktop/browser.mjs). The app hands dsh the bridge's
 * address and token (ADG_BROWSER_URL / ADG_BROWSER_TOKEN); without them —
 * dsh started some other way, or the dsh plugin in dsh's own app — this
 * plugin adds nothing.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-attachment'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@adg/gateway'
import { z } from 'zod'
import { browserClient, type BrowserCall } from './client.ts'
import { browserTools } from './tools.ts'

export { browserClient, type BrowserCall, type BrowserEndpoint, type PageView, type Shot } from './client.ts'
export { BROWSER_TOOLS, browserTools, renderPage, type BrowserToolDeps } from './tools.ts'

export const name = 'adg-browser'

const ConfigSchema = z.object({
  /** The bridge's address (`http://127.0.0.1:<port>`); none: no browser here. */
  endpoint: z.string().url().optional(),
  token: z.string().min(1).optional(),
})
export type Config = z.input<typeof ConfigSchema>

export function apply(ctx: Context, config: Config = {}, call?: BrowserCall): void {
  const spec = ConfigSchema.parse(config)
  if (call === undefined && (spec.endpoint === undefined || spec.token === undefined)) return
  const browser = call ?? browserClient({ url: spec.endpoint!, token: spec.token! })

  const sees = async (provider: string, model: string, signal?: AbortSignal): Promise<boolean> => {
    const llm = ctx.get('llm')
    if (llm === undefined) return true
    const info = await llm.resolveModelInfo(provider, model, signal)
    return info.inputModalities?.includes('image') === true
  }

  ctx.inject(['adgGateway'], gateway => gateway.adgGateway.agentPart('adg-browser tools', agent => {
    const tools = browserTools({
      call: browser,
      saveImage: async png => {
        const attachments = ctx.get('attachments')
        if (attachments === undefined) throw new Error('没有图片存储服务，无法把截图交给模型')
        return { ...(await attachments.saveImage({ data: png, mediaType: 'image/png', name: 'browser.png' })) } as unknown as Record<string, unknown>
      },
      checkVision: async exec => {
        const routed = exec.agent?.session.requestHeader()?.config
        const provider = routed?.provider ?? exec.agent?.options.provider
        const model = routed?.model ?? exec.agent?.options.model
        if (provider === undefined || model === undefined) return
        if (!(await sees(provider, model, exec.signal))) throw new Error(`当前模型 ${model} 不能看图片：用 browser_snapshot 读页面内容，或换一个能看图的模型`)
      },
    })
    // 设置 → 权限 decides per area (the gateway's guardTool).
    const registered = tools.map(tool => agent.tools.register({ ...tool, execute: async (args, exec) => { await ctx.get('adgGateway')?.guardTool(exec); return tool.execute(args, exec) } }))
    return () => { for (const dispose of registered) dispose() }
  }))
}
