/**
 * The notices sent to the chat apps are part of 助手's conversation
 * (notify.ts): when its next turn starts, 助手 is told about the ones sent
 * since (`noticesMessage`, a note appended to the step like the gateway's
 * time note, kept in the history but not shown in the app, which shows the
 * notices themselves); and `notice_act` lets it pick an action for the person
 * who answered one in words (「改吧」 to 「脚本包要不要跟着改？」).
 *
 * Like agent_delegate, only 助手 has the tool: role agents keep their own tools.
 */
import { randomUUID } from 'node:crypto'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Actor, Notify } from './notify.ts'

/** The source of the note, so it is told apart from what people write. */
export const NOTICES_SOURCE = 'adg-notices'

/** The note as a message of the step (the shape of the gateway's time note). */
export function noticesMessage(text: string): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: NOTICES_SOURCE, form: 'snapshot', sections: Object.freeze([Object.freeze({ name: NOTICES_SOURCE, text })]) }),
  })
}

const Args = z.object({
  notice: z.string().trim().min(1),
  action: z.string().trim().min(1),
})

export function noticeActTool(notify: Notify, agentName: string): ToolDefinition {
  return {
    name: 'notice_act',
    description: '替主人选一条通知上的操作，和他在飞书、QQ 或软件里点那个按钮一样。只在主人的话明确是在回应那条通知时用（通知和可选操作见对话里的「（通知）」）。返回操作的结果。',
    parameters: {
      type: 'object',
      properties: {
        notice: { type: 'string', description: '通知的 notice=… 那一串。' },
        action: { type: 'string', description: '操作的 action=… 那个 id。' },
      },
      required: ['notice', 'action'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: String((value as { result: string }).result) }] },
    isConcurrencySafe: () => false,
    execute: async args => {
      const parsed = Args.safeParse(args ?? {})
      if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
      const { notice, action } = parsed.data
      const item = notify.notices().find(n => n.id === notice)
      if (item === undefined) throw new Error('没有这条通知（可能太久了）')
      if (item.acted !== undefined) throw new Error(`这条通知已经处理过了：${item.acted.by}选了「${item.acted.label}」——${item.acted.result}`)
      if (item.done !== undefined) throw new Error(`这条通知已经结束了：${item.done}`)
      if (!item.actions.some(a => a.id === action)) throw new Error(`这条通知没有这个操作。可选：${item.actions.map(a => `${a.id}（${a.label}）`).join('、') || '（没有）'}`)
      const actor: Actor = { channel: 'agent', userId: 'main', name: agentName }
      return { result: await notify.act(notice, action, actor) } as never
    },
    presentCall: args => {
      const a = (args ?? {}) as { notice?: unknown; action?: unknown }
      const item = notify.notices().find(n => n.id === a.notice)
      const label = item?.actions.find(x => x.id === a.action)?.label ?? String(a.action ?? '')
      return { card: 'generic', title: `替你选「${label}」：${item?.title ?? String(a.notice ?? '')}`, kind: 'other' }
    },
  }
}
