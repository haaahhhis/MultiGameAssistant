/**
 * One agent handing work to another (docs/design/agent-roles.md §10, §14.3):
 * the work goes into the other agent's one conversation as a message saying
 * who asked, and its conclusion, or why it did not finish, goes back into the
 * conversation that asked. Only the messages cross: each side's steps stay in
 * its own conversation, so neither carries the other's tool calls in its context.
 *
 * A hand-off is a thread, not one question and one answer. While the work goes
 * on, either side can ask the other (`message`), and the agent doing it can
 * hand part of it on to a colleague. The thread closes when nobody owes anybody
 * anything: no answer outstanding, no thread opened from inside it still open,
 * and the agent has concluded, by saying `done` or else by its last words.
 *
 * Handing on makes chains, so a chain does not come back on itself (ask in the
 * thread instead), goes only so deep, and has a budget for what is said along it.
 */
import { randomUUID } from 'node:crypto'
import { isQuiet, relayMessage, taskMessage, threadMessage, type HandOff, type ThreadMessage } from '@adg/protocol'
import type { HandOffInput } from './notify.ts'
import { finalText, type Reply } from './reply.ts'

/** 助手's id among the agents (the gateway's MAIN_AGENT). */
export const MAIN = 'main'

/** How long the conversation that asked gets to take in the reply. */
const RELAY_TIMEOUT_MS = 20 * 60_000

/** Messages one thread may carry; then it is time to conclude. */
export const MAX_THREAD_MESSAGES = 10
/** Agents a piece of work may pass through below whoever first asked. */
export const MAX_HOPS = 3
/** What may be said in all along one chain: each costs a turn. */
export const MAX_CHAIN_MESSAGES = 30

export interface HandOffDeps {
  /** The agent's one conversation (the gateway's \`home\`), its focus set. */
  home(agent: string, options?: { focus?: { scripts?: string[]; games?: string[] } }): Promise<string>
  /** A message in a conversation, resolving with the turn it starts (see conversations.ts). */
  converse(sessionId: string, text: string, signal: AbortSignal, images?: readonly Buffer[]): Promise<Reply>
  /** Keep it (the gateway's \`handOffs\`), as it starts and as it ends. */
  record(item: HandOff): Promise<void>
  readonly now?: () => number
}

/** A thread still going. */
interface Live {
  item: HandOff
  readonly input: HandOffInput
  readonly signal: AbortSignal
  readonly root: Live | undefined
  /** Turns of the agent doing the work that belong to this thread, not yet taken in. */
  readonly turns: Promise<Reply>[]
  /** It asked the side that handed it the work, and waits. */
  awaiting: boolean
  /** That side said it needs time (the person has to decide). */
  deferred: boolean
  conclusion: string | undefined
  /** Threads opened from inside this one, still going. */
  open: number
  readonly consulted: Set<string>
  /** Said along the chain this thread is on: kept on the first thread of it. */
  said: number
  wake: () => void
}

export interface ThreadInput {
  readonly thread: string
  /** The conversation it is said from: one of the thread's two. */
  readonly fromSession: string
  /** Its speaker's name. */
  readonly from: string
  readonly kind: ThreadMessage['kind']
  readonly text: string
}

export interface HandOffDesk {
  /** @throws what the turn threw (called off, timed out), after recording it and sending the reply back. */
  handOff(input: HandOffInput): Promise<Reply>
  /** @returns why this work may not be handed on, in words for the agent asking; undefined when it may. */
  refusal(fromSession: string, to: string, fromAgent: string, toName?: string): string | undefined
  /** Say something in a thread. @returns what the speaker is told. @throws why it could not be said. */
  message(input: ThreadInput): Promise<string>
}

