import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import type { AdgClient, ChatItem } from '@adg/client-core'
import { BY_YOU, type HandOff, type RelayNote, type TaskNote, type ThreadMessage, type ThreadNote } from '@adg/protocol'
import { MAIN, agentOf, useLastReplies, useRoles, type Agent } from '../../agents.ts'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { useStore } from '../../hooks.ts'
import { OpenSubTask, SubAgentPane, ThreadSubTasks, type OpenTask } from './SubTasks.tsx'

/**
 * What agents say to each other (docs/design/agent-roles.md §10, §11). In
 * the conversation that asked, each message between two agents is one line
 * — who to whom, about what, how it stands — and opens the exchange
 * (`#/h/<id>`), where the person can watch but not join in. In the
 * conversation that did the work, the same line for the work it was handed.
 * Only messages cross; the steps stay where they were taken.
 */

/** The main agent's tool for handing work to another agent (packages/notify/src/delegate.ts). */
export const DELEGATE_TOOL = 'agent_delegate'

/** The hand-offs from and to the conversation on screen, for its rows. */
export const HandOffsOf = createContext<readonly HandOff[]>([])

/** The name of the agent whose conversation is on screen: the other end of what it says and is told. */
export const ConversationAgent = createContext<string>(MAIN.name)

export function exchangeHref(handOff: HandOff): string {
  return `#/h/${encodeURIComponent(handOff.id)}`
}

function argsOf(json: string): { agent: string; task: string } {
  try {
    const a = JSON.parse(json) as { agent?: unknown; task?: unknown }
    return { agent: String(a.agent ?? ''), task: String(a.task ?? '') }
  } catch {
    return { agent: '', task: json }
  }
}

function useAgent(client: AdgClient, nameOrId: string): Agent | undefined {
  const roles = useRoles(client)
  const role = roles.find(r => r.name === nameOrId || r.id === nameOrId)
  return role === undefined ? (nameOrId === MAIN.name || nameOrId === MAIN.id ? MAIN : undefined) : agentOf(role)
}

type State = { label: string; tone: string }
const STATE: Readonly<Record<HandOff['state'], State>> = {
  running: { label: '进行中', tone: 'running' },
  waiting: { label: '等回答', tone: 'running' },
  done: { label: '交回了', tone: 'ok' },
  failed: { label: '没做成', tone: 'failed' },
}

/** One message between two agents, as a line that opens their exchange. */
function ExchangeLine({ from, to, avatar, title, state, href }: { from: string; to: string; avatar: Agent | undefined; title: string; state: State | undefined; href: string | undefined }) {
  const body = (
    <>
      <span className={`agent-avatar small agent-${avatar?.id ?? 'unknown'}`}><Icon name={avatar?.icon ?? 'sparkles'} /></span>
      <span className="exchange-who">{from}<Icon name="arrow" className="delegation-arrow" /><strong>{to}</strong></span>
      <span className="exchange-title" title={title}>{title}</span>
      {state !== undefined && <span className={`delegation-state tone-${state.tone}`}>{state.tone === 'running' && <span className="tool-spinner" aria-hidden />}{state.label}</span>}
      {href !== undefined && <Icon name="chevron" className="exchange-open" />}
    </>
  )
  return href === undefined
    ? <div className={`exchange-line tone-${state?.tone ?? ''}`}>{body}</div>
    : <a className={`exchange-line tone-${state?.tone ?? ''}`} href={href} title="看它们说了什么">{body}</a>
}

/** Work this agent handed on (agent_delegate), in its conversation: one line; what was said is a click away. */
export function DelegationCard({ client, item, handOffs }: { client: AdgClient; item: Extract<ChatItem, { kind: 'tool' }>; handOffs: readonly HandOff[] }) {
  const { agent: name, task } = useMemo(() => argsOf(item.arguments), [item.arguments])
  const agent = useAgent(client, name)
  const self = useContext(ConversationAgent)
  const handOff = handOffs.find(h => h.callId === item.callId)
  const refused = item.status === 'error' || item.status === 'interrupted'
  const state = refused ? STATE.failed : handOff === undefined ? (item.status === 'running' ? STATE.running : undefined) : STATE[handOff.state]
  return (
    <div className="delegation">
      <ExchangeLine from={self} to={agent?.name ?? name} avatar={agent} title={handOff?.title ?? task.split('\n')[0] ?? ''} state={state}
        href={handOff === undefined ? undefined : exchangeHref(handOff)} />
      {refused && <div className="delegation-failed"><Icon name="alert" />{item.result ?? item.error ?? '没有交出去'}</div>}
    </div>
  )
}

