import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import type { AdgClient } from '@adg/client-core'
import { MAIN_AGENT, useLastReplies } from '../agents.ts'
import { useStore } from '../hooks.ts'
import type { PageContribution } from '../plugins.ts'
import { Icon, type IconName } from './Icons.tsx'
import { useAgentStates, type AgentState } from './SessionList.tsx'
import { openUpdateNotes, UpdateNotesHost, useAppUpdate } from './Updates.tsx'

/** Which rail entry is current: an agent, a plugin page, every timed task, a new agent, or settings. */
export type RailTarget =
  | { readonly kind: 'agent'; readonly id: string }
  | { readonly kind: 'page'; readonly id: string }
  | { readonly kind: 'schedule' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'none' }

/**
 * The first column (docs/design/agent-roles.md §12). On top, 助手; at the
 * bottom, above 定时, the pages ordered below 0 (游戏). Between them, a list
 * that follows which is open: 助手 (or anything else) lists the other agents
 * and the pages ordered from 0; such a page lists its own things there (the
 * games page, its games: `slot`). Pages come from UI plugins, so an area appears
 * exactly when the host serves the capabilities behind it. An agent shows
 * whether it is working, whether something came in, and what waits for you
 * there. A newer version of the app puts 「更新」 above 定时.
 *
 * Its width is dragged at its edge; wide, an agent's name goes beside its
 * avatar with the start of its last reply under it.
 */
export function NavRail({ client, pages, current, onAgent, onPage, onSchedule, onSettings, width, onWidth, slot }: {
  client: AdgClient
  pages: readonly PageContribution[]
  current: RailTarget
  onAgent: (agentId: string) => void
  onPage: (pageId: string) => void
  onSchedule: () => void
  onSettings: () => void
  width: number
  onWidth: (width: number) => void
  /** Where a top page puts its list. */
  slot: (element: HTMLElement | null) => void
}) {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const agents = useAgentStates(client, current.kind === 'agent' ? current.id : undefined)
  const update = useAppUpdate(client)
  const wide = width >= RAIL_WIDE
  const main = agents.find(a => a.agent.id === MAIN_AGENT)
  const others = agents.filter(a => a.agent.id !== MAIN_AGENT)
  const top = pages.filter(page => page.order < 0)
  const topPage = current.kind === 'page' ? top.find(p => p.id === current.id) : undefined
  // Wide: the start of each agent's last reply, under its name.
  const replies = useLastReplies(client, wide ? agents.flatMap(a => a.last === undefined ? [] : [{ id: a.last.id, updatedAt: a.last.updatedAt, running: a.last.running }]) : [])
  const reply = (state: AgentState) => (state.last === undefined ? undefined : replies.get(state.last.id) ?? undefined)
  const pageItem = (page: PageContribution) => (
    <RailItem key={page.id} icon={page.icon} label={page.title} active={current.kind === 'page' && current.id === page.id} onClick={() => onPage(page.id)} />
  )
  const agentItem = (state: AgentState) => (
    <AgentItem key={state.agent.id} state={state} wide={wide} reply={reply(state)} active={current.kind === 'agent' && current.id === state.agent.id} onClick={() => onAgent(state.agent.id)} />
  )
  return (
    <nav className={`rail${wide ? ' wide' : ''}`} aria-label="功能区">
      <div className="rail-top">
        {main !== undefined && agentItem(main)}
      </div>
      <span className="rail-divider" role="separator" />
      {topPage !== undefined
        ? <div className="rail-items rail-slot" ref={slot} aria-label={topPage.title} />
        : (
          <div className="rail-items">
            {others.map(agentItem)}
            {pages.filter(page => page.order >= 0).map(pageItem)}
          </div>
        )}
      <div className="rail-footer">
        {top.map(pageItem)}
        {update !== null && (
          <RailItem icon="download" label="更新" title={`MultiGameAssistant ${update.version} 可以更新了：点开看更新了什么`} active={false} onClick={openUpdateNotes} dot />
        )}
        {capabilities.has('pipelines') && (
          <RailItem icon="calendar" label="定时" title="每个 agent 的定时任务，和按时运行的流水线" active={current.kind === 'schedule'} onClick={onSchedule} />
        )}
        <RailItem icon="settings" label="设置" active={current.kind === 'settings'} onClick={onSettings} />
        {/* Only while the connection is not there: connected needs no mark. */}
        {status.state !== 'open' && (
          <span className={`rail-connection ${status.state}`} role="status" title={connectionLabel(status.state, status.attempt, status.error)}>
            <span className="conn-dot" /><span className="sr-only">{connectionLabel(status.state, status.attempt, status.error)}</span>
          </span>
        )}
      </div>
      <RailResizer width={width} onWidth={onWidth} />
      <UpdateNotesHost client={client} />
    </nav>
  )
}

