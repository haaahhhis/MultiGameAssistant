import type { AdgClient } from '@adg/client-core'
import { useStore } from '../hooks.ts'
import type { PageContribution } from '../plugins.ts'
import { AdgMark, Icon, type IconName } from './Icons.tsx'

/** Which rail entry is current: the chat area, a plugin page, or settings. */
export type RailTarget = { readonly kind: 'chat' } | { readonly kind: 'page'; readonly id: string } | { readonly kind: 'settings' }

/**
 * The first column: product areas. Chat is always present; every other entry
 * comes from a UI plugin page, so an area appears exactly when the host serves
 * the capabilities behind it. Pages ordered below 0 come before chat (游戏).
 */
export function NavRail({ client, pages, current, onChat, onPage, onSettings }: {
  client: AdgClient
  pages: readonly PageContribution[]
  current: RailTarget
  onChat: () => void
  onPage: (pageId: string) => void
  onSettings: () => void
}) {
  const status = useStore(client.connection.status)
  const approvals = useStore(client.approvals)
  const questions = useStore(client.questions)
  return (
    <nav className="rail" aria-label="功能区">
      <button className="rail-brand" onClick={onChat} title="AutoDailyGamePlay">
        <AdgMark />
      </button>
      <div className="rail-items">
        {pages.filter(page => page.order < 0).map(page => (
          <RailItem key={page.id} icon={page.icon} label={page.title}
            active={current.kind === 'page' && current.id === page.id} onClick={() => onPage(page.id)} />
        ))}
        <RailItem icon="chat" label="对话" active={current.kind === 'chat'} onClick={onChat} badge={approvals.length + questions.length} />
        {pages.filter(page => page.order >= 0).map(page => (
          <RailItem key={page.id} icon={page.icon} label={page.title}
            active={current.kind === 'page' && current.id === page.id} onClick={() => onPage(page.id)} />
        ))}
      </div>
      <div className="rail-footer">
        <RailItem icon="settings" label="设置" active={current.kind === 'settings'} onClick={onSettings} />
        <span className={`rail-connection ${status.state}`} role="status" title={connectionLabel(status.state, status.attempt, status.error)}>
          <span className="conn-dot" /><span className="sr-only">{connectionLabel(status.state, status.attempt, status.error)}</span>
        </span>
      </div>
    </nav>
  )
}

function RailItem({ icon, label, active, onClick, badge = 0 }: {
  icon: IconName
  label: string
  active: boolean
  onClick: () => void
  badge?: number
}) {
  return (
    <button className={`rail-item ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined} onClick={onClick} title={label}>
      <Icon name={icon} />
      <span className="rail-label">{label}</span>
      {badge > 0 && <span className="rail-badge" aria-label={`${badge} 个待审批`}>{badge}</span>}
    </button>
  )
}

function connectionLabel(state: string, attempt: number, error?: string): string {
  const label = state === 'open' ? '已连接 agent' : state === 'connecting' ? '正在连接…' : state === 'reconnecting' ? `重连中（第 ${attempt} 次）` : '未连接'
  return error === undefined ? label : `${label}：${error}`
}
