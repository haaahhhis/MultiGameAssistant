import type { AdgClient } from '@adg/client-core'
import { useStore } from '../hooks.ts'
import type { PageContribution } from '../plugins.ts'
import { AdgMark, Icon, type IconName } from './Icons.tsx'
import { useAgentStates, type AgentState } from './SessionList.tsx'

/** Which rail entry is current: an agent, a plugin page, every timed task, a new agent, or settings. */
export type RailTarget =
  | { readonly kind: 'agent'; readonly id: string }
  | { readonly kind: 'page'; readonly id: string }
  | { readonly kind: 'schedule' }
  | { readonly kind: 'newAgent' }
  | { readonly kind: 'settings' }
  | { readonly kind: 'none' }

/**
 * The first column: 游戏 and the agents, each its own entry (docs/design/
 * agent-roles.md §12). Pages come from UI plugins, so an area appears exactly
 * when the host serves the capabilities behind it; pages ordered below 0 come
 * before the agents. An agent shows whether it is working, whether something
 * came in, and what waits for you there.
 */
export function NavRail({ client, pages, current, onAgent, onPage, onSchedule, onNewAgent, onSettings }: {
  client: AdgClient
  pages: readonly PageContribution[]
  current: RailTarget
  onAgent: (agentId: string) => void
  onPage: (pageId: string) => void
  onSchedule: () => void
  onNewAgent: () => void
  onSettings: () => void
}) {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const agents = useAgentStates(client, current.kind === 'agent' ? current.id : undefined)
  const pageItem = (page: PageContribution) => (
    <RailItem key={page.id} icon={page.icon} label={page.title} active={current.kind === 'page' && current.id === page.id} onClick={() => onPage(page.id)} />
  )
  return (
    <nav className="rail" aria-label="功能区">
      <button className="rail-brand" onClick={() => onAgent(agents[0]?.agent.id ?? '')} title="MultiGameAssistant">
        <AdgMark />
      </button>
      <div className="rail-items">
        {pages.filter(page => page.order < 0).map(pageItem)}
        <span className="rail-divider" role="separator" />
        {agents.map(state => (
          <AgentItem key={state.agent.id} state={state} active={current.kind === 'agent' && current.id === state.agent.id} onClick={() => onAgent(state.agent.id)} />
        ))}
        {capabilities.has('agents') && (
          <RailItem icon="plus" label="新建" title="自己建一个 agent：名字、职责、能用的工具" active={current.kind === 'newAgent'} onClick={onNewAgent} disabled={status.state !== 'open'} />
        )}
        {pages.filter(page => page.order >= 0).map(pageItem)}
      </div>
      <div className="rail-footer">
        {capabilities.has('pipelines') && (
          <RailItem icon="calendar" label="定时" title="每个 agent 的定时任务，和按时运行的流水线" active={current.kind === 'schedule'} onClick={onSchedule} />
        )}
        <RailItem icon="settings" label="设置" active={current.kind === 'settings'} onClick={onSettings} />
        <span className={`rail-connection ${status.state}`} role="status" title={connectionLabel(status.state, status.attempt, status.error)}>
          <span className="conn-dot" /><span className="sr-only">{connectionLabel(status.state, status.attempt, status.error)}</span>
        </span>
      </div>
    </nav>
  )
}

function AgentItem({ state, active, onClick }: { state: AgentState; active: boolean; onClick: () => void }) {
  const { agent, running, unread, waiting } = state
  return (
    <button className={`rail-item rail-agent ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick}
      title={`${agent.name}：${agent.description}${running > 0 ? `（进行中${running > 1 ? ` ${running}` : ''}）` : ''}`}>
      <span className={`agent-avatar rail-avatar agent-${agent.id}`}>
        <Icon name={agent.icon} />
        {running > 0 && <span className="agent-busy" role="img" aria-label={`${running} 个正在运行`} />}
      </span>
      <span className={`rail-label ${unread ? 'unread' : ''}`}>{agent.name}</span>
      {waiting > 0
        ? <span className="rail-badge" aria-label={`${waiting} 个等你处理`}>{waiting}</span>
        : unread && <span className="rail-unread" role="img" aria-label="有新结果" />}
    </button>
  )
}

function RailItem({ icon, label, title = label, active, onClick, disabled = false }: {
  icon: IconName
  label: string
  title?: string
  active: boolean
  onClick: () => void
  disabled?: boolean
}) {
  return (
    <button className={`rail-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick} title={title} disabled={disabled}>
      <Icon name={icon} />
      <span className="rail-label">{label}</span>
    </button>
  )
}

function connectionLabel(state: string, attempt: number, error?: string): string {
  const label = state === 'open' ? '已连接 agent' : state === 'connecting' ? '正在连接…' : state === 'reconnecting' ? `重连中（第 ${attempt} 次）` : '未连接'
  return error === undefined ? label : `${label}：${error}`
}