/** From this width the rail lays its entries out in rows: names beside the icons. */
export const RAIL_WIDE = 150
export const RAIL_MIN = 68
export const RAIL_MAX = 360
const RAIL_KEY = 'adg.railWidth'

/** The rail's width, kept in this browser. */
export function useRailWidth(): [number, (width: number) => void] {
  const [width, setWidth] = useState(() => {
    try { return clampRail(Number(localStorage.getItem(RAIL_KEY) ?? RAIL_MIN)) } catch { return RAIL_MIN }
  })
  useEffect(() => {
    const timer = setTimeout(() => { try { localStorage.setItem(RAIL_KEY, String(width)) } catch { /* storage unavailable */ } }, 200)
    return () => clearTimeout(timer)
  }, [width])
  return [width, next => setWidth(clampRail(next))]
}

/** Narrow or wide, nothing in between that fits neither: below the wide width it snaps back to narrow. */
function clampRail(width: number): number {
  if (!Number.isFinite(width)) return RAIL_MIN
  const w = Math.min(RAIL_MAX, Math.max(RAIL_MIN, Math.round(width)))
  return w < RAIL_WIDE ? (w < (RAIL_MIN + RAIL_WIDE) / 2 ? RAIL_MIN : RAIL_WIDE) : w
}

/** The rail's right edge: drag to widen or narrow it; a double-click flips between narrow and wide. */
function RailResizer({ width, onWidth }: { width: number; onWidth: (width: number) => void }) {
  const drag = useRef<{ x: number; width: number } | null>(null)
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    drag.current = { x: e.clientX, width }
    e.currentTarget.setPointerCapture(e.pointerId)
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (drag.current === null) return
    onWidth(drag.current.width + e.clientX - drag.current.x)
  }
  const onUp = () => { drag.current = null }
  return (
    <div className="rail-resizer" role="separator" aria-orientation="vertical" aria-label="调整侧边栏宽度" title="拖动调整宽度；双击展开或收起"
      onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
      onDoubleClick={() => onWidth(width >= RAIL_WIDE ? RAIL_MIN : 220)} />
  )
}

function AgentItem({ state, wide, reply, active, onClick }: { state: AgentState; wide: boolean; reply: string | undefined; active: boolean; onClick: () => void }) {
  const { agent, running, unread, waiting } = state
  const line = reply?.replace(/\s+/g, ' ').trim()
  return (
    <button className={`rail-item rail-agent ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}
      title={`${agent.name}：${agent.description}${running > 0 ? `（进行中${running > 1 ? ` ${running}` : ''}）` : ''}`}>
      <span className={`agent-avatar rail-avatar agent-${agent.id}`}>
        <Icon name={agent.icon} />
        {running > 0 && <span className="agent-busy" role="img" aria-label={`${running} 个正在运行`} />}
      </span>
      {wide ? (
        <span className="rail-text">
          <span className={`rail-label ${unread ? 'unread' : ''}`}>{agent.name}</span>
          <span className="rail-preview">{running > 0 ? '正在处理…' : line !== undefined && line !== '' ? line : agent.description}</span>
        </span>
      ) : <span className={`rail-label ${unread ? 'unread' : ''}`}>{agent.name}</span>}
      {waiting > 0
        ? <span className="rail-badge" aria-label={`${waiting} 个等你处理`}>{waiting}</span>
        : unread && <span className="rail-unread" role="img" aria-label="有新结果" />}
    </button>
  )
}

export function RailItem({ icon, label, title = label, active, onClick, disabled = false, dot = false }: {
  icon: IconName
  label: string
  title?: string
  active: boolean
  onClick: () => void
  disabled?: boolean
  /** Something new there. */
  dot?: boolean
}) {
  return (
    <button className={`rail-item ${active ? 'active' : ''} ${dot ? 'rail-new' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick} title={title} disabled={disabled}>
      <Icon name={icon} />
      <span className="rail-label">{label}</span>
      {dot && <span className="rail-unread" role="img" aria-label="有新版本" />}
    </button>
  )
}

function connectionLabel(state: string, attempt: number, error?: string): string {
  const label = state === 'open' ? '已连接 agent' : state === 'connecting' ? '正在连接…' : state === 'reconnecting' ? `重连中（第 ${attempt} 次）` : '未连接'
  return error === undefined ? label : `${label}：${error}`
}
