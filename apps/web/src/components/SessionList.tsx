import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { useNow, useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'

export const MOD_KEY = /Mac|iPhone|iPad/.test(navigator.platform) ? '⌘' : 'Ctrl '

/** The chat area's second column: session search, new session, and the list grouped by day. */
export function SessionList({ client, selected, onSelect }: {
  client: AdgClient
  selected: string | null
  onSelect: (sessionId: string) => void
}) {
  const sessions = useStore(client.sessions)
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [creating, setCreating] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [query, setQuery] = useState('')
  const search = useRef<HTMLInputElement>(null)

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

  const groups = useMemo(() => {
    const needle = query.trim().toLowerCase()
    const visible = sessions.items.filter(item => item.origin !== 'subagent'
      && (needle === '' || sessionTitle(item).toLowerCase().includes(needle) || (item.cwd ?? '').toLowerCase().includes(needle)))
    return groupByDay(visible, now)
  }, [sessions.items, query, now])

  const create = async () => {
    setCreating(true)
    setError(null)
    try {
      onSelect(await client.createSession())
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setCreating(false)
    }
  }

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
        <button className="primary new-session" onClick={() => void create()} disabled={creating || status.state !== 'open'}>
          <Icon name="plus" /><span>{creating ? '创建中…' : '新会话'}</span>
        </button>
        {error !== null && <div className="error small">{error}</div>}
      </div>

      <nav className="session-list" aria-label="最近会话">
        {!sessions.loaded && status.state === 'open' && <div className="muted small pad">加载中…</div>}
        {sessions.loaded && groups.length === 0 && (
          query.trim() === ''
            ? <div className="sidebar-empty"><Icon name="chat" /><span>还没有会话</span><span>新建一个，告诉 agent 今天要跑什么</span></div>
            : <div className="sidebar-empty"><Icon name="search" /><span>没有匹配的会话</span></div>
        )}
        {groups.map(group => (
          <div key={group.label} className="session-group">
            <div className="sidebar-label">{group.label}</div>
            {group.items.map(item => (
              <button
                key={item.id}
                className={`nav-item session-item ${item.id === selected ? 'active' : ''}`}
                aria-current={item.id === selected ? 'page' : undefined}
                onClick={() => onSelect(item.id)}
                title={item.cwd}
              >
                <span className="nav-item-label">{sessionTitle(item)}</span>
                {item.running
                  ? <span className="run-dot" role="img" aria-label="运行中" />
                  : <span className="session-time">{relativeTime(item.updatedAt, now)}</span>}
              </button>
            ))}
          </div>
        ))}
      </nav>
    </aside>
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
