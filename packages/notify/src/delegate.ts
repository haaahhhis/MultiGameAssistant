/**
 * `agent_delegate`: the main agent (助手) hands a piece of work to a role
 * agent (docs/design/agent-roles.md §9). The work gets a session of its own
 * under that agent — a task card on its page, marked as 助手's — and the
 * task, as 助手 wrote it, is that session's first message. The call waits for
 * the agent's last reply and returns it, so 助手's conversation shows both
 * sides: what it asked, and what came back. Stopping 助手 stops the work.
 *
 * Only the main agent has the tool: the gateway hides it from role agents
 * (their kept tools do not name it), so work is handed on one level deep.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Conversations } from './notify.ts'
import { finalText } from './reply.ts'

/** Pieces of work one conversation of 助手's may have out at once. */
export const MAX_OUT = 3

/** Who asked, on the task card (requestedBy). */
export const DELEGATOR = '助手'

/** Work an agent takes longer than this on is stopped (and said to have failed). */
const TIMEOUT_MS = 2 * 60 * 60_000

const Args = z.object({
  agent: z.string().trim().min(1).max(40),
  task: z.string().trim().min(1).max(8000),
  expecting: z.string().trim().max(2000).nullish(),
})

export interface DelegateDeps {
  /** The agents work can go to (the gateway's role agents). */
  readonly agents: () => readonly { readonly id: string; readonly name: string }[]
  readonly conversations: () => Conversations | undefined
}

/** The first message of the work's session: the task as 助手 wrote it, and that its last words go back. */
export function delegatedMessage(task: string, expecting?: string | null): string {
  return [`（${DELEGATOR}交给你的事：做完后你最后一段回复会原样交回给${DELEGATOR}。）`, task, expecting ? `要交回的：${expecting}` : ''].filter(p => p !== '').join('\n\n')
}

export function delegateTool(deps: DelegateDeps): ToolDefinition {
  const out = new Map<string, number>()
  return {
    name: 'agent_delegate',
    description: [
      '把一件事交给另一个 agent 去做，等它做完，返回它最后的回复。可以交给谁、各自做什么，见系统提示里的「可以交给的 agent」。',
      'task 要写完整：对方看不到你和用户的对话，只看到 task（要做什么、在哪个游戏或脚本、做到哪一步为止）。expecting 写你要它交回什么（可选）。',
      `几件互不相关的事可以同时交出去，一个对话同时最多 ${MAX_OUT} 件。它要用户审批或回答问题时会停下等用户。`,
      '返回失败说明它没做成：告诉用户没做成、当时请它做什么、你接下来能做什么。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'agent 的名字，例如「游戏」「脚本」。' },
        task: { type: 'string', description: '要它做的事，写完整。' },
        expecting: { type: 'string', description: '要它交回什么，例如「哪些活动今天结束，没有就说没有」（可选）。' },
      },
      required: ['agent', 'task'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: (value as { reply: string }).reply }] },
    timeoutMs: TIMEOUT_MS,
    isConcurrencySafe: () => true,
    execute: async (args, exec) => {
      const parsed = Args.safeParse(args ?? {})
      if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
      const { agent: wanted, task, expecting } = parsed.data
      const parent = exec.agent?.session.id
      if (parent === undefined) throw new Error('只能在会话里交出去')
      const agents = deps.agents()
      const agent = agents.find(a => a.name === wanted || a.id === wanted)
      if (agent === undefined) throw new Error(`没有叫「${wanted}」的 agent。可以交给：${agents.map(a => a.name).join('、') || '（没有）'}`)
      const conversations = deps.conversations()
      if (conversations === undefined) throw new Error('agent 服务还没有准备好')
      if ((out.get(parent) ?? 0) >= MAX_OUT) throw new Error(`这个对话已经有 ${MAX_OUT} 件事在别的 agent 那里，等其中一件回来再交`)
      out.set(parent, (out.get(parent) ?? 0) + 1)
      try {
        const line = task.split('\n').find(l => l.trim() !== '')!.trim()
        const sessionId = await conversations.create(line.length > 30 ? `${line.slice(0, 29)}…` : line, { role: agent.id, by: DELEGATOR, from: { sessionId: parent, callId: String(exec.callId) } })
        const text = delegatedMessage(task, expecting)
        const reply = conversations.converse === undefined ? { blocks: [{ kind: 'text' as const, text: await conversations.ask(sessionId, text, exec.signal) }] } : await conversations.converse(sessionId, text, exec.signal)
        const said = finalText(reply).trim()
        if (reply.ended !== undefined) throw new Error(`「${agent.name}」没有做完（${reply.ended}）。${said === '' ? '' : `它最后说：${said}`}`)
        if (said === '') throw new Error(`「${agent.name}」做完了，但没有留下回复`)
        return { agent: agent.name, sessionId, reply: said } as never
      } finally {
        const left = (out.get(parent) ?? 1) - 1
        if (left > 0) out.set(parent, left)
        else out.delete(parent)
      }
    },
    presentCall: args => {
      const a = (args ?? {}) as { agent?: unknown; task?: unknown }
      return { card: 'generic', title: `交给 ${String(a.agent ?? '')}：${String(a.task ?? '').split('\n')[0]}`, kind: 'other' }
    },
  }
}
