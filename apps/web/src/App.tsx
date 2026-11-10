import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AdgClient } from '@adg/client-core'
import { DEEPSEEK_API_KEY } from '@adg/protocol'
import { ApprovalDock } from './components/ApprovalDock.tsx'
import { ScriptUpdateNotes } from './components/ScriptUpdates.tsx'
import { NavRail, type RailTarget } from './components/NavRail.tsx'
import { PoppedView, SessionView } from './components/SessionView.tsx'
import { SettingsView } from './components/SettingsView.tsx'
import { AgentHistory, useHasEarlier } from './components/SessionList.tsx'
import { useShowEarlier } from './preferences.ts'
import { AgentSchedule, ScheduleOverview } from './components/AgentSchedule.tsx'
import { HandOffPage } from './plugins/chat/Delegation.tsx'
import { MAIN, MAIN_AGENT, agentIdOf, agentOf, useHome, useRoles } from './agents.ts'
import type { PageContribution } from './plugins.ts'
import { UiSwitch } from './components/UiSwitch.tsx'
import { Icon, AdgMark } from './components/Icons.tsx'
import { readRoute, writeRoute, type AgentTab, type Route } from './config.ts'
import { useCredentials, useModelCatalog, usePages, useStore } from './hooks.ts'

/** The page the app opens on. */
const START_PAGE = 'games'

/**
 * Two-column shell: the navigation rail (游戏, then each agent), then the
 * open agent's tabs — its one conversation, its timed tasks, the pages it
 * owns (脚本, 运行, 编排…), its earlier conversations (docs/design/
 * agent-roles.md §10–§12) — or a plugin page, or settings.
 */