/** Work the app handed on itself (监控 → 干预, 定时任务) still going: at the end of 助手's conversation until the reply comes. */
export function HandOffStrip({ client, handOff }: { client: AdgClient; handOff: HandOff }) {
  const agent = useAgent(client, handOff.to)
  return (
    <div className="delegation app-handoff">
      <ExchangeLine from={handOff.by} to={agent?.name ?? handOff.to} avatar={agent} title={handOff.title} state={STATE[handOff.state]} href={exchangeHref(handOff)} />
    </div>
  )
}

/** A reply that came back (`（「游戏」交回了…）`): one line from the agent; its words are in the exchange. */
export function RelayMessage({ client, note, handOffs }: { client: AdgClient; note: RelayNote; handOffs: readonly HandOff[] }) {
  const agent = useAgent(client, note.agent)
  const self = useContext(ConversationAgent)
  const handOff = handOffs.filter(h => h.state !== 'running' && h.title === note.title && (h.to === agent?.id || h.to === note.agent)).at(-1)
  const href = handOff !== undefined ? exchangeHref(handOff) : agent !== undefined ? `#/a/${encodeURIComponent(agent.id)}` : undefined
  return (
    <div className="delegation relay-line">
      <ExchangeLine from={note.agent} to={self} avatar={agent} title={note.title} state={note.ok ? STATE.done : { label: '没有做完', tone: 'failed' }} href={href} />
    </div>
  )
}

/** Something said in a thread while the work goes on: a line from whoever said it; the thread opens from it. */
export function ThreadNoteLine({ client, note, handOffs }: { client: AdgClient; note: ThreadNote; handOffs: readonly HandOff[] }) {
  const agent = useAgent(client, note.from)
  const self = useContext(ConversationAgent)
  const handOff = handOffs.find(h => h.id === note.thread)
  return (
    <div className="delegation task-line">
      <ExchangeLine from={note.from} to={self} avatar={agent} title={note.text.split('\n')[0] ?? note.title} state={{ label: KIND_LABEL[note.kind], tone: note.kind === 'question' ? 'asked' : 'ok' }}
        href={handOff === undefined ? undefined : exchangeHref(handOff)} />
    </div>
  )
}

/**
 * Work handed to this agent (`（助手交给你的事：…）`): one line from whoever
 * asked, opening their exchange; without one (a timed task for 助手 itself),
 * the line unfolds what was asked. What you clicked in the app stays your message.
 */
export function TaskMessage({ client, note, handOffs }: { client: AdgClient; note: TaskNote; handOffs: readonly HandOff[] }) {
  const [open, setOpen] = useState(false)
  const handOff = handOffs.filter(h => h.by === note.by && h.title === note.title).at(-1)
  const from = useAgent(client, note.by)
  const to = useAgent(client, handOff?.to ?? '')
  if (note.by === BY_YOU) {
    return (
      <div className="msg user delegated">
        <div className="msg-from">你在软件里点的</div>
        <div className="bubble"><details className="task-note"><summary>{note.title}</summary><div className="task-note-body">{note.body}</div></details></div>
      </div>
    )
  }
  if (handOff !== undefined) {
    return (
      <div className="delegation task-line">
        <ExchangeLine from={note.by} to={to?.name ?? handOff.to} avatar={from} title={note.title} state={STATE[handOff.state]} href={exchangeHref(handOff)} />
      </div>
    )
  }
  return (
    <div className="delegation task-line">
      <button className="exchange-line" onClick={() => setOpen(v => !v)} aria-expanded={open} title={open ? '收起' : '看交给了什么'}>
        <span className={`agent-avatar small agent-${from?.id ?? 'unknown'}`}><Icon name={from?.icon ?? 'calendar'} /></span>
        <span className="exchange-who">{note.by}交给的事</span>
        <span className="exchange-title" title={note.title}>{note.title}</span>
        <Icon name={open ? 'chevron-down' : 'chevron'} className="exchange-open" />
      </button>
      {open && <div className="exchange-msg-body task-unfolded"><Markdown text={note.body} /></div>}
    </div>
  )
}

