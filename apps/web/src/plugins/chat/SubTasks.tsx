import { createContext, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { buildChat, type AdgClient, type ChatItem } from '@adg/client-core'
import { summarizeToolArgs, type SessionEvent, type SessionItem } from '@adg/protocol'
import { useLastReplies } from '../../agents.ts'
import { ReportStatus, reportToolActivity } from './ReportStatus.tsx'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useSessionHandle, useStore } from '../../hooks.ts'
import { ChatView } from './ChatView.tsx'
import { ConversationAgent } from './Delegation.tsx'

/**
 * The third layer of what agents say (docs/design/agent-roles.md §14.5): a
 * sub-agent and the agent that opened it. Its steps are not in the parent's
 * conversation at all, so a card in the parent's turn is where they show: what
 * it was given, its steps while it works, then its answer. The whole of it
 * opens beside the conversation. On screen it is a 子任务: part of the work,
 * being done on its own.
 */

/** dsh's tool that starts a sub-agent. */
export const SUBAGENT_TOOL = 'subagent'

/** How a tool result names the child (dsh-tool-subagent's start result): its session id before dsh 0.2.2, its name (agent-1) since. */
const STARTED = /started subagent (\S+)/

/**
 * The session id of each sub-agent a conversation opened, by the name dsh
 * gives it in the conversation (agent-1), from dsh's catalog of them. Before
 * dsh 0.2.2 the conversation said the id itself, and that is not in here.
 */
export function subAgentIds(events: readonly SessionEvent[]): ReadonlyMap<string, string> {
  const ids = new Map<string, string>()
  for (const event of events) {
    if (event.type !== 'unknown' || event.upstreamType !== 'subagent/catalog') continue
    const data = event.data as { childId?: unknown; name?: unknown } | null
    if (typeof data?.childId === 'string' && typeof data.name === 'string') ids.set(data.name, data.childId)
  }
  return ids
}

/** Names of a conversation's sub-agents to their session ids (subAgentIds). */
export const SubAgentIds = createContext<ReadonlyMap<string, string>>(new Map())

/** The session id of the sub-agent a start result or notice names. */
const childId = (named: string | undefined, ids: ReadonlyMap<string, string>) => (named === undefined ? undefined : ids.get(named) ?? named)

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/**
 * What dsh adds to a sub-agent's first message, for the sub-agent: not what it was given to do.
 * "Your parent agent…" before dsh 0.2.2, "Your final answer is delivered automatically…" since (cut short in a title).
 */
const PARENT_NOTE = /\s*Your (?:parent agent\b|final answe)[\s\S]*$/

export function taskWords(text: string): string {
  return text.replace(PARENT_NOTE, '')
}

/** dsh's words when a sub-agent ended (settlementSummary), read for how it ended. */
const SETTLED = /^Background subagent (\S+) (finished|was stopped)?/

/** How the sub-agents of a conversation ended, from the notices it was sent; those are not drawn, the card says it. */
export function settledTasks(items: readonly ChatItem[], ids: ReadonlyMap<string, string>, events: readonly SessionEvent[] = []): ReadonlyMap<string, TaskState> {
  const ended = new Map<string, TaskState>()
  for (const item of items) {
    if (!isSettlement(item)) continue
    const match = SETTLED.exec(item.summary)
    if (match === null) continue
    ended.set(childId(match[1], ids)!, match[2] === 'finished' ? DONE : match[2] === 'was stopped' ? STOPPED : FAILED)
  }
  // Native settlements can already be in the inbox while the parent's next turn is queued.
  for (const event of events) {
    if (event.type !== 'unknown' || event.upstreamType !== 'agent/inbox/spliced') continue
    const data = event.data as { inserted?: { source?: { kind?: string; senderSessionId?: string; stopReason?: string } }[] } | null
    for (const entry of data?.inserted ?? []) {
      const source = entry.source
      if (source?.kind !== 'subagent-settled' || !source.senderSessionId || !source.stopReason) continue
      const state = source.stopReason === 'completed' ? DONE : ['aborted', 'interrupted'].includes(source.stopReason) ? STOPPED : FAILED
      ended.set(source.senderSessionId, { ...state, at: event.time })
    }
  }
  return ended
}

export function isSettlement(item: ChatItem): item is Extract<ChatItem, { kind: 'context' }> {
  return item.kind === 'context' && item.title === 'subagent-settled'
}