export function App({ client }: { client: AdgClient }) {
  const [route, setRoute] = useState<Route>(() => readRoute())
  const sessions = useStore(client.sessions)
  const pages = usePages(client)
  const status = useStore(client.connection.status)
  const roles = useRoles(client)
  // Each page is a history entry (mouse back / forward); a correction replaces the entry instead.
  const replacing = useRef(false)
  // Where to go back to when an exchange between two agents is closed.
  const beforeExchange = useRef<Route | null>(null)
  useEffect(() => {
    writeRoute(route, replacing.current ? 'replace' : 'push')
    replacing.current = false
    if (route.kind !== 'handoff' && route.kind !== 'window') beforeExchange.current = route
  }, [route])
  // Two agents' exchange takes the place of the page that was on screen, which stays there, hidden,
  // as it was: taking it away and opening it again when the exchange closed is what made the chat flash.
  const exchange = route.kind === 'handoff' ? route : null
  const under = beforeExchange.current
  const view: Route = exchange === null ? route : under !== null && under.kind !== 'settings' ? under : { kind: 'agent', id: MAIN_AGENT }
  // Back / forward, and in-app links (an agent reply's [编排页](#/p/pipelines/…)), change the address: follow it.
  useEffect(() => {
    const onHash = () => setRoute(readRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Drop a selection that no longer exists once the list has loaded. A session another
  // part of the app just created (「让 agent 进游戏读取」) may not be listed yet: give it a moment.
  const listed = useRef(new Set<string>())
  useEffect(() => {
    for (const item of sessions.items) listed.current.add(item.id)
    if (route.kind !== 'session' || !sessions.loaded || sessions.items.some(i => i.id === route.id)) return
    const leave = () => { replacing.current = true; setRoute(r => (r.kind === 'session' && r.id === route.id ? { kind: 'home' } : r)) }
    if (listed.current.has(route.id)) { leave(); return }
    const timer = setTimeout(leave, 8000)
    return () => clearTimeout(timer)
  }, [route, sessions])

  // Just opened: the games page is the main one; chat when this connection has no games.
  useEffect(() => {
    if (route.kind !== 'start' || status.state !== 'open') return
    replacing.current = true
    setRoute(pages.some(p => p.id === START_PAGE) ? { kind: 'page', id: START_PAGE } : { kind: 'home' })
  }, [route, status.state, pages])

  // The switch is off while the address still says 以前的对话: the agent's conversation instead.
  const showEarlier = useShowEarlier()
  const agentRouteTab = view.kind === 'agent' && (view.tab !== 'history' || showEarlier) ? view.tab : undefined
  const openSession = (id: string) => setRoute({ kind: 'session', id })
  const openSettings = (section?: string) => setRoute({ kind: 'settings', ...(section === undefined ? {} : { section }) })
  const openPage = (id: string) => setRoute({ kind: 'page', id })
  const selected = view.kind === 'session' ? view.id : null
  const selectedItem = selected === null ? undefined : sessions.items.find(i => i.id === selected)
  const shown: Route = view.kind === 'start' ? { kind: 'page', id: START_PAGE } : view
  const page = shown.kind === 'page' ? pages.find(p => p.id === shown.id) : undefined
  // A page an agent owns is one of its tabs; under 助手 while that agent is gone.
  const ownerOf = (p: PageContribution) => (p.agent === undefined ? undefined : roles.some(r => r.id === p.agent) ? p.agent : MAIN_AGENT)
  const pageOwner = page === undefined ? undefined : ownerOf(page)
  const openAgent = (id: string) => setRoute({ kind: 'agent', id })
  const goHome = () => openAgent(MAIN_AGENT)
  const reminder = <><ApiKeyReminder client={client} onSettings={() => openSettings('api-keys')} /><ScriptUpdateNotes client={client} /></>
  // The agent in front, whose tabs show: its conversation or tab, an earlier conversation of its, a page it owns.
  const tabAgent = view.kind === 'home' ? MAIN_AGENT : view.kind === 'agent' ? view.id
    : view.kind === 'session' ? (selectedItem === undefined ? undefined : agentIdOf(selectedItem, roles)) : pageOwner
  const agentTab = (id: string, tab: string) => setRoute(tab === 'chat' ? { kind: 'agent', id } : tab === 'schedule' || tab === 'history' ? { kind: 'agent', id, tab } : { kind: 'page', id: tab })

  if (route.kind === 'window') return <PoppedView client={client} viewId={route.view} sessionId={route.sessionId} />

  const rail: RailTarget = view.kind === 'settings' ? { kind: 'settings' } : view.kind === 'schedule' ? { kind: 'schedule' }
    : tabAgent !== undefined ? { kind: 'agent', id: tabAgent }
    : shown.kind === 'page' ? { kind: 'page', id: shown.id } : { kind: 'none' }
  const pageView = page === undefined ? null
    : <page.component key={page.id} client={client} openSession={openSession} openSettings={openSettings} openPage={openPage} arg={shown.kind === 'page' ? shown.arg : undefined} />
  const agentTabs = tabAgent === undefined ? null : (
    <AgentTabs client={client} agentId={tabAgent} pages={pages.filter(p => ownerOf(p) === tabAgent)}
      current={agentRouteTab !== undefined ? agentRouteTab : view.kind === 'session' ? 'history' : shown.kind === 'page' ? shown.id : 'chat'}
      onTab={tab => agentTab(tabAgent, tab)} />
  )

  return (
    <div className={`app ${view.kind === 'settings' ? 'with-sidebar' : ''}`}>
      <NavRail client={client} pages={pages.filter(p => p.agent === undefined)} current={rail} onAgent={openAgent} onPage={openPage}
        onSchedule={() => setRoute({ kind: 'schedule' })} onSettings={() => openSettings()} />
      {view.kind === 'settings' && <SettingsView client={client} onClose={goHome} section={view.section} onSection={id => setRoute({ kind: 'settings', section: id })} />}
      {view.kind !== 'settings' && (
        // The main column; an exchange between two agents goes over what is there, in the same place.
        <div className={`app-main ${exchange === null ? '' : 'under-exchange'}`}>
          {shown.kind === 'page' && pageOwner === undefined && (pageView
            ?? <section className="main empty">{status.state === 'open' ? '当前连接没有提供这个功能。' : '正在连接…'}</section>)}
          {tabAgent !== undefined && (
            <div className="agent-area">
              {agentTabs}
              {pageOwner !== undefined ? pageView
                : view.kind === 'agent' && agentRouteTab === 'schedule' ? <AgentSchedule key={view.id} client={client} agentId={view.id} />
                : view.kind === 'agent' && agentRouteTab === 'history' ? <AgentHistory key={view.id} client={client} agentId={view.id} onSelect={openSession} />
                : view.kind === 'session' ? <SessionView key={view.id} client={client} sessionId={view.id} onAgent={openAgent} reminder={reminder} />
                : <AgentConversation key={tabAgent} client={client} agentId={tabAgent} onMain={goHome} onAgent={openAgent} reminder={reminder} />}
            </div>
          )}
          {view.kind === 'schedule' && <ScheduleOverview client={client} onAgent={id => setRoute({ kind: 'agent', id, tab: 'schedule' })} />}
          {view.kind === 'session' && tabAgent === undefined && (
            <SessionView key={view.id} client={client} sessionId={view.id} onAgent={openAgent} reminder={reminder} />
          )}
          {exchange !== null && <HandOffPage key={exchange.id} client={client} id={exchange.id} onClose={() => setRoute(view)} />}
        </div>
      )}
      <ApprovalDock client={client} sessionId={selected} onSelect={openSession} />
      <UiSwitch />
    </div>
  )
}

/** The open agent's tabs: its conversation, its timed tasks, the pages it owns. */
function AgentTabs({ client, agentId, pages, current, onTab }: {
  client: AdgClient
  agentId: string
  pages: readonly PageContribution[]
  current: string
  onTab: (tab: string) => void
}) {
  const roles = useRoles(client)
  const capabilities = useStore(client.capabilities)
  const role = roles.find(r => r.id === agentId)
  const agent = role === undefined ? MAIN : agentOf(role)
  const hasEarlier = useHasEarlier(client, agentId)
  const earlier = useShowEarlier() && (hasEarlier || current === 'history')
  const tabs = [
    { id: 'chat', title: '对话', icon: 'chat' as const },
    ...(capabilities.has('pipelines') ? [{ id: 'schedule', title: '定时', icon: 'calendar' as const }] : []),
    ...[...pages].sort((a, b) => a.order - b.order).map(p => ({ id: p.id, title: p.title, icon: p.icon })),
    ...(earlier ? [{ id: 'history' satisfies AgentTab, title: '以前的对话', icon: 'archive' as const }] : []),
  ]
  if (tabs.length === 1) return null
  return (
    <nav className="agent-tabs" role="tablist" aria-label={agent.name}>
      {tabs.map(tab => (
        <button key={tab.id} role="tab" aria-selected={tab.id === current} className={tab.id === current ? 'active' : ''} onClick={() => onTab(tab.id)}>
          <Icon name={tab.icon} />{tab.title}
        </button>
      ))}
    </nav>
  )
}

/** An agent's one conversation (`agents/home`): made the first time it is opened. */
function AgentConversation({ client, agentId, onMain, onAgent, reminder }: {
  client: AdgClient
  agentId: string
  onMain: () => void
  onAgent: (agentId: string) => void
  reminder: ReactNode
}) {
  const { sessionId, error } = useHome(client, agentId)
  if (error !== null) {
    return <section className="main empty"><span>{error}<button className="link-button" onClick={onMain}>回到助手</button></span></section>
  }
  if (sessionId === null) return <section className="main empty">正在打开…</section>
  return <SessionView key={sessionId} client={client} sessionId={sessionId} onAgent={onAgent} reminder={reminder} />
}

/**
 * Shown while no model can be called: the DeepSeek key is missing and no
 * custom API (Claude, ChatGPT, …) supplies models either.
 */
export function ApiKeyReminder({ client, onSettings }: { client: AdgClient; onSettings: () => void }) {
  const { items } = useCredentials(client, [DEEPSEEK_API_KEY])
  const { catalog } = useModelCatalog(client)
  const custom = catalog?.groups.some(g => g.id !== 'deepseek-official' && g.models.length > 0) ?? false
  if (items?.[DEEPSEEK_API_KEY]?.configured !== false || custom) return null
  return (
    <div className="reminder">
      <Icon name="key" />
      <span>还没有可用的模型：请填写 DeepSeek API Key，或添加一个自定义 API（Claude、ChatGPT 等）。</span>
      <button className="primary small-button" onClick={onSettings}>去设置</button>
    </div>
  )
}

export function TokenPrompt({ onSubmit }: { onSubmit: (token: string) => void }) {
  const [token, setToken] = useState('')
  return (
    <div className="token-prompt">
      <form onSubmit={e => { e.preventDefault(); if (token.trim() !== '') onSubmit(token.trim()) }}>
        <AdgMark size="lg" />
        <div className="token-heading">
          <p className="eyebrow">MULTI GAME ASSISTANT</p>
          <h1>连接 agent</h1>
          <p className="muted">输入后端启动时打印的连接 token（<code>adg gateway: …?token=</code> 后面的部分）。</p>
        </div>
        <label className="field-label" htmlFor="adg-token">连接 Token</label>
        <input id="adg-token" className="text-input" autoFocus value={token} onChange={e => setToken(e.target.value)} placeholder="粘贴连接 token" />
        <button className="primary" type="submit" disabled={token.trim() === ''}>连接</button>
      </form>
    </div>
  )
}
