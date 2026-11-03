import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { SessionItem } from '@adg/protocol'
import { MAIN, MAIN_AGENT, agentIdOf, agentOf, useLastReplies, useRoles, useSeen, type Agent } from '../agents.ts'
import { useNow, useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'

export const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl '

const CHANNEL: Readonly<Record<string, string>> = { feishu: '飞书' }
/** The main agent's conversations listed under it before 「更多」. */
const MAIN_SHOWN = 12

/**
 * The chat area's second column: the agents rather than their sessions
 * (docs/design/agent-roles.md §9). One row per agent — 助手 first, then the
 * role agents (干预, 游戏, …) — with its latest reply, whether it is working,
 * and whether something came in since you last looked. 助手's own
 * conversations open under its row; a role agent's tasks are its page.
 */
export function AgentRoster({ client, agent, selected, onAgent, onSelect, onNew }: {
  client: AdgClient
  /** The agent whose page or session is open. */
  agent: string
  selected: string | null
  onAgent: (agentId: string) => void
  onSelect: (sessionId: string) => void
  /** A new conversation with 助手: the start page; the session is created when the first message is sent. */
  onNew: () => void
}) {
  const sessions = useStore(client.sessions)
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const roles = useRoles(client)
  const now = useNow(30_000)
  const { seen, markSeen } = useSeen()
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [archived, setArchived] = useState<ReadonlySet<string>>(new Set())
  const [showArchived, setShowArchived] = useState(false)
  const [allMain, setAllMain] = useState(false)
  const [remote, setRemote] = useState<ReadonlyMap<string, { channel: string; user: string }>>(new Map())
  const [notifyRevision, setNotifyRevision] = useState(0)
  const search = useRef<HTMLInputElement>(null)
  const canArchive = capabilities.has('archive')

  // Ctrl/⌘+K jumps to the session search from anywhere.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault()
        search.current?.focus()
        search.current?.select()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [])

  useEffect(() => {
    if (status.state !== 'open' || !canArchive) return
    let live = true
    client.connection.call('sessions/archived', {}).then(r => { if (live) setArchived(new Set(r.sessionIds)) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, canArchive])
  useEffect(() => client.connection.on('sessions/archived', r => setArchived(new Set(r.sessionIds))), [client])
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

  const agents: readonly Agent[] = useMemo(() => [MAIN, ...roles.map(agentOf)], [roles])
  // Each agent's sessions, newest first, without the archived and the empty.
  const { byAgent, archivedItems } = useMemo(() => {
    const all = sessions.items.filter(item => item.origin !== 'subagent' && (!item.blank || item.id === selected))
    const byAgent = new Map<string, SessionItem[]>(agents.map(a => [a.id, []]))
    const archivedItems: SessionItem[] = []
    for (const item of all) {
      if (archived.has(item.id)) { archivedItems.push(item); continue }
      byAgent.get(agentIdOf(item, roles))?.push(item)
    }
    for (const list of byAgent.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
    archivedItems.sort((a, b) => b.updatedAt - a.updatedAt)
    return { byAgent, archivedItems }
  }, [sessions.items, archived, agents, roles, selected])

  const latest = agents.map(a => byAgent.get(a.id)?.[0]).filter((i): i is SessionItem => i !== undefined)
  const replies = useLastReplies(client, latest.map(i => ({ id: i.id, updatedAt: i.updatedAt, running: i.running })))

  // What you are looking at counts as seen; an agent never looked at starts as seen, so nothing is unread on a first start.
  useEffect(() => {
    if (!sessions.loaded) return
    for (const a of agents) {
      const last = byAgent.get(a.id)?.[0]?.updatedAt
      if (last === undefined) continue
      if (a.id === agent || seen[a.id] === undefined) markSeen(a.id, last)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.loaded, byAgent, agent])

  const searching = query.trim() !== ''
  const found = useMemo(() => {
    const needle = query.trim().toLowerCase()
    if (needle === '') return []
    return sessions.items.filter(item => item.origin !== 'subagent' && !item.blank && !archived.has(item.id) && sessionTitle(item).toLowerCase().includes(needle))
      .sort((a, b) => b.updatedAt - a.updatedAt)
  }, [sessions.items, query, archived])

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
    try {
      const r = await client.connection.call(archive ? 'sessions/archive' : 'sessions/unarchive', { sessionId })
      setArchived(new Set(r.sessionIds))
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }

  /** One session in a list: 助手's conversations, the archive, search results. */
  const sessionRow = (item: SessionItem, badge?: string) => {
    const channel = channelOf(item)
    const isArchived = archived.has(item.id)
    return (
      <div key={item.id} className={`session-row ${item.id === selected ? 'active' : ''}`}>
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
          <button className={`nav-item session-item ${item.id === selected ? 'active' : ''}`} aria-current={item.id === selected ? 'page' : undefined}
            onClick={() => onSelect(item.id)} onDoubleClick={() => setRenaming({ id: item.id, value: sessionTitle(item) })} title="双击改名">
            {channel !== undefined && <span className="channel-badge">{channel}</span>}
            {badge !== undefined && <span className="role-badge">{badge}</span>}
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

  const mainItems = byAgent.get(MAIN_AGENT) ?? []
  return (
    <aside className="sidebar session-sidebar">
      <div className="sidebar-actions">
        <div className="sidebar-title">对话</div>
        <label className="sidebar-search">
          <Icon name="search" />
          <input ref={search} aria-label="搜索会话" placeholder="搜索全部会话" value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur() } }} />
          <kbd>{MOD_KEY}K</kbd>
        </label>
        {error !== null && <div className="error small">{error}</div>}
      </div>

      <nav className="session-list agent-roster" aria-label="agent">
        {!sessions.loaded && status.state === 'open' && <div className="muted small pad">加载中…</div>}
        {searching ? (
          found.length === 0
            ? <div className="sidebar-empty"><Icon name="search" /><span>没有匹配的会话</span></div>
            : found.map(item => {
              const owner = agentIdOf(item, roles)
              return sessionRow(item, owner === MAIN_AGENT ? undefined : agents.find(a => a.id === owner)?.name)
            })
        ) : agents.map(a => {
          const items = byAgent.get(a.id) ?? []
          const last = items[0]
          const running = items.filter(i => i.running).length
          const unread = a.id !== agent && last !== undefined && last.updatedAt > (seen[a.id] ?? Infinity)
          const line = last === undefined ? a.description : replies.get(last.id) ?? sessionTitle(last)
          const open = a.id === agent
          return (
            <div key={a.id} className={`agent-entry ${open ? 'open' : ''}`}>
              <button className={`agent-row ${open ? 'active' : ''}`} aria-current={open && selected === null ? 'page' : undefined}
                onClick={() => onAgent(a.id)} title={a.description}>
                <span className={`agent-avatar agent-${a.id}`}>
                  <Icon name={a.icon} />
                  {running > 0 && <span className="agent-busy" role="img" aria-label={`${running} 个正在运行`} />}
                </span>
                <span className="agent-text">
                  <span className="agent-head">
                    <span className={`agent-name ${unread ? 'unread' : ''}`}>{a.name}</span>
                    {running > 0 ? <span className="agent-working">进行中{running > 1 ? ` ${running}` : ''}</span>
                      : last !== undefined && <span className="session-time">{relativeTime(last.updatedAt, now)}</span>}
                    {unread && <span className="unread-dot" role="img" aria-label="有新结果" />}
                  </span>
                  <span className="roster-line">{line}</span>
                </span>
              </button>
              {open && a.id === MAIN_AGENT && (
                <div className="agent-sessions">
                  <button className="nav-item new-topic" onClick={onNew} disabled={status.state !== 'open'}>
                    <Icon name="plus" /><span className="nav-item-label">新话题</span>
                  </button>
                  {(allMain ? mainItems : mainItems.slice(0, MAIN_SHOWN)).map(item => sessionRow(item))}
                  {!allMain && mainItems.length > MAIN_SHOWN && (
                    <button className="nav-item more-sessions" onClick={() => setAllMain(true)}>更多（{mainItems.length - MAIN_SHOWN}）</button>
                  )}
                </div>
              )}
            </div>
          )
        })}
        {!searching && canArchive && archivedItems.length > 0 && (
          <div className="agent-entry archive-entry">
            <button className="nav-item role-row" onClick={() => setShowArchived(v => !v)} aria-expanded={showArchived}>
              <Icon name="archive" />
              <span className="nav-item-label">已归档</span>
              <span className="tab-count">{archivedItems.length}</span>
              <Icon name={showArchived ? 'chevron-down' : 'chevron'} className="role-chevron" />
            </button>
            {showArchived && <div className="agent-sessions">{archivedItems.map(item => {
              const owner = agentIdOf(item, roles)
              return sessionRow(item, owner === MAIN_AGENT ? undefined : agents.find(x => x.id === owner)?.name)
            })}</div>}
          </div>
        )}
      </nav>
    </aside>
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
