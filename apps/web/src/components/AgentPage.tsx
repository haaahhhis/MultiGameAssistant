import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ModelSelection, SessionItem } from '@adg/protocol'
import { agentIdOf, agentOf, requestedLabel, useLastReplies, useRoles, useUserAgents } from '../agents.ts'
import { useNow, useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'
import { relativeTime, sessionTitle } from './SessionList.tsx'

/** Task cards shown before 「更多」. */
const SHOWN = 20

/**
 * A role agent's page (docs/design/agent-roles.md §9): who it is, then its
 * work as one card per task — what it was, where it stands, what it said —
 * newest first. A card opens the task's session; the box at the top gives it
 * a new task.
 */
export function AgentPage({ client, agentId, onOpen, onStart, onMain, onEdit }: {
  client: AdgClient
  agentId: string
  onOpen: (sessionId: string) => void
  /** A task just created: open it and send its first message. */
  onStart: (sessionId: string, text: string) => void
  onMain: () => void
  /** Change the agent (one the person made). */
  onEdit: () => void
}) {
  const roles = useRoles(client)
  const userAgents = useUserAgents(client)
  const sessions = useStore(client.sessions)
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const now = useNow(30_000)
  const [archived, setArchived] = useState<ReadonlySet<string>>(new Set())
  const [model, setModel] = useState<ModelSelection | null | undefined>(undefined)
  const [all, setAll] = useState(false)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('archive')) return
    let live = true
    client.connection.call('sessions/archived', {}).then(r => { if (live) setArchived(new Set(r.sessionIds)) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, capabilities])
  useEffect(() => client.connection.on('sessions/archived', r => setArchived(new Set(r.sessionIds))), [client])
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('role-model')) return
    let live = true
    client.connection.call('models/roleModel', {}).then(r => { if (live) setModel(r.model) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, capabilities])

  const role = roles.find(r => r.id === agentId)
  const agent = role === undefined ? undefined : agentOf(role)
  const own = role?.custom === true ? userAgents?.items.find(a => a.id === agentId) : undefined
  const ownModel = own?.model ?? null
  const tasks = useMemo(() => sessions.items
    .filter(item => item.origin !== 'subagent' && !item.blank && !archived.has(item.id) && agentIdOf(item, roles) === agentId)
    .sort((a, b) => b.updatedAt - a.updatedAt), [sessions.items, archived, roles, agentId])
  const shown = all ? tasks : tasks.slice(0, SHOWN)
  const replies = useLastReplies(client, shown.map(t => ({ id: t.id, updatedAt: t.updatedAt, running: t.running })))
  const running = tasks.filter(t => t.running).length

  if (agent === undefined) {
    return <section className="main empty">{roles.length === 0 ? '读取中…' : <span>这个 agent 现在不在（它的插件没有加载）。<button className="link-button" onClick={onMain}>回到助手</button></span>}</section>
  }

  const start = async () => {
    const value = text.trim()
    if (value === '' || busy || status.state !== 'open') return
    setBusy(true)
    setError(null)
    try {
      const sessionId = await client.createSession(undefined, { role: agent.id })
      setText('')
      onStart(sessionId, value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void start()
    }
  }

  return (
    <section className="main agent-page">
      <header className="welcome-header">
        <span>对话<span className="breadcrumb-divider">/</span><strong>{agent.name}</strong></span>
      </header>
      <div className="agent-page-content">
        <div className="agent-intro">
          <span className={`agent-avatar large agent-${agent.id}`}><Icon name={agent.icon} /></span>
          <div className="agent-intro-text">
            <h1>{agent.name}</h1>
            <p className="muted">{agent.description}</p>
            <p className="muted small">
              {tasks.length === 0 ? '还没有做过事' : `做过 ${tasks.length} 件事${running > 0 ? `，${running} 件正在做` : ''}`}
              {ownModel !== null ? <> · 模型：{ownModel.model}</> : model !== undefined && <> · 模型：{model === null ? '默认模型' : model.model}</>}
            </p>
          </div>
          {role?.custom === true && <button className="agent-edit" onClick={onEdit}><Icon name="pencil" />编辑</button>}
        </div>
        {own !== undefined && (
          <details className="agent-duty">
            <summary>职责和工具</summary>
            <p className="agent-duty-text">{own.duty}</p>
            <p className="muted small">本软件的工具：{own.tools.length === 0 ? '无' : own.tools.map(id => userAgents?.groups.find(g => g.id === id)?.name ?? id).join('、')}；文件、命令、上网这些通用工具都能用。</p>
          </details>
        )}

        <div className="composer-box agent-composer">
          <textarea aria-label={`给${agent.name}布置一件事`} value={text} onChange={e => setText(e.target.value)} onKeyDown={onKeyDown} rows={2}
            placeholder={status.state !== 'open' ? '未连接到 agent' : `直接给「${agent.name}」布置一件事`} disabled={status.state !== 'open'} />
          <div className="composer-actions">
            {error !== null && <span className="error small">{error}</span>}
            <span className="spacer" />
            <span className="composer-kbd"><kbd>Enter</kbd> 开始</span>
            <button className="send-button" aria-label="开始" onClick={() => void start()} disabled={busy || text.trim() === '' || status.state !== 'open'}>
              <Icon name="arrow" />
            </button>
          </div>
        </div>

        <div className="task-list" aria-label={`${agent.name}做过的事`}>
          {tasks.length === 0 && <div className="sidebar-empty"><Icon name={agent.icon} /><span>还没有{agent.name}的任务</span><span>{role?.custom === true ? '在上面给它布置第一件事。' : '软件需要它时会自动交给它，也可以在上面直接布置。'}</span></div>}
          {shown.map(task => <TaskCard key={task.id} task={task} roleName={agent.name} reply={replies.get(task.id)} now={now} onOpen={() => onOpen(task.id)} />)}
          {!all && tasks.length > SHOWN && <button className="link-button more-tasks" onClick={() => setAll(true)}>更多（{tasks.length - SHOWN}）</button>}
        </div>
      </div>
    </section>
  )
}

function TaskCard({ task, roleName, reply, now, onOpen }: { task: SessionItem; roleName: string; reply: string | null | undefined; now: number; onOpen: () => void }) {
  const title = sessionTitle(task)
  const shownTitle = title.startsWith(`${roleName}：`) ? title.slice(roleName.length + 1) || title : title
  return (
    <button className={`task-card ${task.running ? 'running' : ''}`} onClick={onOpen} title="查看过程">
      <span className="task-head">
        <span className="task-title">{shownTitle}</span>
        {task.running ? <span className="agent-working"><span className="run-dot" />进行中</span> : <span className="session-time">{relativeTime(task.updatedAt, now)}</span>}
      </span>
      <span className="task-reply">{reply === undefined ? '…' : reply ?? (task.running ? '正在处理' : '没有留下结论')}</span>
      <span className="task-foot">
        {task.requestedBy !== undefined && <span className="task-by">{requestedLabel(task.requestedBy)}</span>}
        <span className="task-open">查看过程<Icon name="chevron" /></span>
      </span>
    </button>
  )
}
