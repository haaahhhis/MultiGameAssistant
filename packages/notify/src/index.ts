/**
 * @adg/notify — the chat layer (`ctx.adgNotify`): channels register here;
 * other plugins send notices with buttons and handle the clicks; people's
 * messages become conversations with the agent; approvals go out as cards.
 * Contributes the `notify@1` capability. Channels: `@adg/feishu`.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@adg/gateway'
import { NOTIFY_CAPABILITY, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { sessionConversations } from './conversations.ts'
import { Notify, type ActionHandler, type Actor, type Channel, type Notice, type NoticePatch } from './notify.ts'

export { Notify, type ActionHandler, type Actor, type Channel, type Conversations, type Notice, type NoticeAction, type NoticePatch, type NotifyOptions } from './notify.ts'
export { sessionConversations } from './conversations.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgNotify: AdgNotify
  }
}

const ConfigSchema = z.object({
  /** Person → agent session map: `<dataDir>/notify/sessions.json`. */
  dataDir: z.string().min(1),
})
export type Config = z.input<typeof ConfigSchema>

export class AdgNotify extends Service {
  readonly notify: Notify
  private readonly sessionsFile: string
  private sessionMap: Record<string, string> = {}
  readonly ready: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgNotify')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-notify')
    this.sessionsFile = join(spec.dataDir, 'notify', 'sessions.json')
    this.ready = readFile(this.sessionsFile, 'utf8').then(text => { this.sessionMap = JSON.parse(text) as Record<string, string> }, () => {})
    const notify = new Notify({
      conversations: () => {
        const sessions = ctx.get('sessionController')
        if (sessions === undefined) return undefined
        const base = sessionConversations(sessions)
        // Archived by the user: the person's next message starts a new conversation.
        return { ...base, exists: async (id: string) => ctx.get('adgGateway')?.isArchived(id) !== true && base.exists(id) }
      },
      respondApproval: (id, decision) => ctx.get('adgGateway')?.respondApproval(id, decision) ?? false,
      sessions: {
        get: key => this.sessionMap[key],
        keyOf: sessionId => Object.entries(this.sessionMap).find(([, id]) => id === sessionId)?.[0],
        set: async (key, sessionId) => {
          this.sessionMap[key] = sessionId
          await mkdir(join(spec.dataDir, 'notify'), { recursive: true })
          await writeFile(`${this.sessionsFile}.tmp`, JSON.stringify(this.sessionMap, null, 2))
          await rename(`${this.sessionsFile}.tmp`, this.sessionsFile)
          ctx.get('adgGateway')?.broadcast('notify/changed', {})
        },
      },
      changed: () => ctx.get('adgGateway')?.broadcast('notify/changed', {}),
      log: { info: m => log.info(m), warn: m => log.warn(m) },
    })
    this.notify = notify

    ctx.inject(['adgGateway'], scoped => {
      scoped.adgGateway.addApprovalAnswerer({
        active: () => notify.approvalsActive(),
        asked: request => notify.askApproval(request),
        resolved: (id, outcome) => notify.approvalResolved(id, outcome),
      })
      scoped.adgGateway.register({
        id: NOTIFY_CAPABILITY,
        version: 1,
        methods: {
          'notify/status': () => ({ channels: notify.channels() }),
          'notify/conversations': async () => {
            await this.ready
            return {
              items: Object.entries(this.sessionMap).map(([key, sessionId]) => {
                const [channel = '', ...user] = key.split(':')
                return { sessionId, channel, user: user.join(':') }
              }),
            }
          },
          'notify/test': params => notify.test((params as RequestParams<'notify/test'>).channel),
        },
      })
    })
  }

  // Thin forwards, so `ctx.adgNotify` works as the monitor's notice sink.

  /** @returns a disposer; the registration belongs to the caller's fiber. */
  registerChannel(channel: Channel): () => void {
    let dispose: () => void = () => {}
    this.ctx.effect(() => {
      dispose = this.notify.registerChannel(channel)
      return dispose
    }, `adg-notify channel ${channel.id}`)
    return () => dispose()
  }

  onAction(scope: string, handler: ActionHandler): () => void {
    return this.notify.onAction(scope, handler)
  }

  send(notice: Notice): Promise<string[]> {
    return this.notify.send(notice)
  }

  update(id: string, patch: NoticePatch): Promise<void> {
    return this.notify.update(id, patch)
  }

  sendToSession(sessionId: string, notice: Notice): Promise<boolean> {
    return this.notify.sendToSession(sessionId, notice)
  }

  async inbound(message: { actor: Actor; text: string; replyTo?: string | undefined; signal?: AbortSignal }): Promise<string> {
    await this.ready
    return this.notify.inbound(message)
  }

  changed(): void {
    this.ctx.get('adgGateway')?.broadcast('notify/changed', {})
  }
}

export default AdgNotify
