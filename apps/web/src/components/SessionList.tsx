import { useEffect, useMemo } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { SessionItem } from '@adg/protocol'
import { MAIN, sessionRoot, agentOf, useRoles, useSeen, type Agent } from '../agents.ts'
import { useStore } from '../hooks.ts'

export interface AgentState {
  readonly agent: Agent
  /** Its conversations working now. */
  readonly running: number
  /** Something came in since you last looked. */
  readonly unread: boolean
  /** Approvals and questions waiting in its conversations. */
  readonly waiting: number
  /** Its conversation the roster quotes: its own one, else its latest. */
  readonly last: SessionItem | undefined
}

/**
 * Every agent — 助手 first, then the role agents (干预, 游戏, …) — with
 * whether it is working, whether something came in since you last looked at
 * it, and what waits for you in its conversations (docs/design/agent-roles.md
 * §9, §10). `open` is the agent on screen: what you are looking at counts as seen.
 */
export function useAgentStates(client: AdgClient, open: string | undefined): readonly AgentState[] {
  const sessions = useStore(client.sessions)
  const indexed = useMemo(() => new Map(sessions.items.map(s => [s.id, s])), [sessions.items])
  const approvals = useStore(client.approvals)
  const questions = useStore(client.questions)
  const roles = useRoles(client)
  const { seen, markSeen } = useSeen()
  const agents: readonly Agent[] = useMemo(() => [MAIN, ...roles.map(agentOf)], [roles])
  // Each agent's sessions, newest first, without the archived and the empty.
  const byAgent = useMemo(() => {
    const byAgent = new Map<string, SessionItem[]>(agents.map(a => [a.id, []]))
    for (const item of sessions.items) {
      if (item.blank || (!item.home && item.origin !== 'subagent')) continue
      const home = item.home ?? sessionRoot(item, indexed).home
      if (home) byAgent.get(home)?.push(item)
    }
    for (const list of byAgent.values()) list.sort((a, b) => b.updatedAt - a.updatedAt)
    return byAgent
  }, [sessions.items, indexed, agents])

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
    const item = indexed.get(sessionId)
    return item && sessionRoot(item, indexed).home
  }
  return agents.map(agent => {
    const items = byAgent.get(agent.id) ?? []
    const last = items[0]
    return {
      agent,
      running: items.filter(i => i.running).length,
      unread: agent.id !== open && last !== undefined && last.updatedAt > (seen[agent.id] ?? Infinity),
      waiting: [...approvals, ...questions].filter(r => ownerOf(r.sessionId) === agent.id).length,
      last: items.find(i => i.home === agent.id) ?? last,
    }
  })
}

export function relativeTime(time: number, now: number): string {
  const s = Math.max(0, Math.round((now - time) / 1000))
  if (s < 60) return '刚刚'
  if (s < 3600) return `${Math.floor(s / 60)} 分钟前`
  if (s < 86_400) return `${Math.floor(s / 3600)} 小时前`
  if (s < 86_400 * 7) return `${Math.floor(s / 86_400)} 天前`
  return new Date(time).toLocaleDateString(undefined, { month: 'numeric', day: 'numeric' })
}