export const SettledTasks = createContext<ReadonlyMap<string, TaskState>>(new Map())

/** Whose sub-agent's conversation this is; null: an agent's own. */
export const SubAgentOf = createContext<string | null>(null)

/** Open a sub-task beside the conversation. */
export const OpenSubTask = createContext<(task: OpenTask) => void>(() => {})

export interface OpenTask {
  readonly id: string
  readonly label: string
}

/** Compact lifecycle of a native child in the report, including while its parent is idle. */
export function ReportSubTask({ client, work }: { client: AdgClient; work: ToolItem | OpenTask }) {
  const ids = useContext(SubAgentIds)
  const settled = useContext(SettledTasks)
  const open = useContext(OpenSubTask)
  const call = 'kind' in work ? work : undefined
  const named = call && STARTED.exec(call.result ?? '')?.[1]
  const id = 'kind' in work ? childId(named, ids) : work.id
  const args = call && argsOf(call.arguments)
  const label = 'label' in work ? work.label : args?.description || args?.prompt.split('\n')[0] || '子任务'
  const child = useChild(client, id)
  const approval = useStore(client.approvals).some(r => r.sessionId === id)
  const question = useStore(client.questions).some(r => r.sessionId === id)
  const end = id && settled.get(id)
  const show = id ? () => open({ id, label }) : undefined
  if (call?.status === 'error') return <ReportStatus label={label} status="派发失败" tone="failed" onOpen={show} />
  if (call?.status === 'interrupted') return <ReportStatus label={label} status="派发已中断" tone="neutral" onOpen={show} />
  if (end && (!child?.running || (end.at !== undefined && child.updatedAt <= end.at))) {
    return <ReportStatus label={label} status={end.tone === 'ok' ? '子任务已完成' : end.label} tone={end.label === FAILED.label ? 'failed' : 'neutral'} onOpen={show} />
  }
  if (approval || question) return <ReportStatus label={label} status={approval ? '等待你批准操作' : '等待你回答问题'} tone="waiting" onOpen={show} />
  if (child?.running) return <Steps client={client} id={child.id} running report={{ label, open: () => open({ id: child.id, label }) }} />
  return <ReportStatus label={label} status={id || call?.status === 'ok' ? '已派发' : '正在派发子任务'} onOpen={show} />
}

function argsOf(json: string): { description: string; prompt: string } {
  try {
    const a = JSON.parse(json) as { description?: unknown; prompt?: unknown }
    return { description: String(a.description ?? ''), prompt: String(a.prompt ?? '') }
  } catch {
    return { description: '', prompt: json }
  }
}

function useChild(client: AdgClient, id: string | undefined): SessionItem | undefined {
  return useStore(client.sessions).items.find(i => i.id === id) as SessionItem | undefined
}

export type TaskState = { label: string; tone: string; at?: number }
const RUNNING: TaskState = { label: '进行中', tone: 'running' }
const DONE: TaskState = { label: '完成', tone: 'ok' }
const STOPPED: TaskState = { label: '已停止', tone: 'failed' }
const FAILED: TaskState = { label: '没做成', tone: 'failed' }

/** A sub-task's steps, read from its own conversation, only while on screen. */
interface StepReport { label: string; open: () => void }

function Steps({ client, id, running, report }: { client: AdgClient; id: string; running: boolean; report?: StepReport }) {
  const handle = useSessionHandle(client, id)
  if (handle) return <OpenSteps handle={handle} running={running} report={report} />
  return report ? <ReportStatus label={report.label} status="子任务执行中" onOpen={report.open} /> : <div className="subtask-steps muted small">正在打开…</div>
}

function OpenSteps({ handle, running, report }: { handle: NonNullable<ReturnType<typeof useSessionHandle>>; running: boolean; report?: StepReport | undefined }) {
  const state = useStore(handle.state)
  const tools = useMemo(() => buildChat(state.events, state.live, state.pending).filter((i): i is ToolItem => i.kind === 'tool'), [state.events, state.live, state.pending, state.version])
  if (report) {
    const start = state.events.findLast(e => e.type === 'turn/start')
    const active = tools.findLast(t => t.status === 'running' && t.time >= (start?.time ?? 0))
    const action = active && reportToolActivity(active)
    return <ReportStatus label={report.label} status={action && action !== report.label ? action : '子任务执行中'} onOpen={report.open} />
  }
  if (tools.length === 0) return <div className="subtask-steps muted small">{running ? '正在开始…' : '没有用工具'}</div>
  // While it works, where it has got to; the rest is in the whole conversation.
  const shown = running ? tools.slice(-4) : tools
  return (
    <ol className="subtask-steps">
      {shown.map(tool => (
        <li key={tool.id} className={tool.status === 'error' ? 'failed' : ''}>
          {tool.status === 'running' ? <span className="tool-spinner" aria-hidden /> : <Icon name={tool.status === 'error' ? 'alert' : 'check'} />}
          <span className="subtask-step-name">{tool.name}</span>
          <span className="subtask-step-args">{summarizeToolArgs(tool.arguments)}</span>
        </li>
      ))}
    </ol>
  )
}

