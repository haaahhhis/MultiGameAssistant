import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { Role } from '@adg/protocol'
import { useNow, useStore } from '../hooks.ts'
import { FoldHead, useFold } from './Fold.tsx'
import { Icon, type IconName } from './Icons.tsx'

export const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl '

/** What the list shows: the main agent's sessions, one role agent's, or the archive. */
type View = { kind: 'main' } | { kind: 'role'; id: string } | { kind: 'archived' }
const MAIN: View = { kind: 'main' }
const CHANNEL: Readonly<Record<string, string>> = { feishu: '飞书' }
/** Role icons by role id; others get a generic one. */
const ROLE_ICON: Readonly<Record<string, IconName>> = { intervene: 'alert', games: 'gamepad', scripts: 'package', pipelines: 'flow' }

/**
 * The chat area's second column. At the top: your conversations with the
 * main agent (here and in Feishu); above them one row per role agent (干预,
 * 游戏, …), which opens that role's sessions as a second level
 * (docs/design/agent-roles.md). The archive is a level of its own too.
 */
export function SessionList({ client, selected, onSelect, onNew }: {
  client: AdgClient
  selected: string | null
  onSelect: (sessionId: string) => void
  /** A new conversation: the start page; the session is created when the first message is sent. */
  onNew: () => void
}) {
  const sessions = useStore(client.sessions)
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const now = useNow(30_000)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const [view, setView] = useState<View>(MAIN)
  const [roles, setRoles] = useState<readonly Role[]>([])
  const [archived, setArchived] = useState<ReadonlySet<string>>(new Set())
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
    if (status.state !== 'open') return
    let live = true
    client.connection.call('roles/list', {}).then(r => { if (live) setRoles(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state])
  useEffect(() => client.connection.on('roles/changed', r => setRoles(r.items)), [client])
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

  // A role the server no longer has (its plugin is off): its sessions are the main agent's.
  const roleOf = (item: { role?: string | undefined }): string | undefined => roles.some(r => r.id === item.role) ? item.role : undefined
  const channelOf = (item: { id: string; title: string | null }): string | undefined => {
    const who = remote.get(item.id)
    if (who !== undefined) return CHANNEL[who.channel] ?? who.channel
    return /^(飞书|feishu)：/.test(item.title ?? '') ? '飞书' : undefined
  }
  const viewOf = (item: { id: string; role?: string | undefined }): View => {
    if (archived.has(item.id)) return { kind: 'archived' }
    const role = roleOf(item)
    return role === undefined ? MAIN : { kind: 'role', id: role }
  }

  // A session opened from elsewhere (a link, 「让 agent 进游戏读取」) shows in its own level.
  const shownFor = useRef<string | null>(null)
  useEffect(() => {
    if (selected === null || shownFor.current === selected) return
    const item = sessions.items.find(i => i.id === selected)
    if (item === undefined) return
    shownFor.current = selected
    setView(viewOf(item))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, sessions.items, archived, roles])
  // Its role went away (the plugin was turned off): back to the top.
  useEffect(() => {
    if (view.kind === 'role' && roles.length > 0 && !roles.some(r => r.id === view.id)) setView(MAIN)
  }, [view, roles])

  const searching = query.trim() !== ''
  const { groups, perRole, archivedCount } = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = sessions.items.filter(item => item.origin !== 'subagent' && (!item.blank || item.id === selected))
    const perRole = new Map<string, { total: number; running: number }>()
    let archivedCount = 0
    for (const item of all) {
      if (archived.has(item.id)) { archivedCount++; continue }
      const role = roleOf(item)
      if (role === undefined) continue
      const n = perRole.get(role) ?? { total: 0, running: 0 }
      n.total++
      if (item.running) n.running++
      perRole.set(role, n)
    }
    // Searching from the top looks through the roles too; inside a level, only that level.
    const inView = (item: { id: string; role?: string | undefined }) => {
      if (needle !== '' && view.kind === 'main') return !archived.has(item.id)
      const at = viewOf(item)
      return at.kind === view.kind && (at.kind !== 'role' || (view.kind === 'role' && at.id === view.id))
    }
    const visible = all.filter(item => inView(item) && (needle === '' || sessionTitle(item).toLowerCase().includes(needle)))
    return { groups: groupByDay(visible, now), perRole, archivedCount }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.items, query, now, view, archived, roles, selected])

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

  const create = () => {
    setError(null)
    setView(MAIN)
    onNew()
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

  const open = (next: View) => {
    setQuery('')
    setView(next)
  }
  const role = view.kind === 'role' ? roles.find(r => r.id === view.id) : undefined
  const levelKey = view.kind === 'role' ? `role.${view.id}` : view.kind
  const [empty, hint] = view.kind === 'archived'
    ? ['没有归档的会话', '不要的会话点右边的归档按钮放到这里，需要时再恢复']
    : role !== undefined
      ? [`还没有${role.name}的会话`, role.description]
      : ['还没有会话', '新建一个，告诉 agent 今天要跑什么；在飞书里给机器人发消息也会出现在这里']
  return (
    <aside className="sidebar session-sidebar">
      <div className="sidebar-actions">
        {view.kind === 'main' ? <div className="sidebar-title">对话</div> : (
          <div className="session-level-head">
            <button className="session-back" onClick={() => open(MAIN)} aria-label="返回对话" title="返回对话"><Icon name="back" /></button>
            <div className="session-level-title">
              <span>{view.kind === 'archived' ? '已归档' : role?.name ?? ''}</span>
              {role !== undefined && <span className="muted small">{role.description}</span>}
            </div>
          </div>
        )}
        <label className="sidebar-search">
          <Icon name="search" />
          <input ref={search} aria-label="搜索会话" placeholder={view.kind === 'main' ? '搜索全部会话' : '搜索会话'} value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur() } }} />
          <kbd>{MOD_KEY}K</kbd>
        </label>
        {view.kind === 'main' && (
          <button className="primary new-session" onClick={create} disabled={status.state !== 'open'}>
            <Icon name="plus" /><span>新会话</span>
          </button>
        )}
        {view.kind === 'main' && !searching && (roles.length > 0 || (canArchive && archivedCount > 0)) && (
          <nav className="role-nav" aria-label="角色">
            {roles.map(r => {
              const n = perRole.get(r.id)
              return (
                <button key={r.id} className="nav-item role-row" onClick={() => open({ kind: 'role', id: r.id })} title={r.description}>
                  <Icon name={ROLE_ICON[r.id] ?? 'sparkles'} />
                  <span className="nav-item-label">{r.name}</span>
                  {n !== undefined && n.running > 0 && <span className="role-running" title={`${n.running} 个正在运行`}><span className="run-dot" role="img" aria-label="运行中" />{n.running}</span>}
                  {n !== undefined && <span className="tab-count">{n.total}</span>}
                  <Icon name="chevron" className="role-chevron" />
                </button>
              )
            })}
            {canArchive && archivedCount > 0 && (
              <button className="nav-item role-row" onClick={() => open({ kind: 'archived' })}>
                <Icon name="archive" />
                <span className="nav-item-label">已归档</span>
                <span className="tab-count">{archivedCount}</span>
                <Icon name="chevron" className="role-chevron" />
              </button>
            )}
          </nav>
        )}
        {error !== null && <div className="error small">{error}</div>}
      </div>

      <nav className={`session-list view-${view.kind}`} aria-label={view.kind === 'main' ? '对话' : view.kind === 'archived' ? '已归档' : role?.name}>
        {!sessions.loaded && status.state === 'open' && <div className="muted small pad">加载中…</div>}
        {sessions.loaded && groups.length === 0 && (
          !searching
            ? <div className="sidebar-empty"><Icon name={view.kind === 'archived' ? 'layers' : role !== undefined ? ROLE_ICON[role.id] ?? 'sparkles' : 'chat'} /><span>{empty}</span><span>{hint}</span></div>
            : <div className="sidebar-empty"><Icon name="search" /><span>没有匹配的会话</span></div>
        )}
        {groups.map(group => (
          <SessionGroup key={`${levelKey}:${group.label}`} id={`sessions.${levelKey}.${group.label}`} label={group.label} count={group.items.length}>
            {group.items.map(item => {
              const channel = channelOf(item)
              const itemRole = searching && view.kind === 'main' ? roles.find(r => r.id === roleOf(item)) : undefined
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
                  <button
                    className={`nav-item session-item ${item.id === selected ? 'active' : ''}`}
                    aria-current={item.id === selected ? 'page' : undefined}
                    onClick={() => onSelect(item.id)}
                    onDoubleClick={() => setRenaming({ id: item.id, value: sessionTitle(item) })}
                    title="双击改名"
                  >
                    {channel !== undefined && <span className="channel-badge">{channel}</span>}
                    {itemRole !== undefined && <span className="role-badge">{itemRole.name}</span>}
                    <span className="nav-item-label">{shownTitle(item, channel, role)}</span>
                    {item.running
                      ? <span className="run-dot" role="img" aria-label="运行中" />
                      : <span className="session-time">{relativeTime(item.updatedAt, now)}</span>}
                  </button>
                  )}
                  {renaming?.id !== item.id && (
                    <span className="session-row-actions">
                      <button className="session-action" title="改名" aria-label="改名" onClick={() => setRenaming({ id: item.id, value: sessionTitle(item) })}>
                        <Icon name="pencil" />
                      </button>
                      {canArchive && !item.running && (
                        <button className="session-action" title={isArchived ? '恢复到会话列表' : '归档：从列表里移走，之后可以在「已归档」里找回'}
                          aria-label={isArchived ? '恢复' : '归档'} onClick={() => void toggleArchive(item.id, !isArchived)}>
                          <Icon name={isArchived ? 'back' : 'archive'} />
                        </button>
                      )}
                    </span>
                  )}
                </div>
              )
            })}
          </SessionGroup>
        ))}
        {view.kind === 'main' && !searching && groups.some(g => g.items.some(i => channelOf(i) !== undefined)) && <p className="muted small pad">在飞书里继续发消息会接着那个会话；归档后，对方下一条消息会开一个新会话。</p>}
      </nav>
    </aside>
  )
}