export function createHandOffDesk(deps: HandOffDeps): HandOffDesk {
  const now = deps.now ?? Date.now
  const live = new Map<string, Live>()

  /** The thread a conversation's agent is working on now: the latest handed to it. */
  const workingOn = (sessionId: string): Live | undefined => [...live.values()].filter(t => t.item.toSession === sessionId && t.conclusion === undefined).at(-1)
  const chainTop = (thread: Live): Live => thread.root ?? thread

  const save = async (thread: Live, patch: Partial<HandOff>): Promise<void> => {
    thread.item = { ...thread.item, ...patch }
    await deps.record(thread.item)
  }

  const say = async (thread: Live, from: string, kind: ThreadMessage['kind'], text: string, patch: Partial<HandOff> = {}): Promise<void> => {
    chainTop(thread).said++
    await save(thread, { ...patch, messages: [...(thread.item.messages ?? []), { from, kind, text, at: now() }] })
  }

  /** Hand the agent doing the work something to go on with: its turn belongs to the thread. */
  const toWorker = (thread: Live, message: string): void => {
    thread.turns.push(deps.converse(thread.item.toSession, message, thread.signal))
    thread.wake()
  }

  /** The asking side's turn on a question. Its words are the answer unless it answered or said it needs time. */
  const toAsker = (thread: Live, message: string, asked: boolean): void => {
    void deps.converse(thread.item.fromSession, message, AbortSignal.any([thread.signal, AbortSignal.timeout(RELAY_TIMEOUT_MS)])).then(answer => {
      if (!asked || !thread.awaiting || thread.deferred || !live.has(thread.item.id)) return
      const said = finalText(answer).trim()
      void answered(thread, thread.item.by, said === '' || isQuiet(said) ? '（它没有回答：按你自己的判断接着做。）' : said)
    }, () => {
      if (asked && thread.awaiting && live.has(thread.item.id)) void answered(thread, thread.item.by, '（没有等到回答：按你自己的判断接着做。）')
    })
  }

  const answered = async (thread: Live, from: string, text: string): Promise<void> => {
    // In one go: with nothing owed and no turn in hand, the thread would close.
    thread.awaiting = false
    thread.deferred = false
    toWorker(thread, threadMessage({ from, kind: 'answer', thread: thread.item.id, title: thread.item.title, text }))
    await say(thread, from, 'answer', text, { state: 'running' })
  }

  return {
    refusal(fromSession, to, fromAgent, toName = to) {
      const parent = workingOn(fromSession)
      if (parent === undefined) return to === fromAgent ? '不能交给自己' : undefined
      const chain = parent.item.chain ?? []
      if (to === fromAgent) return '不能交给自己'
      if (chain.includes(to)) return `「${toName}」正在等你这条线的结果，再交给它就绕回去了：在线索 ${parent.item.id} 里用 agent_message 直接问它`
      if (chain.length > MAX_HOPS) return `这件事已经转了 ${MAX_HOPS} 手，不能再往下交了：用你手上的信息做完，在结论里说清楚缺什么`
      if (chainTop(parent).said >= MAX_CHAIN_MESSAGES) return `这件事的来回已经够多了（${MAX_CHAIN_MESSAGES} 条）：用你手上的信息做完，在结论里说清楚缺什么`
      return undefined
    },

    async message({ thread: id, fromSession, from, kind, text }) {
      const thread = live.get(id)
      if (thread === undefined) throw new Error(`线索 ${id} 已经结束了，或者没有这条线索。还有事就重新交一次`)
      const worker = fromSession === thread.item.toSession
      if (!worker && fromSession !== thread.item.fromSession) throw new Error(`线索 ${id} 不是你和对方之间的`)
      if (kind !== 'update' && kind !== 'done') {
        if ((thread.item.messages ?? []).length >= MAX_THREAD_MESSAGES) throw new Error(`这条线索的来回已经够多了（${MAX_THREAD_MESSAGES} 条）：用手上的信息做个结论`)
        if (chainTop(thread).said >= MAX_CHAIN_MESSAGES) throw new Error(`这件事的来回已经够多了（${MAX_CHAIN_MESSAGES} 条）：用手上的信息做个结论`)
      }
      const asker = thread.item.by
      switch (kind) {
        case 'done':
          if (!worker) throw new Error('只有做这件事的一方能下结论')
          thread.conclusion = text
          await say(thread, from, 'done', text)
          thread.wake()
          return '结论已经交回去了。这一轮可以结束了。'
        case 'update':
          // Told, not woken: each message that wakes an agent costs a turn.
          if (!worker) thread.deferred = true
          await say(thread, from, 'update', text)
          return worker ? '记下了，对方在线索里看得到。接着做。' : '记下了。有结果后用 kind: answer 回答它。'
        case 'question':
          if (worker) {
            if (thread.item.fromSession === '') throw new Error(`这件事是${asker}交的，没有人等着回答：按你自己的判断做，把要问的写进结论`)
            thread.awaiting = true
            await say(thread, from, 'question', text, { state: 'waiting' })
            toAsker(thread, threadMessage({ from, kind, thread: id, title: thread.item.title, text }), true)
            return `已经问了${asker}。它回答后会作为一条新消息发到这里：现在结束这一轮，不要替它回答。`
          }
          toWorker(thread, threadMessage({ from, kind, thread: id, title: thread.item.title, text }))
          await say(thread, from, 'question', text)
          return `已经问了「${thread.item.to}」。它回答后会作为一条新消息发到这里：现在结束这一轮。`
        case 'answer':
          if (!worker) {
            await answered(thread, from, text)
            return '已经回答了。现在结束这一轮。'
          }
          await say(thread, from, 'answer', text)
          toAsker(thread, threadMessage({ from, kind, thread: id, title: thread.item.title, text }), false)
          return '已经回答了。接着做。'
      }
    },

    async handOff(input) {
      // Before anything is waited for: the thread it is opened from must not close meanwhile.
      const parent = input.from === undefined ? undefined : workingOn(input.from.sessionId)
      if (parent !== undefined) {
        parent.open++
        parent.consulted.add(input.to.name)
      }
      const toSession = await deps.home(input.to.id, input.focus === undefined ? {} : { focus: input.focus })
      const relay = input.relay === true
      const fromSession = input.from?.sessionId ?? (relay ? await deps.home(MAIN) : '')
      const id = input.from?.callId ?? `h-${randomUUID().slice(0, 8)}`
      const chain = [...(parent?.item.chain ?? (input.from?.agent === undefined ? [] : [input.from.agent])), input.to.id]
      const item: HandOff = {
        id, fromSession,
        ...(input.from?.callId === undefined ? {} : { callId: input.from.callId }),
        by: input.by, to: input.to.id, toSession, title: input.title, task: input.task,
        ...(input.expecting === undefined ? {} : { expecting: input.expecting }),
        chain,
        ...(parent === undefined ? {} : { parent: parent.item.id }),
        state: 'running', startedAt: now(),
      }
      const body = input.expecting === undefined ? input.task : `${input.task}\n\n要交回的：${input.expecting}`
      // A thread opened from inside another ends when that one is called off: its time counts against the first asker's.
      const signal = parent === undefined ? input.signal : AbortSignal.any([input.signal, parent.signal])
      let wake = () => {}
      const thread: Live = {
        item, input, signal, root: parent === undefined ? undefined : chainTop(parent),
        turns: [], awaiting: false, deferred: false, conclusion: undefined, open: 0, consulted: new Set(), said: 1,
        wake: () => wake(),
      }
      if (parent !== undefined) chainTop(parent).said++
      live.set(id, thread)
      const stopped = new Promise<never>((_, reject) => {
        if (signal.aborted) reject(signal.reason)
        else signal.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
      stopped.catch(() => {})
      await deps.record(item)
      thread.turns.push(deps.converse(toSession, taskMessage(input.by, input.title, body, relay, id), signal, input.images))

      let reply: Reply | undefined
      let failure: string | undefined
      let thrown: unknown
      try {
        for (;;) {
          while (thread.turns.length > 0) {
            const turn = await thread.turns.shift()!
            // A turn with nothing to say does not take away what was concluded before it.
            if (reply === undefined || finalText(turn) !== '' || turn.ended !== undefined) reply = turn
          }
          if (thread.conclusion !== undefined && thread.open === 0) break
          if (!thread.awaiting && thread.open === 0) break
          await Promise.race([new Promise<void>(resolve => { wake = resolve }), stopped])
        }
        const said = finalText(reply!)
        if (thread.conclusion === undefined) {
          if (reply!.ended !== undefined) failure = `${reply!.ended.replace(/^（|）$/g, '')}${said === '' ? '' : `。它最后说：${said}`}`
          else if (said === '') failure = '它没有留下回复'
        }
      } catch (error) {
        thrown = error
        failure = error instanceof Error ? error.message : String(error)
      }
      live.delete(id)
      const text = failure ?? thread.conclusion ?? finalText(reply!)
      await save(thread, { state: failure === undefined ? 'done' : 'failed', reply: text, endedAt: now() })
      if (relay && fromSession !== '') {
        const message = relayMessage({
          agent: input.to.name, asker: input.by === input.from?.asker ? '你' : input.by, title: input.title, ok: failure === undefined, reply: text,
          ...(thread.consulted.size === 0 ? {} : { consulted: [...thread.consulted] }),
          ...(input.from?.agent === undefined || input.from.agent === MAIN ? {} : { toLead: true }),
        })
        // Not waited for: the asking conversation may be busy, and whoever handed the work on is done with it.
        // Unless the asker is itself working on something: this goes into that.
        const back = deps.converse(fromSession, message, AbortSignal.timeout(RELAY_TIMEOUT_MS))
        if (parent !== undefined && live.has(parent.item.id)) parent.turns.push(back.catch(() => ({ blocks: [] })))
        void back.then(answer => input.relayed?.(answer), () => {})
      }
      if (parent !== undefined) {
        parent.open--
        parent.wake()
      }
      if (thrown !== undefined) throw thrown
      return reply!
    },
  }
}

/** One hand-off on a desk of its own. @see HandOffDesk.handOff */
export function handOff(deps: HandOffDeps, input: HandOffInput): Promise<Reply> {
  return createHandOffDesk(deps).handOff(input)
}
