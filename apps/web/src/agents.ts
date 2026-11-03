/**
 * The agents the chat area is built around (docs/design/agent-roles.md §9):
 * the main agent (助手: your conversations, here and in Feishu) and the role
 * agents the plugins register (干预, 游戏, …). Their sessions carry `role`;
 * the main agent's carry none.
 */
import { useEffect, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { AgentToolGroup, Role, UserAgent } from '@adg/protocol'
import type { IconName } from './components/Icons.tsx'
import { useStore } from './hooks.ts'

/** The main agent's id in the roster and the route; sessions have no role for it. */
export const MAIN_AGENT = 'main'

export interface Agent {
  readonly id: string
  readonly name: string
  readonly description: string
  readonly icon: IconName
}

const ROLE_ICON: Readonly<Record<string, IconName>> = { intervene: 'alert', games: 'gamepad', scripts: 'package', pipelines: 'flow' }

export const MAIN: Agent = { id: MAIN_AGENT, name: '助手', description: '和你对话、替你安排；飞书里的消息也到这里', icon: 'chat' }

export function agentOf(role: Role): Agent {
  return { id: role.id, name: role.name, description: role.description, icon: ROLE_ICON[role.id] ?? 'sparkles' }
}

/** The role agents the server has now (a plugin turned off takes its role away). */
export function useRoles(client: AdgClient): readonly Role[] {
  const status = useStore(client.connection.status)
  const [roles, setRoles] = useState<readonly Role[]>([])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('roles/list', {}).then(r => { if (live) setRoles(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state])
  useEffect(() => client.connection.on('roles/changed', r => setRoles(r.items)), [client])
  return roles
}

/** The agents the person made (`agents/list`), read again when the roster changes; null: not read yet or no such capability. */
export function useUserAgents(client: AdgClient): { items: readonly UserAgent[]; groups: readonly AgentToolGroup[] } | null {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const [state, setState] = useState<{ items: readonly UserAgent[]; groups: readonly AgentToolGroup[] } | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => client.connection.on('roles/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('agents')) return
    let live = true
    client.connection.call('agents/list', {}).then(r => { if (live) setState(r) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, capabilities, revision])
  return state
}

/** The agent a session belongs to: its role when the server has that role, else the main agent. */
export function agentIdOf(item: { role?: string | undefined }, roles: readonly Role[]): string {
  return item.role !== undefined && roles.some(r => r.id === item.role) ? item.role : MAIN_AGENT
}

/** Who asked for a role agent's task, as its card says it: 你布置的, 来自监控, 来自定时, 来自流水线「…」. */
export function requestedLabel(by: string): string {
  return by === '你' ? '你布置的' : `来自${by}`
}

/**
 * Each session's last reply as one line (`sessions/lastReplies`), read again
 * when the session changes or stops running (its reply can land without its
 * updatedAt moving). Asks only for the sessions given, a batch at a time.
 */
export function useLastReplies(client: AdgClient, items: readonly { id: string; updatedAt: number; running: boolean }[]): ReadonlyMap<string, string | null> {
  const status = useStore(client.connection.status)
  const [replies, setReplies] = useState<ReadonlyMap<string, string | null>>(new Map())
  const known = useRef(new Map<string, string>())
  const version = (i: { updatedAt: number; running: boolean }) => `${i.updatedAt}${i.running ? '+' : ''}`
  const key = items.map(i => `${i.id}@${version(i)}`).join(',')
  useEffect(() => {
    if (status.state !== 'open') return
    const stale = items.filter(i => known.current.get(i.id) !== version(i)).slice(0, 60)
    if (stale.length === 0) return
    for (const i of stale) known.current.set(i.id, version(i))
    client.connection.call('sessions/lastReplies', { sessionIds: stale.map(i => i.id) }).then(r => {
      setReplies(prev => {
        const next = new Map(prev)
        for (const item of r.items) next.set(item.sessionId, item.text)
        return next
      })
    }).catch(() => { for (const i of stale) known.current.delete(i.id) })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, status.state, key])
  return replies
}

const SEEN_KEY = 'adg.agentSeen'

function readSeen(): Record<string, number> {
  try {
    const saved = JSON.parse(localStorage.getItem(SEEN_KEY) ?? '{}') as unknown
    return saved !== null && typeof saved === 'object' ? saved as Record<string, number> : {}
  } catch {
    return {}
  }
}

/**
 * When each agent was last looked at, in this browser: an agent whose
 * sessions changed since shows as unread in the roster.
 */
export function useSeen(): { seen: Readonly<Record<string, number>>; markSeen: (agentId: string, at: number) => void } {
  const [seen, setSeen] = useState<Record<string, number>>(readSeen)
  const markSeen = (agentId: string, at: number) => {
    setSeen(prev => {
      if ((prev[agentId] ?? 0) >= at) return prev
      const next = { ...prev, [agentId]: at }
      try { localStorage.setItem(SEEN_KEY, JSON.stringify(next)) } catch { /* private mode */ }
      return next
    })
  }
  return { seen, markSeen }
}
