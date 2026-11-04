/**
 * @adg/notify — the chat layer (`ctx.adgNotify`): channels register here;
 * other plugins send notices with buttons and handle the clicks; people's
 * messages become conversations with the agent; approvals and the agent's
 * questions go out as cards.
 * 助手's conversation is mirrored to every channel's people (mirror.ts); the
 * notices are part of it (kept, shown in the app, told to 助手: notices.ts).
 * Contributes the `notify@1` capability. Channels: `@adg/feishu`, `@adg/qqbot`.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@adg/gateway'
import { NOTIFY_CAPABILITY, type RequestParams } from '@adg/protocol'
import { noticeActTool, noticesMessage } from './notices.ts'
import { z } from 'zod'
import { sessionConversations } from './conversations.ts'
import { delegateTool } from './delegate.ts'
import { MAIN } from './handoff.ts'
import { HomeMirror } from './mirror.ts'
import type { Reply } from './reply.ts'
import { Notify, noticesNote, type ActionHandler, type KeptNotice, type Actor, type Channel, type Notice, type NoticePatch } from './notify.ts'
import { writeFileAtomic } from '@adg/protocol/node'

export { approvalText, describeQuestion, questionText, Notify, personWords, type ActionHandler, type Actor, type Channel, type Conversations, type HandOffInput, type MirrorPost, type Notice, type NoticeAction, type NoticePatch, type NotifyOptions, type QuestionProgress } from './notify.ts'
export { HomeMirror, type MirrorDeps } from './mirror.ts'
export { NOTICES_SOURCE, noticeActTool } from './notices.ts'
export { sessionConversations } from './conversations.ts'
export { MAIN } from './handoff.ts'
export { finalText, replyMarkdown, replyPlain, textReply, type Reply, type ReplyBlock, type ReplyStep } from './reply.ts'

/** The part of dsh's agent/pre-step the notices note reads. */
interface NoticeStep {
  readonly agent: { readonly session: { readonly id: string } }
  readonly step: number
  readonly signal: AbortSignal
}
type NoticeDecision = { kind: 'reject' } | { kind: 'enter'; messages: unknown[] }

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgNotify: AdgNotify
  }
}

const ConfigSchema = z.object({
  /** Person → the conversation their messages go to: `<dataDir>/notify/sessions.json`. */
  dataDir: z.string().min(1),
})
export type Config = z.input<typeof ConfigSchema>

export class AdgNotify extends Service {
  readonly notify: Notify
  private readonly sessionsFile: string
  private readonly noticesFile: string
  private sessionMap: Record<string, string> = {}
  readonly ready: Promise<void>

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgNotify')
    const spec = ConfigSchema.parse(config)
    const log = ctx.logger('adg-notify')
    this.sessionsFile = join(spec.dataDir, 'notify', 'sessions.json')
    this.noticesFile = join(spec.dataDir, 'notify', 'notices.json')
    const noticesFile = this.noticesFile
    const conversations = () => {
      const sessions = ctx.get('sessionController')
      if (sessions === undefined) return undefined
      return sessionConversations(sessions, () => ctx.get('adgGateway')?.workspaceDir(), (id, f) => ctx.get('adgGateway')?.skillScope.setFocus(id, f) ?? Promise.resolve(), () => ctx.get('adgGateway'))
    }
    const notify = new Notify({
      conversations,
      respondApproval: (id, decision) => ctx.get('adgGateway')?.respondApproval(id, decision) ?? false,
      respondQuestion: (id, answers) => ctx.get('adgGateway')?.respondQuestion(id, answers) ?? false,
      sessions: {
        get: key => this.sessionMap[key],
        keyOf: sessionId => Object.entries(this.sessionMap).find(([, id]) => id === sessionId)?.[0],
        set: async (key, sessionId) => {
          this.sessionMap[key] = sessionId
          await writeFileAtomic(this.sessionsFile, JSON.stringify(this.sessionMap, null, 2))
          ctx.get('adgGateway')?.broadcast('notify/changed', {})
        },
      },
      changed: () => ctx.get('adgGateway')?.broadcast('notify/changed', {}),
      log: { info: m => log.info(m), warn: m => log.warn(m) },
      history: {
        load: async () => JSON.parse(await readFile(noticesFile, 'utf8')) as KeptNotice[],
        save: items => writeFileAtomic(noticesFile, JSON.stringify(items, null, 2)),
      },
      noticeChanged: item => ctx.get('adgGateway')?.broadcast('notify/notice', { item }),
    })
    this.notify = notify
    this.ready = Promise.all([
      readFile(this.sessionsFile, 'utf8').then(text => { this.sessionMap = JSON.parse(text) as Record<string, string> }, () => {}),
      notify.loadHistory(),
    ]).then(() => {})