function SessionGroup({ id, label, count, children }: { id: string; label: string; count: number; children: React.ReactNode }) {
  const [open, toggle] = useFold(id, true)
  return (
    <div className="session-group">
      <FoldHead open={open} onToggle={toggle} count={count} className="sidebar-label">{label}</FoldHead>
      {open && children}
    </div>
  )
}

export function sessionTitle(item: { title: string | null; blank: boolean }): string {
  return item.title ?? (item.blank ? '新会话' : '未命名会话')
}

/** The title in a row, without what the row already says: the chat channel (its badge), or the role whose level it is in (`干预：` under 干预). */
function shownTitle(item: { title: string | null; blank: boolean }, channel: string | undefined, role: Role | undefined): string {
  const title = sessionTitle(item)
  if (channel !== undefined) return title.replace(/^(飞书|feishu)：/, '')
  if (role !== undefined && title.startsWith(`${role.name}：`)) return title.slice(role.name.length + 1) || title
  return title
}

function groupByDay<T extends { updatedAt: number }>(items: readonly T[], now: number): { label: string; items: T[] }[] {
  const today = new Date(now)
  today.setHours(0, 0, 0, 0)
  const start = today.getTime()
  const day = 86_400_000
  const buckets: [string, number][] = [['今天', start], ['昨天', start - day], ['7 天内', start - 6 * day], ['更早', -Infinity]]
  const groups = buckets.map(([label]) => ({ label, items: [] as T[] }))
  for (const item of items) groups[buckets.findIndex(([, from]) => item.updatedAt >= from)]!.items.push(item)
  return groups.filter(g => g.items.length > 0)
}

export function relativeTime(time: number, now: number): string {
  const s = Math.max(0, Math.round((now - time) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86_400 * 7) return `${Math.floor(s / 86_400)} 天前`
  return new Date(time).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}
