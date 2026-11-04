import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { SessionItem } from '@adg/protocol'
import { MAIN, agentIdOf, agentOf, useRoles, useSeen, type Agent } from '../agents.ts'
import { useNow, useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'

const CHANNEL: Readonly<Record<string, string>> = { feishu: '飞书' }
/** Earlier conversations listed before 「更多」. */
const EARLIER_SHOWN = 30

/** Sessions the person archived (`sessions/archived`), kept current. */
function useArchived(client: AdgClient): ReadonlySet<string> {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const [archived, setArchived] = useState<ReadonlySet<string>>(new Set())
  const canArchive = capabilities.has('archive')
  useEffect(() => {
    if (status.state !== 'open' || !canArchive) return
    let live = true
    client.connection.call('sessions/archived', {}).then(r => { if (live) setArchived(new Set(r.sessionIds)) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, canArchive])
  useEffect(() => client.connection.on('sessions/archived', r => setArchived(new Set(r.sessionIds))), [client])
  return archived
}

export interface AgentState {
  readonly agent: Agent
  /** Its conversations working now. */
  readonly running: number
  /** Something came in since you last looked. */
  readonly unread: boolean
  /** Approvals and questions waiting in its conversations. */
  readonly waiting: number
}

/**
 * Every agent — 助手 first, then the role agents (干预, 游戏, …) — with
 * whether it is working, whether something came in since you last looked at
 * it, and what waits for you in its conversations (docs/design/agent-roles.md
 * §9, §10). `open` is the agent on screen: what you are looking at counts as seen.
 */
export function useAgentStates(client: AdgClient, open: string | undefined): readonly AgentState[] {
  const sessions = useStore(client.sessions)
  const approvals = useStore(client.approvals)
  const questions = useStore(client.questions)
  const roles = useRoles(client)
  const archived = useArchived(client)
  const { seen, markSeen } = useSeen()
  const agents: readonly Agent[] = useMemo(() => [MAIN, ...roles.map(agentOf)], [roles])
  // Each agent's sessions, newest first, without the archived and the empty.
  const byAgent = useMemo(() => {
    const byAgent = new Map<string, SessionItem[]>(agents.map(a => [a.id, []]))
    for (const item of sessions.items) {
      if (item.origin === 'subagent' || item.blank || archived.has(item.id)) continue
      byAgent.get(agentIdOf(item, roles))?.push(item)
    }
    for (const list of byAgent.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
    return byAgent
  }, [sessions.items, archived, agents, roles])

  // An agent never looked at starts as seen, so nothing is unread on a first start.
  useEffect(() => {
    if (!sessions.loaded) return
    for (const a of agents) {
      const last = byAgent.get(a.id)?.[0]?.updatedAt
      if (last === undefined) continue
      if (a.id === open || seen[a.id] === undefined) markSeen(a.id, last)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.loaded, byAgent, open])

  const ownerOf = (sessionId: string) => {
    const item = sessions.items.find(i => i.id === sessionId)
    return item === undefined ? undefined : agentIdOf(item, roles)
  }
  return agents.map(agent => {
    const items = byAgent.get(agent.id) ?? []
    const last = items[0]
    return {
      agent,
      running: items.filter(i => i.running).length,
      unread: agent.id !== open && last !== undefined && last.updatedAt > (seen[agent.id] ?? Infinity),
      waiting: [...approvals, ...questions].filter(r => ownerOf(r.sessionId) === agent.id).length,
    }
  })
}

/** Whether an agent has conversations besides its one conversation (its 「以前的对话」 tab). */
export function useHasEarlier(client: AdgClient, agentId: string): boolean {
  const sessions = useStore(client.sessions)
  const roles = useRoles(client)
  return sessions.items.some(i => i.origin !== 'subagent' && !i.blank && i.home !== agentId && agentIdOf(i, roles) === agentId)
}

/**
 * An agent's earlier conversations (before it had one conversation, from
 * 飞书, made by the app), newest first; the archived ones fold away below.
 * Rename in place; archive and restore.
 */
export function AgentHistory({ client, agentId, onSelect }: {
  client: AdgClient
  agentId: string
  onSelect: (sessionId: string) => void
}) {
  const sessions = useStore(client.sessions)
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const roles = useRoles(client)
  const archived = useArchived(client)
  const now = useNow(30_000)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [showArchived, setShowArchived] = useState(false)
  const [all, setAll] = useState(false)
  const [remote, setRemote] = useState<ReadonlyMap<string, { channel: string; user: string }>>(new Map())
  const [notifyRevision, setNotifyRevision] = useState(0)
  const canArchive = capabilities.has('archive')

  useEffect(() => client.connection.on('notify/changed', () => setNotifyRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('notify')) return
    let live = true
    client.connection.call('notify/conversations', {}).then(r => {
      if (live) setRemote(new Map(r.items.map(i => [i.sessionId, { channel: i.channel, user: i.user }])))
    }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, capabilities, notifyRevision])

  const channelOf = (item: { id: string; title: string | null }): string | undefined => {
    const who = remote.get(item.id)
    if (who !== undefined) return CHANNEL[who.channel] ?? who.channel
    return /^(飞书|feishu)：/.test(item.title ?? '') ? '飞书' : undefined
  }

  const needle = query.trim().toLowerCase()
  const { earlier, archivedItems } = useMemo(() => {
    const mine = sessions.items.filter(i => i.origin !== 'subagent' && !i.blank && i.home !== agentId && agentIdOf(i, roles) === agentId
      && (needle === '' || sessionTitle(i).toLowerCase().includes(needle)))
      .sort((a, b) => b.updatedAt - a.updatedAt)
    return { earlier: mine.filter(i => !archived.has(i.id)), archivedItems: mine.filter(i => archived.has(i.id)) }
  }, [sessions.items, agentId, roles, archived, needle])

  // Renaming in place: the pencil on hover, or a double-click on the row.
  const [renaming, setRenaming] = useState<{ id: string; value: string } | null>(null)
  const rename = async () => {
    const target = renaming
    setRenaming(null)
    const title = target?.value.trim() ?? ''
    const item = sessions.items.find(i => i.id === target?.id)
    if (target === null || item === undefined || title === '' || title === sessionTitle(item)) return
    await client.renameSession(target.id, title).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }

  const toggleArchive = async (sessionId: string, archive: boolean) => {
    setError(null)
    await client.connection.call(archive ? 'sessions/archive' : 'sessions/unarchive', { sessionId }).catch(e => setError(e instanceof Error ? e.message : String(e)))
  }

  const sessionRow = (item: SessionItem) => {
    const channel = channelOf(item)
    const isArchived = archived.has(item.id)
    return (
      <div key={item.id} className="session-row">
        {renaming?.id === item.id ? (
          <input className="text-input session-rename" autoFocus value={renaming.value} maxLength={80} aria-label="会话名称"
            onFocus={e => e.target.select()}
            onChange={e => setRenaming({ id: item.id, value: e.target.value })}
            onKeyDown={e => {
              if (e.key === 'Enter' && !e.nativeEvent.isComposing) void rename()
              if (e.key === 'Escape') setRenaming(null)
            }}
            onBlur={() => void rename()} />
        ) : (
          <button className="nav-item session-item" onClick={() => onSelect(item.id)} onDoubleClick={() => setRenaming({ id: item.id, value: sessionTitle(item) })} title="双击改名">
            {channel !== undefined && <span className="channel-badge">{channel}</span>}
            <span className="nav-item-label">{channel !== undefined ? sessionTitle(item).replace(/^(飞书|feishu)：/, '') : sessionTitle(item)}</span>
            {item.running ? <span className="run-dot" role="img" aria-label="运行中" /> : <span className="session-time">{relativeTime(item.updatedAt, now)}</span>}
          </button>
        )}
        {renaming?.id !== item.id && (
          <span className="session-row-actions">
            <button className="session-action" title="改名" aria-label="改名" onClick={() => setRenaming({ id: item.id, value: sessionTitle(item) })}>
              <Icon name="pencil" />
            </button>
            {canArchive && !item.running && (
              <button className="session-action" title={isArchived ? '恢复' : '归档：从列表里移走，之后可以在「已归档」里找回'}
                aria-label={isArchived ? '恢复' : '归档'} onClick={() => void toggleArchive(item.id, !isArchived)}>
                <Icon name={isArchived ? 'back' : 'archive'} />
              </button>
            )}
          </span>
        )}
      </div>
    )
  }

  return (
    <section className="main history-page">
      <div className="history-body">
        <label className="sidebar-search">
          <Icon name="search" />
          <input aria-label="搜索以前的对话" placeholder="搜索以前的对话" value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') setQuery('') }} />
        </label>
        {error !== null && <div className="error small">{error}</div>}
        <nav className="session-list" aria-label="以前的对话">
          {!sessions.loaded && status.state === 'open' && <div className="muted small pad">加载中…</div>}
          {sessions.loaded && earlier.length === 0 && (
            <div className="sidebar-empty"><Icon name={needle === '' ? 'chat' : 'search'} /><span>{needle === '' ? '没有以前的对话' : '没有匹配的对话'}</span></div>
          )}
          {(all ? earlier : earlier.slice(0, EARLIER_SHOWN)).map(sessionRow)}
          {!all && earlier.length > EARLIER_SHOWN && (
            <button className="nav-item more-sessions" onClick={() => setAll(true)}>更多（{earlier.length - EARLIER_SHOWN}）</button>
          )}
          {canArchive && archivedItems.length > 0 && (
            <div className="archive-entry">
              <button className="nav-item role-row" onClick={() => setShowArchived(v => !v)} aria-expanded={showArchived}>
                <Icon name="archive" />
                <span className="nav-item-label">已归档</span>
                <span className="tab-count">{archivedItems.length}</span>
                <Icon name={showArchived ? 'chevron-down' : 'chevron'} className="role-chevron" />
              </button>
              {showArchived && archivedItems.map(sessionRow)}
            </div>
          )}
        </nav>
      </div>
    </section>
  )
}

export function sessionTitle(item: { title: string | null; blank: boolean }): string {
  return item.title ?? (item.blank ? '新会话' : '未命名会话')
}

export function relativeTime(time: number, now: number): string {
  const s = Math.max(0, Math.round((now - time) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86_400 * 7) return `${Math.floor(s / 86_400)} 天前`
  return new Date(time).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}