/** A sub-agent an agent opened, in that agent's turn: with its steps and answer. */
export function SubTaskCard({ client, item }: { client: AdgClient; item: ToolItem }) {
  const open = useContext(OpenSubTask)
  const { description, prompt } = useMemo(() => argsOf(item.arguments), [item.arguments])
  const id = childId(STARTED.exec(item.result ?? '')?.[1], useContext(SubAgentIds))
  const child = useChild(client, id)
  const refused = item.status === 'error' || item.status === 'interrupted'
  const running = !refused && (child?.running ?? item.status === 'running')
  const ended = useContext(SettledTasks)
  const state = refused ? FAILED : running ? RUNNING : (id === undefined ? undefined : ended.get(id)) ?? DONE
  const replies = useLastReplies(client, child === undefined ? [] : [{ id: child.id, updatedAt: child.updatedAt, running: child.running }])
  const answer = id === undefined ? undefined : replies.get(id)
  const [expanded, setExpanded] = useState(false)
  const label = description !== '' ? description : (prompt.split('\n')[0] ?? '子任务')
  const badge = <span className={`delegation-state tone-${state.tone}`}>{state.tone === 'running' && <span className="tool-spinner" aria-hidden />}{state.label}</span>

  const showSteps = id !== undefined && (running || expanded)
  return (
    <div className={`subtask tone-${state.tone}`}>
      <div className="subtask-head">
        <Icon name="flow" />
        <strong className="subtask-label" title={prompt}>{label}</strong>
        {badge}
        {id !== undefined && <button className="link-button subtask-open" onClick={() => open({ id, label })}>看完整过程</button>}
      </div>
      {refused && <div className="delegation-failed"><Icon name="alert" />{item.result ?? item.error ?? '没有开起来'}</div>}
      {showSteps && <Steps client={client} id={id} running={running} />}
      {!running && answer != null && answer !== '' && <div className="subtask-answer"><Markdown text={answer} /></div>}
      {!running && id !== undefined && (
        <button className="link-button subtask-fold" aria-expanded={expanded} onClick={() => setExpanded(v => !v)}>
          <Icon name={expanded ? 'chevron-down' : 'chevron'} />{expanded ? '收起步骤' : '看步骤'}
        </button>
      )}
    </div>
  )
}

/** A sub-task's whole conversation, beside its parent's: read-only, and it can be stopped. */
export function SubAgentPane({ client, task, parent, trail, onClose }: { client: AdgClient; task: OpenTask; parent: string; trail: readonly string[]; onClose: () => void }) {
  const handle = useSessionHandle(client, task.id)
  const child = useChild(client, task.id)
  const [error, setError] = useState<string | null>(null)
  const running = child?.running === true
  const stop = () => client.connection.call('subagents/stop', { sessionId: task.id }).then(() => setError(null), e => setError(e instanceof Error ? e.message : String(e)))
  return (
    <aside className="subagent-pane" aria-label={`子任务：${task.label}`}>
      <header className="subagent-pane-head">
        <div className="subagent-trail">
          {[...trail, parent].map((name, i) => <span key={i}>{name}<span className="subagent-trail-sep">›</span></span>)}
          <strong title={task.label}>{task.label}</strong>
        </div>
        {running && <button className="small-button" onClick={() => void stop()}><Icon name="close" />停止</button>}
        <button className="icon-button" aria-label="关闭" title="关闭" onClick={onClose}><Icon name="close" /></button>
      </header>
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
      <div className="subagent-pane-body">
        {handle === null ? <div className="empty">正在打开…</div> : <PaneChat client={client} handle={handle} parent={parent} />}
      </div>
    </aside>
  )
}

