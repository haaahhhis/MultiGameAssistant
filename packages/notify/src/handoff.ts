/**
 * One agent handing work to another (docs/design/agent-roles.md §10), the way
 * OpenBot's message_bot does: the work goes into the other agent's one
 * conversation as a message saying who asked; when that turn is over, its
 * last reply — or why it did not finish — goes back into the conversation
 * that asked, as a message the asking agent then passes on. Only the messages
 * cross: each side's steps stay in its own conversation, so neither carries
 * the other's tool calls in its context.
 */
import { randomUUID } from 'node:crypto'
import { relayMessage, taskMessage, type HandOff } from '@adg/protocol'
import type { HandOffInput } from './notify.ts'
import { finalText, type Reply } from './reply.ts'

/** 助手's id among the agents (the gateway's MAIN_AGENT). */
export const MAIN = 'main'

/** How long the conversation that asked gets to take in the reply. */
const RELAY_TIMEOUT_MS = 20 * 60_000

export interface HandOffDeps {
  /** The agent's one conversation (the gateway's \`home\`), its focus set. */
  home(agent: string, options?: { focus?: { scripts?: string[]; games?: string[] } }): Promise<string>
  /** A message in a conversation, resolving with the turn it starts (see conversations.ts). */
  converse(sessionId: string, text: string, signal: AbortSignal, images?: readonly Buffer[]): Promise<Reply>
  /** Keep it (the gateway's \`handOffs\`), as it starts and as it ends. */
  record(item: HandOff): Promise<void>
  readonly now?: () => number
}

/** @throws what the turn threw (called off, timed out), after recording it and sending the reply back. */
export async function handOff(deps: HandOffDeps, input: HandOffInput): Promise<Reply> {
  const now = deps.now ?? Date.now
  const toSession = await deps.home(input.to.id, input.focus === undefined ? {} : { focus: input.focus })
  const relay = input.relay === true
  const fromSession = input.from?.sessionId ?? (relay ? await deps.home(MAIN) : '')
  const asked: HandOff = {
    id: input.from?.callId ?? `h-${randomUUID().slice(0, 8)}`, fromSession,
    ...(input.from?.callId === undefined ? {} : { callId: input.from.callId }),
    by: input.by, to: input.to.id, toSession, title: input.title, task: input.task,
    ...(input.expecting === undefined ? {} : { expecting: input.expecting }),
    state: 'running', startedAt: now(),
  }
  await deps.record(asked)
  const body = input.expecting === undefined ? input.task : `${input.task}\n\n要交回的：${input.expecting}`
  let reply: Reply | undefined
  let failure: string | undefined
  let thrown: unknown
  try {
    reply = await deps.converse(toSession, taskMessage(input.by, input.title, body, relay), input.signal, input.images)
    const said = finalText(reply)
    if (reply.ended !== undefined) failure = `${reply.ended.replace(/^（|）$/g, '')}${said === '' ? '' : `。它最后说：${said}`}`
    else if (said === '') failure = '它没有留下回复'
  } catch (error) {
    thrown = error
    failure = error instanceof Error ? error.message : String(error)
  }
  const text = failure ?? finalText(reply!)
  await deps.record({ ...asked, state: failure === undefined ? 'done' : 'failed', reply: text, endedAt: now() })
  if (relay && fromSession !== '') {
    // Not awaited: the asking conversation may be busy, and whoever handed the work on is done with it.
    const message = relayMessage({ agent: input.to.name, asker: input.by === input.from?.asker ? '你' : input.by, title: input.title, ok: failure === undefined, reply: text })
    void deps.converse(fromSession, message, AbortSignal.timeout(RELAY_TIMEOUT_MS)).then(answer => input.relayed?.(answer), () => {})
  }
  if (thrown !== undefined) throw thrown
  return reply!
}
