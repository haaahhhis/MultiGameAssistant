import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { useNow, useStore } from '../hooks.ts'
import { FoldHead, useFold } from './Fold.tsx'
import { Icon } from './Icons.tsx'

export const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl '

type Tab = 'chats' | 'remote' | 'auto' | 'archived'
const TABS: readonly [Tab, string][] = [['chats', '对话'], ['remote', '远程'], ['auto', '自动'], ['archived', '已归档']]
const EMPTY: Readonly<Record<Tab, [string, string]>> = {
  chats: ['还没有会话', '新建一个，告诉 agent 今天要跑什么'],
  remote: ['还没有远程会话', '在飞书里给机器人发消息，就会在这里出现一个会话'],
  auto: ['还没有自动会话', '异常交给 agent 处理、流水线里的 agent 步骤、进游戏读取活动会在这里'],
  archived: ['没有归档的会话', '不要的会话点右边的归档按钮放到这里，需要时再恢复'],
}
const CHANNEL: Readonly<Record<string, string>> = { feishu: '飞书' }

/** The chat area's second column: your conversations, remote ones (Feishu), the agent's own, and the archive. */
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
  const [tab, setTab] = useState<Tab>('chats')
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

  const kindOf = (item: { id: string; title: string | null }): Exclude<Tab, 'archived'> => {
    if (remote.has(item.id) || /^(飞书|feishu)：/.test(item.title ?? '')) return 'remote'
    if (/^(干预|编排|游戏信息)：/.test(item.title ?? '')) return 'auto'
    return 'chats'
  }

  // A session opened from elsewhere (a link, 「让 agent 进游戏读取」) shows in its own tab.
  const shownFor = useRef<string | null>(null)
  useEffect(() => {
    if (selected === null || shownFor.current === selected) return
    const item = sessions.items.find(i => i.id === selected)
    if (item === undefined) return
    shownFor.current = selected
    setTab(archived.has(item.id) ? 'archived' : kindOf(item))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected, sessions.items, archived, remote])

  const { groups, counts } = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const all = sessions.items.filter(item => item.origin !== 'subagent' && (!item.blank || item.id === selected))
    const counts: Record<Tab, number> = { chats: 0, remote: 0, auto: 0, archived: 0 }
    for (const item of all) counts[archived.has(item.id) ? 'archived' : kindOf(item)]++
    const visible = all.filter(item => (tab === 'archived' ? archived.has(item.id) : !archived.has(item.id) && kindOf(item) === tab)
      && (needle === '' || sessionTitle(item).toLowerCase().includes(needle) || (item.cwd ?? '').toLowerCase().includes(needle)))
    return { groups: groupByDay(visible, now), counts }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessions.items, query, now, tab, archived, remote, selected])

  const create = () => {
    setError(null)
    setTab('chats')
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

  const [empty, hint] = EMPTY[tab]
  return (
    <aside className="sidebar session-sidebar">
      <div className="sidebar-actions">
        <div className="sidebar-title">对话</div>
        <label className="sidebar-search">
          <Icon name="search" />
          <input ref={search} aria-label="搜索会话" placeholder="搜索会话" value={query} onChange={e => setQuery(e.target.value)}
            onKeyDown={e => { if (e.key === 'Escape') { setQuery(''); e.currentTarget.blur() } }} />
          <kbd>{MOD_KEY}K</kbd>
        </label>
        <button className="primary new-session" onClick={create} disabled={status.state !== 'open'}>
          <Icon name="plus" /><span>新会话</span>
        </button>
        <nav className="session-tabs" role="tablist" aria-label="会话分类">
          {TABS.filter(([id]) => id !== 'archived' || canArchive).map(([id, label]) => (
            <button key={id} role="tab" aria-selected={tab === id} className={tab === id ? 'active' : ''} onClick={() => setTab(id)}
              title={id === 'remote' ? '飞书等聊天软件里和 agent 的对话' : id === 'auto' ? 'agent 自己开的会话：处理异常、流水线里的 agent 步骤' : undefined}>
              {label}{counts[id] > 0 && id !== 'chats' ? <span className="tab-count">{counts[id]}</span> : null}
            </button>
          ))}
        </nav>
        {error !== null && <div className="error small">{error}</div>}
      </div>

      <nav className={`session-list tab-${tab}`} aria-label={TABS.find(([id]) => id === tab)?.[1]}>
        {!sessions.loaded && status.state === 'open' && <div className="muted small pad">加载中…</div>}
        {sessions.loaded && groups.length === 0 && (
          query.trim() === ''
            ? <div className="sidebar-empty"><Icon name={tab === 'remote' ? 'plug' : tab === 'archived' ? 'layers' : 'chat'} /><span>{empty}</span><span>{hint}</span></div>
            : <div className="sidebar-empty"><Icon name="search" /><span>没有匹配的会话</span></div>
        )}
        {groups.map(group => (
          <SessionGroup key={`${tab}:${group.label}`} id={`sessions.${tab}.${group.label}`} label={group.label} count={group.items.length}>
            {group.items.map(item => {
              const who = remote.get(item.id)
              return (
                <div key={item.id} className={`session-row ${item.id === selected ? 'active' : ''}`}>
                  <button
                    className={`nav-item session-item ${item.id === selected ? 'active' : ''}`}
                    aria-current={item.id === selected ? 'page' : undefined}
                    onClick={() => onSelect(item.id)}
                    title={item.cwd}
                  >
                    {tab === 'remote' && <span className="channel-badge">{CHANNEL[who?.channel ?? 'feishu'] ?? who?.channel}</span>}
                    <span className="nav-item-label">{tab === 'remote' ? sessionTitle(item).replace(/^(飞书|feishu)：/, '') : sessionTitle(item)}</span>
                    {item.running
                      ? <span className="run-dot" role="img" aria-label="运行中" />
                      : <span className="session-time">{relativeTime(item.updatedAt, now)}</span>}
                  </button>
                  {canArchive && !item.running && (
                    <button className="session-action" title={tab === 'archived' ? '恢复到会话列表' : '归档：从列表里移走，之后可以在「已归档」里找回'}
                      aria-label={tab === 'archived' ? '恢复' : '归档'} onClick={() => void toggleArchive(item.id, tab !== 'archived')}>
                      <Icon name={tab === 'archived' ? 'back' : 'archive'} />
                    </button>
                  )}
                </div>
              )
            })}
          </SessionGroup>
        ))}
        {tab === 'remote' && groups.length > 0 && <p className="muted small pad">在飞书里继续发消息会接着这个会话；归档后，对方下一条消息会开一个新会话。</p>}
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
  if (s < 3600) return `${Math.floor(s / 60)} 分钟`
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时`
  if (s < 86_400 * 7) return `${Math.floor(s / 86_400)} 天`
  return new Date(time).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}