/** What the agent doing the work has said since: its conversation's last reply, once it is not the one from before. */
function Working({ client, handOff, name }: { client: AdgClient; handOff: HandOff; name: string }) {
  const session = useStore(client.sessions).items.find(s => s.id === handOff.toSession)
  const replies = useLastReplies(client, session === undefined ? [] : [{ id: session.id, updatedAt: session.updatedAt, running: session.running }])
  const now = session === undefined ? undefined : replies.get(session.id)
  const before = useRef<string | null | undefined>(undefined)
  if (before.current === undefined && now !== undefined) before.current = now
  const fresh = now != null && now !== '' && now !== before.current ? now : undefined
  return (
    <div className="delegation-now">
      <span className="tool-spinner" role="img" aria-label="进行中" />
      <span>{session?.running === true ? fresh ?? `${name} 正在做…` : `排在 ${name} 手上的事后面`}</span>
    </div>
  )
}

/** One hand-off (`handoffs/get`), kept current. */
function useHandOff(client: AdgClient, id: string): { item: HandOff | null; error: string | null } {
  const status = useStore(client.connection.status)
  const [state, setState] = useState<{ item: HandOff | null; error: string | null }>({ item: null, error: null })
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('handoffs/get', { id }).then(
      item => { if (live) setState({ item, error: null }) },
      e => { if (live) setState({ item: null, error: e instanceof Error ? e.message : String(e) }) },
    )
    return () => { live = false }
  }, [client, id, status.state])
  useEffect(() => client.connection.on('handoffs/changed', ({ item }) => { if (item.id === id) setState({ item, error: null }) }), [client, id])
  return state
}