    ctx.inject(['adgGateway'], scoped => {
      // 助手's conversation, the same in the app and in every chat app (mirror.ts).
      const gateway = scoped.adgGateway
      const mirror = new HomeMirror({
        sessions: () => ctx.get('sessionController'),
        home: () => gateway.home(MAIN),
        originOf: text => notify.originOf(text),
        channelName: id => notify.channelName(id),
        agentName: id => gateway.roles.list().find(r => r.id === id)?.name ?? id,
        post: (post, except) => notify.mirror(post, except),
        log: { warn: m => log.warn(m) },
      })
      mirror.start()
      const unlisten = gateway.handOffs.onChange(item => mirror.handOff(item))
      scoped.effect(() => () => { unlisten(); mirror.stop() }, 'adg-notify mirror')
      scoped.adgGateway.addApprovalAnswerer({
        active: sessionId => notify.approvalsActive(sessionId),
        asked: request => notify.askApproval(request),
        resolved: (id, outcome) => notify.approvalResolved(id, outcome),
      })
      // 助手 hands work to the role agents (delegate.ts); the gateway keeps the tool from them. What comes back reaches the chat apps through the mirror.
      scoped.adgGateway.agentPart('adg-notify agent_delegate', agent => agent.tools.register(delegateTool({ agents: () => scoped.adgGateway.roles.list(), conversations })))
      // The notices sent since 助手's last turn, told when its next one starts (notices.ts); notice_act answers them for the person.
      scoped.adgGateway.agentPart('adg-notify notice_act', agent => agent.tools.register(noticeActTool(notify, gateway.roles.list().find(r => r.id === MAIN)?.name ?? '助手')))
      const timeZone = Intl.DateTimeFormat().resolvedOptions().timeZone
      scoped.adgGateway.agentPart('adg-notify notices note', agent => agent.on('agent/pre-step' as never, (async (payload: NoticeStep, next: () => Promise<NoticeDecision>) => {
        const decision = await next()
        if (decision.kind !== 'enter' || payload.step !== 1 || payload.signal.aborted) return decision
        try {
          const items = notify.untold()
          if (items.length === 0 || payload.agent.session.id !== await gateway.home(MAIN)) return decision
          notify.markTold(items.map(n => n.id))
          return { ...decision, messages: [...decision.messages, noticesMessage(noticesNote(items, timeZone))] }
        } catch (error) {
          log.warn(`notices note for ${payload.agent.session.id}: ${error instanceof Error ? error.message : String(error)}`)
          return decision
        }
      }) as never, true))
      scoped.adgGateway.addQuestionAnswerer({
        active: sessionId => notify.questionsActive(sessionId),
        asked: request => notify.askQuestion(request),
        resolved: (id, outcome, answers) => notify.questionResolved(id, outcome, answers),
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
          'notify/notices': async () => {
            await this.ready
            return { items: notify.notices() }
          },
          'notify/act': async params => {
            const { noticeId, actionId } = params as RequestParams<'notify/act'>
            return { result: await notify.act(noticeId, actionId, { channel: 'app', userId: 'app' }) }
          },
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

  async inbound(message: { actor: Actor; text: string; replyTo?: string | undefined; signal?: AbortSignal }): Promise<Reply> {
    await this.ready
    return this.notify.inbound(message)
  }

  changed(): void {
    this.ctx.get('adgGateway')?.broadcast('notify/changed', {})
  }
}

export default AdgNotify
