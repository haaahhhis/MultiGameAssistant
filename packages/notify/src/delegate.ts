/**
 * The tools agents work together with (docs/design/agent-roles.md §10, §14.3).
 *
 * `agent_delegate`: hand a piece of work to another agent. It goes into that
 * agent's one conversation as a message, the task as written, saying who
 * asked, and the call returns at once: the caller says who it asked and ends
 * its turn. When the agent is done, its conclusion comes back into the caller's
 * conversation as a message. Only the messages cross: neither sees the other's
 * steps. 助手 hands out what the person asks for; a lead agent can also ask a
 * colleague directly.
 *
 * `agent_message`: say something in a thread that is going on, so a hand-off is
 * more than one question and one answer.
 *
 * `agent_threads`: what is going on or went on between agents, for 助手, which
 * is not woken for what two lead agents say to each other.
 *
 * Sub-agents have none of these: the gateway hides them.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type { HandOff } from '@adg/protocol'
import { z } from 'zod'
import { type HandOffDesk } from './handoff.ts'
import type { Conversations } from './notify.ts'
import type { Reply } from './reply.ts'

/** Pieces of work one conversation may have out at once. */
export const MAX_OUT = 3

/** Who asks, when the asking agent cannot be told (a client without the gateway). */
export const DELEGATOR = '助手'

/** Work an agent takes longer than this on is stopped (and said to have failed). */
const TIMEOUT_MS = 2 * 60 * 60_000

/** What the caller is told once the work is out: the shape OpenBot's message_bot found keeps a model from answering for the other. */
export const HANDED = (agent: string) => `已交给「${agent}」。它在自己的对话里做，做完后它的回复会作为一条新消息发到这个对话里。现在用一句话说你交给了谁、做什么，然后结束这一轮：不要等它，也不要替它回答。`

const Args = z.object({
  agent: z.string().trim().min(1).max(40),
  task: z.string().trim().min(1).max(8000),
  expecting: z.string().trim().max(2000).nullish(),
})

/** An agent as the tools address it. */
export interface AgentRef {
  readonly id: string
  readonly name: string
}

