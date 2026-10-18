import { useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { useSettingsPages } from '../hooks.ts'
import { setTheme, useTheme, type ThemePreference } from '../theme.ts'
import { Icon, type IconName } from './Icons.tsx'

const PAGE_ICONS: Record<string, IconName> = { 'api-keys': 'key', plugins: 'plug' }
const THEMES: readonly [ThemePreference, string][] = [['light', '浅色'], ['dark', '深色'], ['system', '跟随系统']]

/** Settings take over the sidebar: categories on the left, the page in the main panel. */
export function SettingsView({ client, onClose }: { client: AdgClient; onClose: () => void }) {
  const pages = useSettingsPages(client)
  const theme = useTheme()
  const [selected, setSelected] = useState<string | null>(null)
  const active = pages.find(p => p.id === selected) ?? pages[0]
  return (
    <>
      <aside className="sidebar settings-sidebar">
        <button className="nav-item back-link" onClick={onClose}><Icon name="back" /><span className="nav-item-label">返回</span></button>
        <h1 className="settings-title">设置</h1>
        <nav className="page-list" aria-label="设置分类">
          <div className="sidebar-label">偏好设置</div>
          {pages.map(page => (
            <button key={page.id} className={`nav-item ${page.id === active?.id ? 'active' : ''}`} aria-current={page.id === active?.id ? 'page' : undefined} onClick={() => setSelected(page.id)}>
              <Icon name={PAGE_ICONS[page.id] ?? 'settings'} /><span className="nav-item-label">{page.title}</span>
            </button>
          ))}
        </nav>
        <div className="page-list">
          <div className="sidebar-label" id="theme-label">外观</div>
          <div className="segmented-control" role="radiogroup" aria-labelledby="theme-label">
            {THEMES.map(([value, label]) => (
              <button key={value} role="radio" aria-checked={theme === value} className={theme === value ? 'active' : ''} onClick={() => setTheme(value)}>{label}</button>
            ))}
          </div>
        </div>
      </aside>
      <section className="main settings">
        <div className="settings-content">
          {active === undefined
            ? <div className="empty">当前连接没有提供可配置的项目。</div>
            : <active.component client={client} />}
        </div>
      </section>
    </>
  )
}
