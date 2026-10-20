/**
 * @adg/feishu — the Feishu / Lark channel for `@adg/notify` (`ctx.adgFeishu`).
 *
 * The user creates the app and grants its permissions (docs/feishu.zh.md);
 * this plugin only needs the App ID (settings) and the App Secret (dsh
 * credentials, `ADG_FEISHU_APP_SECRET`). Messages and card buttons arrive over
 * the long connection, so no public address is needed. Contributes the
 * `feishu@1` capability.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@adg/gateway'
import type {} from '@adg/notify'
import { FEISHU_CAPABILITY, FEISHU_SECRET_REF, FeishuPending, FeishuSettings, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { sdkApi } from './api.ts'
import { DEFAULT_FEISHU, FeishuBot, type FeishuState } from './bot.ts'
import { writeFileAtomic } from '@adg/protocol/node'

export { FeishuBot, DEFAULT_FEISHU, type BotOptions, type FeishuState, type NotifyPort } from './bot.ts'
export { describeFeishuError, FeishuError, parseCardAction, parseMessage, sdkApi, type CardAction, type CardActionResponse, type ConnectionState, type FeishuApi, type InboundMessage, type Target } from './api.ts'
export { approvalCard, noticeCard } from './cards.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgFeishu: AdgFeishu
  }
}

const ConfigSchema = z.object({
  /** Settings and people waiting to be allowed: `<dataDir>/feishu.json`. */
  dataDir: z.string().min(1),
  /** Base URL instead of open.feishu.cn / open.larksuite.com (tests). */
  baseUrl: z.string().optional(),
})
export type Config = z.input<typeof ConfigSchema>

const Saved = z.object({ settings: FeishuSettings.partial().default({}), pending: z.array(FeishuPending).default([]) })

export class AdgFeishu extends Service {
  static inject = ['adgNotify']
  readonly bot: FeishuBot
  readonly ready: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgFeishu')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-feishu')
    const file = join(spec.dataDir, 'feishu.json')
    const notify = ctx.adgNotify

    const bot = new FeishuBot({
      createApi: ({ appId, appSecret, domain }) => sdkApi({ appId, appSecret, domain: spec.baseUrl ?? domain, log: { info: m => log.info(m), warn: m => log.warn(m) } }),
      secret: async () => (await ctx.get('credentials')?.resolve(credentialRef(FEISHU_SECRET_REF)))?.value,
      load: async (): Promise<FeishuState> => {
        try {
          const saved = Saved.parse(JSON.parse(await readFile(file, 'utf8')))
          return { settings: FeishuSettings.parse({ ...DEFAULT_FEISHU, ...saved.settings }), pending: saved.pending }
        } catch {
          return { settings: DEFAULT_FEISHU, pending: [] }
        }
      },
      save: async state => {
        await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`)
      },
      notify: () => ({
        act: (id, action, actor) => notify.notify.act(id, action, actor),
        inbound: m => notify.inbound(m),
        respondApproval: (id, decision, actor) => notify.notify.respondApproval(id, decision, actor),
      }),
      changed: () => notify.changed(),
      log: { info: m => log.info(m), warn: m => log.warn(m) },
    })
    this.bot = bot
    this.ready = bot.start().catch(error => log.warn(`feishu start failed: ${error instanceof Error ? error.message : String(error)}`))
    ctx.effect(() => () => bot.stop(), 'adg-feishu connection')
    notify.registerChannel(bot)

    // A new App Secret saved from the UI takes effect at once. The first start may
    // have run before the credentials service was up and found no secret: when it
    // arrives, connect with the secret it holds.
    ctx.inject(['credentials'], scoped => {
      void this.ready.then(() => {
        if (!bot.state.secretConfigured || bot.status().state === 'error') return bot.restart()
      })
      scoped.on('credentials/reference-updated', ref => {
        if (ref === FEISHU_SECRET_REF) void this.ready.then(() => bot.restart())
      })
    })

    const view = () => ({ settings: bot.state.settings, secretConfigured: bot.state.secretConfigured, pending: bot.state.pending })
    ctx.inject(['adgGateway'], scoped => {
      scoped.adgGateway.register({
        id: FEISHU_CAPABILITY,
        version: 1,
        methods: {
          'feishu/settings': async () => { await this.ready; return view() },
          'feishu/settings/set': async params => {
            await this.ready
            await bot.configure(params as RequestParams<'feishu/settings/set'>)
            return view()
          },
          'feishu/users/allow': async params => {
            await this.ready
            const p = params as RequestParams<'feishu/users/allow'>
            await bot.allow(p.openId, p.name)
            return view()
          },
          'feishu/users/remove': async params => {
            await this.ready
            await bot.remove((params as RequestParams<'feishu/users/remove'>).openId)
            return view()
          },
          'feishu/check': async () => {
            await this.ready
            // A secret saved while disconnected, or a fixed permission: reconnect, then report.
            if (bot.status().state !== 'ready') await bot.restart()
            return { checks: await bot.check() }
          },
        },
      })
    })
  }
}

export default AdgFeishu