/** Everything two agents have said to each other, this thread's among it. Work the app handed on is only itself. */
function useConversation(client: AdgClient, item: HandOff | null): readonly HandOff[] {
  const asker = item?.chain?.at(-2)
  const worker = item?.chain?.at(-1)
  const [others, setOthers] = useState<readonly HandOff[]>([])
  useEffect(() => {
    if (asker === undefined || worker === undefined) return
    let live = true
    client.connection.call('handoffs/between', { a: asker, b: worker }).then(r => { if (live) setOthers(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, asker, worker])
  useEffect(() => client.connection.on('handoffs/changed', ({ item: changed }) => {
    const from = changed.chain?.at(-2)
    const to = changed.chain?.at(-1)
    if ((from === asker && to === worker) || (from === worker && to === asker)) setOthers(prev => (prev.some(h => h.id === changed.id) ? prev.map(h => (h.id === changed.id ? changed : h)) : [...prev, changed]))
  }), [client, asker, worker])
  if (item === null) return []
  return others.some(h => h.id === item.id) ? others : [...others, item]
}

/**
 * Two agents' conversation (`#/h/<id>`): all they have said to each other, each
 * piece of work one stretch of it, with the one you came from in view. The
 * person watches; the work itself, step by step, is in the agent's conversation.
 */
export function HandOffPage({ client, id, onClose }: { client: AdgClient; id: string; onClose: () => void }) {
  const { item, error } = useHandOff(client, id)
  const [pane, setPane] = useState<OpenTask | null>(null)
  const from = useAgent(client, item?.by ?? '')
  const to = useAgent(client, item?.to ?? '')
  const threads = useConversation(client, item)
  const opened = useRef<HTMLDivElement>(null)
  // Once, when the one you came from is there to scroll to.
  const scrolled = useRef(false)
  useEffect(() => {
    if (scrolled.current || threads.length < 2 || opened.current === null) return
    scrolled.current = true
    opened.current.scrollIntoView({ block: 'start' })
  }, [threads.length])
  if (item === null) return <section className="main empty">{error ?? '正在打开…'}</section>
  const toName = to?.name ?? item.to
  const state = STATE[item.state]
  return (
    <section className="main exchange-page">
      <header className="session-header">
        <div className="session-heading">
          <div className="breadcrumb agent-heading">
            <span className={`agent-avatar small agent-${from?.id ?? 'unknown'}`}><Icon name={from?.icon ?? 'calendar'} /></span>
            <span>{item.by}</span>
            <Icon name="arrow" className="delegation-arrow" />
            <span className={`agent-avatar small agent-${to?.id ?? 'unknown'}`}><Icon name={to?.icon ?? 'sparkles'} /></span>
            <h1>{toName}</h1>
          </div>
          <div className="session-meta">
            <span className={`delegation-state tone-${state.tone}`}>{state.label}</span>
            <span>{item.title}</span>
            <span>{new Date(item.startedAt).toLocaleString()}</span>
          </div>
        </div>
      </header>
      <div className="view">
        <OpenSubTask.Provider value={setPane}>
        <div className={`chat-split ${pane === null ? '' : 'with-pane'}`}>
        <div className="chat"><div className="chat-inner">
          {threads.map(thread => (
            <div key={thread.id} ref={thread.id === item.id ? opened : undefined} className={`exchange-thread${threads.length > 1 && thread.id === item.id ? ' opened' : ''}`}>
              {threads.length > 1 && <div className="exchange-thread-head"><span>{thread.title}</span><span>{new Date(thread.startedAt).toLocaleString()}</span></div>}
              <ThreadBlock client={client} thread={thread} onOpen={setPane} />
            </div>
          ))}
        </div></div>
        {pane !== null && <SubAgentPane key={pane.id} client={client} task={pane} parent={toName} trail={item.by === toName ? [] : [item.by]} onClose={() => setPane(null)} />}
        </div>
        </OpenSubTask.Provider>
      </div>
      <footer className="exchange-footer">
        <button className="small-button" onClick={onClose}><Icon name="close" />关闭</button>
      </footer>
    </section>
  )
}

/** One piece of work: what was handed over, what was said, the conclusion, and what was said after it. */
function ThreadBlock({ client, thread, onOpen }: { client: AdgClient; thread: HandOff; onOpen: (task: OpenTask) => void }) {
  const from = useAgent(client, thread.by)
  const to = useAgent(client, thread.to)
  const toName = to?.name ?? thread.to
  const messages = thread.messages ?? []
  const closed = thread.state !== 'running' && thread.state !== 'waiting'
  const later = (m: ThreadMessage) => closed && thread.endedAt !== undefined && m.at > thread.endedAt
  return (
    <>
      <ExchangeMessage who={thread.by} agent={from}>
        <Markdown text={thread.task} />
        {thread.expecting !== undefined && <div className="delegation-expecting">要交回：{thread.expecting}</div>}
      </ExchangeMessage>
      {messages.filter(m => !later(m)).map((m, i) => <ThreadLine key={i} client={client} message={m} />)}
      <ThreadSubTasks client={client} session={thread.toSession} from={thread.startedAt} to={thread.endedAt} onOpen={onOpen} />
      {closed
        ? <ExchangeMessage who={toName} agent={to} failed={thread.state === 'failed'}><Markdown text={thread.reply ?? (thread.state === 'failed' ? '没有做完' : '它没有留下回复')} /></ExchangeMessage>
        : <ExchangeMessage who={toName} agent={to}>{thread.state === 'waiting' ? <div className="delegation-now"><span className="tool-spinner" role="img" aria-label="等回答" /><span>等{thread.by}回答</span></div> : <Working client={client} handOff={thread} name={toName} />}</ExchangeMessage>}
      {messages.filter(later).map((m, i) => <ThreadLine key={i} client={client} message={m} />)}
    </>
  )
}

const KIND_LABEL: Readonly<Record<ThreadMessage['kind'], string>> = { question: '问', answer: '答', update: '说', done: '结论' }

/** One thing said in the thread (`done` repeats as the conclusion below, so it is not drawn twice). */
function ThreadLine({ client, message }: { client: AdgClient; message: ThreadMessage }) {
  const agent = useAgent(client, message.from)
  if (message.kind === 'done') return null
  return <ExchangeMessage who={`${message.from} · ${KIND_LABEL[message.kind]}`} agent={agent}><Markdown text={message.text} /></ExchangeMessage>
}

function ExchangeMessage({ who, agent, failed = false, children }: { who: string; agent: Agent | undefined; failed?: boolean; children: React.ReactNode }) {
  return (
    <div className={`exchange-msg ${failed ? 'failed' : ''}`}>
      <div className="exchange-msg-head">
        <span className={`agent-avatar small agent-${agent?.id ?? 'unknown'}`}><Icon name={agent?.icon ?? 'calendar'} /></span>
        <strong>{who}</strong>
      </div>
      <div className="exchange-msg-body">{children}</div>
    </div>
  )
}
