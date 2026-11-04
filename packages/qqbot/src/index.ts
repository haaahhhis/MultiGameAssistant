/**
 * @adg/qqbot — the QQ official bot channel for `@adg/notify` (`ctx.adgQQBot`),
 * the second way of 远程连接 after Feishu.
 *
 * The user creates the bot on the QQ open platform (bot.q.qq.com) and turns
 * on direct messages; this plugin needs its AppID (settings) and AppSecret
 * (dsh credentials, `ADG_QQBOT_APP_SECRET`). Messages arrive over the
 * WebSocket gateway, so no public address is needed. Contributes the
 * `qqbot@1` capability.
 */
import { createHash } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import { credentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@adg/gateway'
import type {} from '@adg/notify'
import { QQBOT_CAPABILITY, QQBOT_SECRET_REF, QQPending, QQSettings, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { httpApi } from './api.ts'
import { DEFAULT_QQ, QQBot, type QQState } from './bot.ts'
import { writeFileAtomic } from '@adg/protocol/node'

export { httpApi, QQError, type ConnectionState, type HttpApiOptions, type QQApi, type QQMessage } from './api.ts'
export { DEFAULT_QQ, noticeText, plainText, QQBot, type BotOptions, type NotifyPort, type QQState } from './bot.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgQQBot: AdgQQBot
  }
}

const ConfigSchema = z.object({
  /** Settings and people waiting to be allowed: `<dataDir>/qqbot.json`. */
  dataDir: z.string().min(1),
  /** API base instead of api.bot.qq.com (tests). */
  baseUrl: z.string().optional(),
})
export type Config = z.input<typeof ConfigSchema>

const Saved = z.object({ settings: QQSettings.partial().default({}), pending: z.array(QQPending).default([]) })

export class AdgQQBot extends Service {
  static inject = ['adgNotify']
  readonly bot: QQBot
  readonly ready: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgQQBot')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-qqbot')
    const file = join(spec.dataDir, 'qqbot.json')
    const notify = ctx.adgNotify
    const logPort = { info: (m: string) => log.info(m), warn: (m: string) => log.warn(m) }

    const bot = new QQBot({
      createApi: ({ appId, secret }) => httpApi({ appId, secret, ...(spec.baseUrl === undefined ? {} : { base: spec.baseUrl }), log: logPort }),
      secret: async () => (await ctx.get('credentials')?.resolve(credentialRef(QQBOT_SECRET_REF)))?.value,
      load: async (): Promise<QQState> => {
        try {
          const saved = Saved.parse(JSON.parse(await readFile(file, 'utf8')))
          return { settings: QQSettings.parse({ ...DEFAULT_QQ, ...saved.settings }), pending: saved.pending }
        } catch {
          return { settings: DEFAULT_QQ, pending: [] }
        }
      },
      save: async state => { await writeFileAtomic(file, `${JSON.stringify(state, null, 2)}\n`) },
      notify: () => ({ inbound: m => notify.inbound(m), waiting: actor => notify.notify.waiting(actor) }),
      changed: () => notify.changed(),
      log: logPort,
    })
    this.bot = bot
    this.ready = bot.start().catch(error => log.warn(`qq start failed: ${error instanceof Error ? error.message : String(error)}`))
    ctx.effect(() => () => bot.stop(), 'adg-qqbot connection')
    notify.registerChannel(bot)

    // A new AppSecret saved from the UI takes effect at once; one that arrives after the first start too.
    ctx.inject(['credentials'], scoped => {
      void this.ready.then(() => {
        if (!bot.state.secretConfigured || bot.status().state === 'error') return bot.restart()
      })
      scoped.on('credentials/reference-updated', ref => {
        if (ref === QQBOT_SECRET_REF) void this.ready.then(() => bot.restart())
      })
    })

    const view = () => ({ settings: bot.state.settings, secretConfigured: bot.state.secretConfigured, pending: bot.state.pending })
    ctx.inject(['adgGateway'], scoped => {
      // Two copies of the app on one bot split its messages (gateway instances.ts).
      scoped.effect(() => scoped.adgGateway.instances.fact('qqbot', () => {
        const { enabled, appId } = bot.state.settings
        return enabled && appId !== undefined ? createHash('sha256').update(appId).digest('hex').slice(0, 16) : undefined
      }), 'adg-qqbot bot in use')
      scoped.adgGateway.register({
        id: QQBOT_CAPABILITY,
        version: 1,
        methods: {
          'qqbot/settings': async () => { await this.ready; return view() },
          'qqbot/settings/set': async params => {
            await this.ready
            await bot.configure(params as RequestParams<'qqbot/settings/set'>)
            return view()
          },
          'qqbot/users/allow': async params => {
            await this.ready
            const p = params as RequestParams<'qqbot/users/allow'>
            await bot.allow(p.openId, p.name)
            return view()
          },
          'qqbot/users/remove': async params => {
            await this.ready
            await bot.remove((params as RequestParams<'qqbot/users/remove'>).openId)
            return view()
          },
          'qqbot/check': async () => {
            await this.ready
            if (bot.status().state !== 'ready') await bot.restart()
            return { checks: await bot.check() }
          },
        },
      })
    })
  }
}

export default AdgQQBot