export interface DelegateDeps {
  /** The agents work can go to (the gateway's role agents, and 助手 for them). */
  readonly agents: () => readonly AgentRef[]
  readonly conversations: () => Conversations | undefined
  /** The agent working in a conversation. Absent or unknown: 助手. */
  readonly agentOf?: (sessionId: string) => AgentRef | undefined
  /** Where the caller's turn on the reply goes besides its conversation: the chat person whose message it is answering now. */
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
      '把一件事交给另一个 agent 去做。可以交给谁、各自做什么，见系统提示里的「团队」。',
      '交出去就返回，不等它做完：它在自己的对话里做，做完后它的回复会作为一条新消息发到这个对话里。',
      'task 要写完整：对方看不到你的对话，只看到 task（要做什么、在哪个游戏或脚本、做到哪一步为止）。expecting 写你要它交回什么（可选）。',
      `几件互不相关的事可以同时交出去，一个对话同时最多 ${MAX_OUT} 件。它要用户审批或回答问题时会停下等用户。`,
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        agent: { type: 'string', description: 'agent 的名字或 id，例如「游戏」「脚本」。' },
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
      const caller = deps.agentOf?.(parent)
      const agents = deps.agents().filter(a => a.id !== caller?.id)
      const agent = agents.find(a => a.name === wanted || a.id === wanted)
      if (agent === undefined) throw new Error(`没有叫「${wanted}」的 agent。可以交给：${agents.map(a => a.name).join('、') || '（没有）'}`)
      const conversations = deps.conversations()
      if (conversations === undefined) throw new Error('agent 服务还没有准备好')
      if ((out.get(parent) ?? 0) >= MAX_OUT) throw new Error(`这个对话已经有 ${MAX_OUT} 件事在别的 agent 那里，等其中一件回来再交`)
      const refusal = conversations.handOffRefusal?.(parent, agent.id, caller?.id ?? '')
      if (refusal !== undefined) throw new Error(refusal)
      out.set(parent, (out.get(parent) ?? 0) + 1)
      const line = task.split('\n').find(l => l.trim() !== '')!.trim()
      const callId = String(exec.callId)
      const relayed = deps.relayed?.(parent)
      const by = caller?.name ?? DELEGATOR
      // Not awaited: the reply comes back as a message (handOff's relay). Stopping the caller's turn does not stop it.
      void conversations.handOff({
        to: agent, by, title: line.length > 30 ? `${line.slice(0, 29)}…` : line, task,
        ...(expecting ? { expecting } : {}),
        signal: AbortSignal.timeout(TIMEOUT_MS),
        from: { sessionId: parent, callId, asker: by, ...(caller === undefined ? {} : { agent: caller.id }) },
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

const MessageArgs = z.object({
  thread: z.string().trim().min(1),
  kind: z.enum(['question', 'answer', 'update', 'done']),
  text: z.string().trim().min(1).max(8000),
})

/** `agent_message`: say something in a thread that is going on. */
export function messageTool(deps: { desk: () => HandOffDesk | undefined; agentOf: (sessionId: string) => AgentRef | undefined }): ToolDefinition {
  return {
    name: 'agent_message',
    description: [
      '在一条线索里和对方说话。线索的 id 写在交给你的事开头，或者对方发来的消息开头。',
      'kind：question 问对方（对方回答后会作为新消息发到这里，所以问完就结束这一轮，不要猜答案）；answer 回答对方；update 说一声进展，对方不会被叫醒；done 交回结论，这件事到此结束。',
      '不用 done 也可以：你这一轮的最后一段回复就是结论。要问的问清楚再做，比做错了再改省事。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        thread: { type: 'string', description: '线索的 id。' },
        kind: { type: 'string', enum: ['question', 'answer', 'update', 'done'], description: '这句话是什么。' },
        text: { type: 'string', description: '要说的话，写完整：对方看不到你的对话。' },
      },
      required: ['thread', 'kind', 'text'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: String(value) }] },
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const parsed = MessageArgs.safeParse(args ?? {})
      if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
      const fromSession = exec.agent?.session.id
      if (fromSession === undefined) throw new Error('只能在会话里说')
      const desk = deps.desk()
      if (desk === undefined) throw new Error('agent 服务还没有准备好')
      return await desk.message({ ...parsed.data, fromSession, from: deps.agentOf(fromSession)?.name ?? DELEGATOR }) as never
    },
    presentCall: args => {
      const a = (args ?? {}) as { kind?: unknown; text?: unknown }
      return { card: 'generic', title: `${String(a.kind ?? '')}：${String(a.text ?? '').split('\n')[0]}`, kind: 'other' }
    },
  }
}

const ThreadsArgs = z.object({ id: z.string().trim().min(1).nullish() })

/** `agent_threads`: what agents have been saying to each other. */
export function threadsTool(deps: { list: () => readonly HandOff[]; name: (agentId: string) => string }): ToolDefinition {
  const line = (h: HandOff) => `${h.id} [${h.state}] ${h.by} → ${deps.name(h.to)}：${h.title}${h.reply === undefined ? '' : `｜${h.reply.replace(/\s+/g, ' ').slice(0, 120)}`}`
  return {
    name: 'agent_threads',
    description: '看 agent 之间的线索：不带 id 列出最近的（谁交给谁、什么事、做到哪了、结论的开头）；带 id 看一条的完整往来。主 agent 之间直接说的话不会叫醒你，要知道就用这个。',
    parameters: {
      type: 'object',
      properties: { id: { type: 'string', description: '线索的 id（可选）。' } },
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: String(value) }] },
    isConcurrencySafe: () => true,
    execute: async args => {
      const parsed = ThreadsArgs.safeParse(args ?? {})
      if (!parsed.success) throw new Error('参数无效')
      const all = deps.list()
      if (parsed.data.id == null) return (all.slice(-20).reverse().map(line).join('\n') || '（还没有线索）') as never
      const found = all.find(h => h.id === parsed.data.id)
      if (found === undefined) throw new Error(`没有线索 ${parsed.data.id}`)
      return [
        line(found),
        `交的事：${found.task}`,
        ...(found.messages ?? []).map(m => `${m.from}（${m.kind}）：${m.text}`),
        ...(found.reply === undefined ? [] : [`结论：${found.reply}`]),
      ].join('\n') as never
    },
  }
}
