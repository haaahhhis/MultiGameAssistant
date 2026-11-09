import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import { buildChat, type AdgClient, type ChatItem } from '@adg/client-core'
import { summarizeToolArgs, type SessionItem } from '@adg/protocol'
import { useLastReplies } from '../../agents.ts'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { useSessionHandle, useStore } from '../../hooks.ts'
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

/** How a tool result names the child (dsh-tool-subagent's start result). */
const STARTED = /started subagent (\S+)/

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/** What dsh adds to a sub-agent's first message, for the sub-agent: not what it was given to do. */
const PARENT_NOTE = /\s*Your parent agent\b[\s\S]*$/

export function taskWords(text: string): string {
  return text.replace(PARENT_NOTE, '')
}

/** dsh's words when a sub-agent ended (settlementSummary), read for how it ended. */
const SETTLED = /^Background subagent (\S+) (finished|was stopped)?/

/** How the sub-agents of a conversation ended, from the notices it was sent; those are not drawn, the card says it. */
export function settledTasks(items: readonly ChatItem[]): ReadonlyMap<string, TaskState> {
  const ended = new Map<string, TaskState>()
  for (const item of items) {
    if (!isSettlement(item)) continue
    const match = SETTLED.exec(item.summary)
    if (match === null) continue
    ended.set(match[1]!, match[2] === 'finished' ? DONE : match[2] === 'was stopped' ? STOPPED : FAILED)
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

export type TaskState = { label: string; tone: string }
const RUNNING: TaskState = { label: '进行中', tone: 'running' }
const DONE: TaskState = { label: '完成', tone: 'ok' }
const STOPPED: TaskState = { label: '已停止', tone: 'failed' }
const FAILED: TaskState = { label: '没做成', tone: 'failed' }

/** A sub-task's steps, read from its own conversation, only while on screen. */
function Steps({ client, id, running }: { client: AdgClient; id: string; running: boolean }) {
  const handle = useSessionHandle(client, id)
  return handle === null ? <div className="subtask-steps muted small">正在打开…</div> : <OpenSteps handle={handle} running={running} />
}

function OpenSteps({ handle, running }: { handle: NonNullable<ReturnType<typeof useSessionHandle>>; running: boolean }) {
  const state = useStore(handle.state)
  const tools = useMemo(() => buildChat(state.events, state.live, state.pending).filter((i): i is ToolItem => i.kind === 'tool'), [state.events, state.live, state.pending, state.version])
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

/**
 * A sub-agent an agent opened, in that agent's turn.
 * @param compact - one line, opening beside the conversation (the 协作 level); else with its steps and answer.
 */
export function SubTaskCard({ client, item, compact }: { client: AdgClient; item: ToolItem; compact: boolean }) {
  const open = useContext(OpenSubTask)
  const { description, prompt } = useMemo(() => argsOf(item.arguments), [item.arguments])
  const id = STARTED.exec(item.result ?? '')?.[1]
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

  if (compact) {
    return (
      <div className="delegation task-line">
        <button className={`exchange-line subtask-line tone-${state.tone}`} disabled={id === undefined} title={prompt} onClick={() => { if (id !== undefined) open({ id, label }) }}>
          <Icon name="flow" />
          <span className="exchange-who">子任务</span>
          <span className="exchange-title">{label}</span>
          {badge}
          {id !== undefined && <Icon name="chevron" className="exchange-open" />}
        </button>
        {refused && <div className="delegation-failed"><Icon name="alert" />{item.result ?? item.error ?? '没有开起来'}</div>}
      </div>
    )
  }
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
 * §14.5). It only filters what is already loaded, and is kept per agent, in
 * this browser.
 */
export type ChatDetail = 1 | 2 | 3

const DETAIL_KEY = 'adg.chatDetail.'

export function useChatDetail(agentId: string): [ChatDetail, (detail: ChatDetail) => void] {
  const read = (): ChatDetail => {
    try {
      const saved = Number(localStorage.getItem(DETAIL_KEY + agentId))
      return saved === 1 || saved === 3 ? saved : 2
    } catch {
      return 2
    }
  }
  const [detail, setDetail] = useState<ChatDetail>(read)
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => setDetail(read()), [agentId])
  return [detail, next => {
    setDetail(next)
    try { localStorage.setItem(DETAIL_KEY + agentId, String(next)) } catch { /* private mode: lasts until reload */ }
  }]
}

const LEVELS: readonly { level: ChatDetail; label: string; hint: string }[] = [
  { level: 1, label: '汇报', hint: '只看它和你说的话' },
  { level: 2, label: '协作', hint: '加上 agent 之间的往来，子任务一行' },
  { level: 3, label: '全部', hint: '子任务也展开：步骤和答案' },
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

/** The sub-tasks of a thread, on its page: a compact row each. */
export function ThreadSubTasks({ client, session, from, to, onOpen }: { client: AdgClient; session: string; from: number; to: number | undefined; onOpen: (task: OpenTask) => void }) {
  // A thread ends only once its sub-agents have, so one last touched after that is from later.
  const items = useStore(client.sessions).items.filter(i => i.origin === 'subagent' && i.parentId === session && i.updatedAt >= from && (to === undefined || i.updatedAt <= to + 2_000))
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