function PaneChat({ client, handle, parent }: { client: AdgClient; handle: NonNullable<ReturnType<typeof useSessionHandle>>; parent: string }) {
  const state = useStore(handle.state)
  return (
    <SubAgentOf.Provider value={parent}>
      <ConversationAgent.Provider value={`${parent}的子 agent`}>
        <ChatView client={client} session={handle} state={state} readOnly />
      </ConversationAgent.Provider>
    </SubAgentOf.Provider>
  )
}

/**
 * How much of what agents say a conversation shows (docs/design/agent-roles.md
 * §14.5): 汇报 (1) is what the agent says to you, 全部 (3) everything, sub-tasks
 * with their steps and answers. It only filters what is already loaded, and is
 * kept per agent, in this browser. (2, 协作, sub-tasks as one line each, is gone:
 * a level saved as it reads as 全部.)
 */
export type ChatDetail = 1 | 3

const DETAIL_KEY = 'adg.chatDetail.'

export function useChatDetail(agentId: string): [ChatDetail, (detail: ChatDetail) => void] {
  const read = (): ChatDetail => {
    try {
      return Number(localStorage.getItem(DETAIL_KEY + agentId)) === 1 ? 1 : 3
    } catch {
      return 3
    }
  }
  // Read while rendering, not after: another agent's level is right in the first frame.
  const [chosen, setChosen] = useState<{ agentId: string; detail: ChatDetail }>(() => ({ agentId, detail: read() }))
  const detail = chosen.agentId === agentId ? chosen.detail : read()
  return [detail, next => {
    setChosen({ agentId, detail: next })
    try { localStorage.setItem(DETAIL_KEY + agentId, String(next)) } catch { /* private mode: lasts until reload */ }
  }]
}

const LEVELS: readonly { level: ChatDetail; label: string; hint: string }[] = [
  { level: 1, label: '汇报', hint: '只看它和你说的话' },
  { level: 3, label: '全部', hint: '加上 agent 之间的往来和子任务的步骤、答案' },
]

export function DetailSwitch({ detail, onChange }: { detail: ChatDetail; onChange: (detail: ChatDetail) => void }) {
  return (
    <div className="chat-detail segmented-control" role="radiogroup" aria-label="显示多少">
      {LEVELS.map(l => (
        <button key={l.level} role="radio" aria-checked={detail === l.level} className={detail === l.level ? 'active' : ''} title={l.hint} onClick={() => onChange(l.level)}>{l.label}</button>
      ))}
    </div>
  )
}

/** What each sub-agent opened in a conversation was given to do, by its id (the card's words). */
export function taskLabels(items: readonly ChatItem[], ids: ReadonlyMap<string, string>): ReadonlyMap<string, string> {
  const labels = new Map<string, string>()
  for (const item of items) {
    if (item.kind === 'context' && 'childId' in item && typeof item.childId === 'string') labels.set(item.childId, item.summary)
    if (item.kind !== 'tool' || item.name !== SUBAGENT_TOOL) continue
    const id = childId(STARTED.exec(item.result ?? '')?.[1], ids)
    if (id === undefined) continue
    const { description, prompt } = argsOf(item.arguments)
    const label = description !== '' ? description : (prompt.split('\n')[0] ?? '')
    if (label !== '') labels.set(id, label)
  }
  return labels
}

/** The sub-agents a conversation opened. */
export function useSubAgents(client: AdgClient, parent: string): SessionItem[] {
  const items = useStore(client.sessions).items
  return useMemo(() => items.filter(i => i.origin === 'subagent' && i.parentId === parent), [items, parent])
}

/** A thread's sub-agents: its agent's opened while the thread was open (a thread ends only once its sub-agents have). */
function inThread(item: SessionItem, session: string, from: number, to: number | undefined): boolean {
  return item.origin === 'subagent' && item.parentId === session && item.updatedAt >= from && (to === undefined || item.updatedAt <= to + 2_000)
}

/** The sub-agents opened on these threads (two agents' conversation). */
export function useThreadSubAgents(client: AdgClient, threads: readonly { toSession: string; startedAt: number; endedAt?: number | undefined }[]): SessionItem[] {
  const items = useStore(client.sessions).items
  return useMemo(() => items.filter(i => threads.some(t => inThread(i, t.toSession, t.startedAt, t.endedAt))), [items, threads])
}

/** Ended sub-tasks the list shows, latest first; the rest are in the conversation. */
const ENDED_SHOWN = 30

