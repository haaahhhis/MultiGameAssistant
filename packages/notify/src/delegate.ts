/**
 * `agent_delegate`: the main agent (助手) hands a piece of work to a role
 * agent (docs/design/agent-roles.md §10). The work goes into that agent's one
 * conversation as a message — the task as 助手 wrote it, saying 助手 asked —
 * and the call returns at once: 助手 tells the person who it asked and ends
 * its turn, so the person can go on talking to it. When the agent is done,
 * its last reply comes back into 助手's conversation as a message, and 助手
 * passes on what matters. Only the messages cross: neither sees the other's
 * steps.
 *
 * Only the main agent has the tool: the gateway hides it from role agents
 * (their kept tools do not name it), so work is handed on one level deep.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { Conversations } from './notify.ts'
import type { Reply } from './reply.ts'

/** Pieces of work one conversation of 助手's may have out at once. */
export const MAX_OUT = 3

/** Who asks, as the agent handed the work reads it. */
export const DELEGATOR = '助手'

/** Work an agent takes longer than this on is stopped (and said to have failed). */
const TIMEOUT_MS = 2 * 60 * 60_000

/** What 助手 is told once the work is out: the shape OpenBot's message_bot found keeps a model from answering for the other. */
export const HANDED = (agent: string) => `已交给「${agent}」。它在自己的对话里做，做完后它的回复会作为一条新消息发到这个对话里。现在用一句话告诉用户你交给了谁、做什么，然后结束这一轮：不要等它，也不要替它回答。`

const Args = z.object({
  agent: z.string().trim().min(1).max(40),
  task: z.string().trim().min(1).max(8000),
  expecting: z.string().trim().max(2000).nullish(),
})

export interface DelegateDeps {
  /** The agents work can go to (the gateway's role agents). */
  readonly agents: () => readonly { readonly id: string; readonly name: string }[]
  readonly conversations: () => Conversations | undefined
  /** Where 助手's turn on the reply goes besides its conversation: the chat person whose message it is answering now. */
  readonly relayed?: (sessionId: string) => ((reply: Reply) => void) | undefined
}

export function delegateTool(deps: DelegateDeps): ToolDefinition {
  const out = new Map<string, number>()
  const settle = (parent: string) => {
    const left = (out.get(parent) ?? 1) - 1
    if (left > 0) out.set(parent, left)
    else out.delete(parent)
  }
  return {
    name: 'agent_delegate',
    description: [
      '把一件事交给另一个 agent 去做。可以交给谁、各自做什么，见系统提示里的「可以交给的 agent」。',
      '交出去就返回，不等它做完：它在自己的对话里做，做完后它的回复会作为一条新消息发到这个对话里。',
      'task 要写完整：对方看不到你和用户的对话，只看到 task（要做什么、在哪个游戏或脚本、做到哪一步为止）。expecting 写你要它交回什么（可选）。',
      `几件互不相关的事可以同时交出去，一个对话同时最多 ${MAX_OUT} 件。它要用户审批或回答问题时会停下等用户。`,
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
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: HANDED((value as { agent: string }).agent) }] },
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
      const line = task.split('\n').find(l => l.trim() !== '')!.trim()
      const callId = String(exec.callId)
      const relayed = deps.relayed?.(parent)
      // Not awaited: the reply comes back as a message (handOff's relay). Stopping 助手's turn does not stop it.
      void conversations.handOff({
        to: agent, by: DELEGATOR, title: line.length > 30 ? `${line.slice(0, 29)}…` : line, task,
        ...(expecting ? { expecting } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        from: { sessionId: parent, callId, asker: DELEGATOR },
        relay: true,
        ...(relayed === undefined ? {} : { relayed }),
      }).catch(() => {}).finally(() => settle(parent))
      return { agent: agent.name, id: callId } as never
    },
    presentCall: args => {
      const a = (args ?? {}) as { agent?: unknown; task?: unknown }
      return { card: 'generic', title: `交给 ${String(a.agent ?? '')}：${String(a.task ?? '').split('\n')[0]}`, kind: 'other' }
    },
  }
}
