import { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { AdgClient, ChatItem } from '@adg/client-core'
import { BY_YOU, type HandOff, type RelayNote, type TaskNote, type ThreadMessage, type ThreadNote } from '@adg/protocol'
import { MAIN, agentOf, useLastReplies, useRoles, type Agent } from '../../agents.ts'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { fullTime, needsTime, TimeDivider } from '../../components/TimeDivider.tsx'
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
function useConversation(client: AdgClient, item: HandOff | null): { threads: readonly HandOff[]; ready: boolean } {
  const asker = item?.chain?.at(-2)
  const worker = item?.chain?.at(-1)
  const [others, setOthers] = useState<readonly HandOff[]>([])
  // Whether the rest of the conversation has been asked for and come (or there is none to ask for).
  const [ready, setReady] = useState(false)
  useEffect(() => {
    if (item === null) return
    if (asker === undefined || worker === undefined) { setReady(true); return }
    let live = true
    client.connection.call('handoffs/between', { a: asker, b: worker }).then(
      r => { if (live) { setOthers(r.items); setReady(true) } },
      () => { if (live) setReady(true) },
    )
    return () => { live = false }
  }, [client, asker, worker, item === null])
  useEffect(() => client.connection.on('handoffs/changed', ({ item: changed }) => {
    const from = changed.chain?.at(-2)
    const to = changed.chain?.at(-1)
    if ((from === asker && to === worker) || (from === worker && to === asker)) setOthers(prev => (prev.some(h => h.id === changed.id) ? prev.map(h => (h.id === changed.id ? changed : h)) : [...prev, changed]))
  }), [client, asker, worker])
  if (item === null) return { threads: [], ready: false }
  const all = others.some(h => h.id === item.id) ? others : [...others, item]
  return { threads: [...all].sort((a, b) => a.startedAt - b.startedAt), ready }
}

/** One thing in two agents' chat: something one of them said, the sub-tasks a piece of work opened, or the work still going. */
type Said =
  | { readonly kind: 'said'; readonly key: string; readonly thread: string; readonly at: number; readonly who: string; readonly failed?: boolean; readonly body: React.ReactNode }
  | { readonly kind: 'aside'; readonly key: string; readonly thread: string; readonly at: number; readonly body: React.ReactNode }

/**
 * Everything said on these threads as one chat, in the order it was said:
 * what was handed over, what was said along the way, the conclusion, and what
 * was said after it. Work still going is at the end, where its next message will be.
 */
function chatOf(client: AdgClient, threads: readonly HandOff[], nameOf: (nameOrId: string) => string, onOpen: (task: OpenTask) => void): Said[] {
  const said: Said[] = []
  for (const thread of threads) {
    const by = nameOf(thread.by)
    const to = nameOf(thread.to)
    said.push({
      kind: 'said', key: `${thread.id}:task`, thread: thread.id, at: thread.startedAt, who: by,
      body: <><Markdown text={thread.task} />{thread.expecting !== undefined && <div className="delegation-expecting">要交回：{thread.expecting}</div>}</>,
    })
    said.push({ kind: 'aside', key: `${thread.id}:subtasks`, thread: thread.id, at: thread.startedAt + 1, body: <ThreadSubTasks client={client} session={thread.toSession} from={thread.startedAt} to={thread.endedAt} onOpen={onOpen} /> })
    ;(thread.messages ?? []).forEach((m, i) => {
      // `done` is the conclusion, drawn once below.
      if (m.kind === 'done') return
      said.push({ kind: 'said', key: `${thread.id}:${i}`, thread: thread.id, at: m.at, who: nameOf(m.from), body: <Markdown text={m.text} /> })
    })
    const closed = thread.state !== 'running' && thread.state !== 'waiting'
    if (closed) {
      said.push({
        kind: 'said', key: `${thread.id}:reply`, thread: thread.id, at: thread.endedAt ?? thread.startedAt, who: to, failed: thread.state === 'failed',
        body: <Markdown text={thread.reply ?? (thread.state === 'failed' ? '没有做完' : '它没有留下回复')} />,
      })
    } else {
      said.push({
        kind: 'said', key: `${thread.id}:now`, thread: thread.id, at: Number.MAX_SAFE_INTEGER, who: to,
        body: thread.state === 'waiting'
          ? <div className="delegation-now"><span className="tool-spinner" role="img" aria-label="等回答" /><span>等{by}回答</span></div>
          : <Working client={client} handOff={thread} name={to} />,
      })
    }
  }
  // Stable: what was said at the same moment keeps its order.
  return said.map((s, i) => [s, i] as const).sort(([a, i], [b, j]) => a.at - b.at || i - j).map(([s]) => s)
}

/**
 * Two agents' chat (`#/h/<id>`), over whatever was on screen: all they have
 * said to each other, every piece of work in one conversation, with the one
 * you came from in view. The person watches; the steps are in the agent's
 * conversation. It is a window over the page, so closing it leaves the page
 * as it was (the chat underneath is not opened again).
 */
export function HandOffPage({ client, id, onClose }: { client: AdgClient; id: string; onClose: () => void }) {
  const { item, error } = useHandOff(client, id)
  const [pane, setPane] = useState<OpenTask | null>(null)
  const roles = useRoles(client)
  const { threads, ready } = useConversation(client, item)
  const nameOf = (nameOrId: string) => roles.find(r => r.id === nameOrId)?.name ?? (nameOrId === MAIN.id ? MAIN.name : nameOrId)
  const agentNamed = (name: string): Agent | undefined => {
    const role = roles.find(r => r.name === name || r.id === name)
    return role === undefined ? (name === MAIN.name || name === MAIN.id ? MAIN : undefined) : agentOf(role)
  }
  const said = item === null ? [] : chatOf(client, threads, nameOf, setPane)
  const scroller = useRef<HTMLDivElement>(null)
  // Once, when the piece of work you came from is there to scroll to.
  const scrolled = useRef(false)
  useLayoutEffect(() => {
    const el = scroller.current
    if (scrolled.current || el === null || item === null || !ready) return
    scrolled.current = true
    // Where the piece of work you came from starts; the end when that is already in view.
    const first = el.querySelector<HTMLElement>(`[data-thread="${CSS.escape(item.id)}"]`)
    el.scrollTop = first === null ? el.scrollHeight : el.scrollTop + first.getBoundingClientRect().top - el.getBoundingClientRect().top - 40
  }, [item, threads, ready])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && pane === null) onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose, pane])

  const a = item === null ? undefined : agentNamed(nameOf(item.chain?.at(-2) ?? item.by))
  const b = item === null ? undefined : agentNamed(nameOf(item.chain?.at(-1) ?? item.to))
  const aName = item === null ? '' : a?.name ?? nameOf(item.chain?.at(-2) ?? item.by)
  const bName = item === null ? '' : b?.name ?? nameOf(item.chain?.at(-1) ?? item.to)

  // Runs of one speaker, with a time line after a pause.
  const runs: { key: string; at?: number; who?: string; items: Said[] }[] = []
  let before: number | undefined
  for (const s of said) {
    const at = s.at === Number.MAX_SAFE_INTEGER ? undefined : s.at
    if (at !== undefined && needsTime(at, before)) runs.push({ key: `t:${s.key}`, at, items: [] })
    if (at !== undefined) before = at
    const last = runs.at(-1)
    if (s.kind === 'aside') runs.push({ key: s.key, items: [s] })
    else if (last !== undefined && last.who === s.who && last.items.length > 0) last.items.push(s)
    else runs.push({ key: s.key, who: s.who, items: [s] })
  }

  return (
    <div className="exchange-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <section className={`exchange-window ${pane === null ? '' : 'with-pane'}`} role="dialog" aria-modal="true" aria-label={`${aName} 和 ${bName} 的对话`}>
        <header className="exchange-window-head">
          <div className="exchange-pair">
            <span className={`agent-avatar small agent-${a?.id ?? 'unknown'}`}><Icon name={a?.icon ?? 'calendar'} /></span>
            <span>{aName}</span>
            <Icon name="swap" className="exchange-pair-arrows" />
            <span className={`agent-avatar small agent-${b?.id ?? 'unknown'}`}><Icon name={b?.icon ?? 'sparkles'} /></span>
            <span>{bName}</span>
          </div>
          {item !== null && <span className={`delegation-state tone-${STATE[item.state].tone}`}>{STATE[item.state].tone === 'running' && <span className="tool-spinner" aria-hidden />}{threads.length > 1 ? `${threads.length} 件事 · ` : ''}{STATE[item.state].label}</span>}
          <button className="icon-button exchange-x" onClick={onClose} title="关闭聊天" aria-label="关闭聊天"><Icon name="close" /></button>
        </header>
        <OpenSubTask.Provider value={setPane}>
        <div className={`chat-split ${pane === null ? '' : 'with-pane'}`}>
          <div className="chat exchange-chat" ref={scroller}>
            <div className="chat-inner">
              {item === null && <div className="empty">{error ?? '正在打开…'}</div>}
              {runs.map(run => run.at !== undefined && run.items.length === 0
                ? <TimeDivider key={run.key} at={run.at} />
                : run.who === undefined
                  ? <div key={run.key} className="exchange-aside" data-thread={run.items[0]!.thread}>{run.items[0]!.body}</div>
                  : <ExchangeRun key={run.key} who={run.who} agent={agentNamed(run.who)} items={run.items} />)}
            </div>
          </div>
          {pane !== null && item !== null && <SubAgentPane key={pane.id} client={client} task={pane} parent={nameOf(item.to)} trail={item.by === nameOf(item.to) ? [] : [item.by]} onClose={() => setPane(null)} />}
        </div>
        </OpenSubTask.Provider>
        <footer className="exchange-footer">
          <button className="small-button" onClick={onClose}>关闭聊天</button>
        </footer>
      </section>
    </div>
  )
}

/** What one agent said in a row: its name over the first, its avatar beside the last. */
function ExchangeRun({ who, agent, items }: { who: string; agent: Agent | undefined; items: readonly Said[] }) {
  return (
    <div className="exchange-run">
      <div className="exchange-run-name">{who}</div>
      <div className="exchange-run-body">
        <span className={`agent-avatar small agent-${agent?.id ?? 'unknown'}`}><Icon name={agent?.icon ?? 'calendar'} /></span>
        <div className="exchange-bubbles">
          {items.map(s => (
            <div key={s.key} data-thread={s.thread} className={`exchange-bubble ${s.kind === 'said' && s.failed === true ? 'failed' : ''}`}
              title={s.at === Number.MAX_SAFE_INTEGER ? undefined : fullTime(s.at)}>{s.body}</div>
          ))}
        </div>
      </div>
    </div>
  )
}

const KIND_LABEL: Readonly<Record<ThreadMessage['kind'], string>> = { question: '问', answer: '答', update: '说', done: '结论' }