/**
 * How many sub-tasks are going and how many have ended, at the top of a
 * conversation; it opens to the list of them, 进行中 and 已结束 apart, and
 * each opens its window beside the conversation.
 */
export function SubTaskTracker({ tasks, labels, current, onOpen }: {
  tasks: readonly SessionItem[]
  /** What each was given to do, where the conversation says. */
  labels: ReadonlyMap<string, string>
  /** The one open beside the conversation. */
  current: string | undefined
  onOpen: (task: OpenTask) => void
}) {
  const ended = useContext(SettledTasks)
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  const now = useNow(60_000)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape) }
  }, [open])
  const latest = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)
  const running = latest.filter(t => t.running)
  const done = latest.filter(t => !t.running)
  if (tasks.length === 0) return null
  const label = (task: SessionItem) => labels.get(task.id) ?? (taskWords(task.title ?? '') || '子任务')
  const row = (task: SessionItem) => {
    const state = task.running ? RUNNING : ended.get(task.id) ?? DONE
    const words = label(task)
    return (
      <li key={task.id}>
        <button className={`subtask-tracker-row ${task.id === current ? 'active' : ''}`} title={words} onClick={() => { setOpen(false); onOpen({ id: task.id, label: words }) }}>
          {task.running ? <span className="tool-spinner" aria-hidden /> : <Icon name={state === DONE ? 'check' : 'alert'} className={`tone-${state.tone}`} />}
          <span className="subtask-tracker-label">{words}</span>
          <span className={`delegation-state tone-${state.tone}`}>{task.running ? state.label : `${state.label} · ${relativeTime(task.updatedAt, now)}`}</span>
          <Icon name="chevron" className="exchange-open" />
        </button>
      </li>
    )
  }
  const summary = running.length > 0 ? `${running.length} 个子任务在跑` : '子任务'
  return (
    <div ref={root} className="subtask-tracker">
      <button type="button" className={`subtask-tracker-toggle ${running.length > 0 ? 'tone-running' : ''}`} aria-haspopup="dialog" aria-expanded={open}
        title={`进行中 ${running.length} 个，已结束 ${done.length} 个；点开看每一个的窗口`} onClick={() => setOpen(o => !o)}>
        {running.length > 0 ? <span className="tool-spinner" aria-hidden /> : <Icon name="flow" />}
        <span>{summary}</span>
        {done.length > 0 && <span className="subtask-tracker-ended">已结束 {done.length}</span>}
        <Icon name="chevron-down" className="subtask-tracker-chevron" />
      </button>
      {open && (
        <div className="subtask-tracker-panel" role="dialog" aria-label="子任务">
          <section>
            <div className="subtask-tracker-head">进行中<span className="skills-count">{running.length}</span></div>
            {running.length === 0 ? <p className="muted small subtask-tracker-empty">现在没有在跑的子任务</p> : <ul>{running.map(row)}</ul>}
          </section>
          {done.length > 0 && (
            <section>
              <div className="subtask-tracker-head">已结束<span className="skills-count">{done.length}</span></div>
              <ul>{done.slice(0, ENDED_SHOWN).map(row)}</ul>
              {done.length > ENDED_SHOWN && <p className="muted small subtask-tracker-empty">更早的 {done.length - ENDED_SHOWN} 个在对话里</p>}
            </section>
          )}
        </div>
      )}
    </div>
  )
}

/** The sub-tasks of a thread, on its page: a compact row each. */
export function ThreadSubTasks({ client, session, from, to, onOpen }: { client: AdgClient; session: string; from: number; to: number | undefined; onOpen: (task: OpenTask) => void }) {
  const items = useStore(client.sessions).items.filter(i => inThread(i, session, from, to))
  if (items.length === 0) return null
  return (
    <div className="delegation thread-subtasks">
      {items.map(child => {
        const label = taskWords(child.title ?? '') || '子任务'
        const state = child.running ? RUNNING : DONE
        return (
          <button key={child.id} className={`exchange-line subtask-line tone-${state.tone}`} onClick={() => onOpen({ id: child.id, label })}>
            <Icon name="flow" />
            <span className="exchange-who">子任务</span>
            <span className="exchange-title">{label}</span>
            <span className={`delegation-state tone-${state.tone}`}>{state.tone === 'running' && <span className="tool-spinner" aria-hidden />}{state.label}</span>
            <Icon name="chevron" className="exchange-open" />
          </button>
        )
      })}
    </div>
  )
}
