import { useEffect, useRef, useState, type ReactNode } from 'react'
import type { AdgClient } from '@adg/client-core'
import { DEEPSEEK_API_KEY } from '@adg/protocol'
import { ApprovalDock } from './components/ApprovalDock.tsx'
import { NavRail, type RailTarget } from './components/NavRail.tsx'
import { PoppedView, SessionView } from './components/SessionView.tsx'
import { SettingsView } from './components/SettingsView.tsx'
import { AgentRoster } from './components/SessionList.tsx'
import { AgentEditor } from './components/AgentEditor.tsx'
import { MAIN_AGENT, agentIdOf, useHome, useRoles } from './agents.ts'
import { UiSwitch } from './components/UiSwitch.tsx'
import { Icon, AdgMark } from './components/Icons.tsx'
import { readRoute, writeRoute, type Route } from './config.ts'
import { useCredentials, useModelCatalog, usePages, useStore } from './hooks.ts'

/** The page the app opens on. */
const START_PAGE = 'games'

/**
 * Three-column shell: the navigation rail, then either the chat area (the
 * agents + one agent's conversation, docs/design/agent-roles.md §10), a
 * plugin page, or settings.
 */
export function App({ client }: { client: AdgClient }) {
  const [route, setRoute] = useState<Route>(() => readRoute())
  const sessions = useStore(client.sessions)
  const pages = usePages(client)
  const status = useStore(client.connection.status)
  const roles = useRoles(client)
  // Each page is a history entry (mouse back / forward); a correction replaces the entry instead.
  const replacing = useRef(false)
  useEffect(() => {
    writeRoute(route, replacing.current ? 'replace' : 'push')
    replacing.current = false
  }, [route])
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

  const openSession = (id: string) => setRoute({ kind: 'session', id })
  const openSettings = (section?: string) => setRoute({ kind: 'settings', ...(section === undefined ? {} : { section }) })
  const openPage = (id: string) => setRoute({ kind: 'page', id })
  const selected = route.kind === 'session' ? route.id : null
  const selectedItem = selected === null ? undefined : sessions.items.find(i => i.id === selected)
  // The agent in front: its conversation, the agent of the open session, else 助手.
  const agent = route.kind === 'agent' ? route.id : route.kind === 'agentEdit' ? route.id ?? '' : selectedItem !== undefined ? agentIdOf(selectedItem, roles) : MAIN_AGENT
  const openAgent = (id: string) => setRoute({ kind: 'agent', id })
  const goHome = () => openAgent(MAIN_AGENT)
  const editAgent = (id: string) => setRoute({ kind: 'agentEdit', id })
  const reminder = <ApiKeyReminder client={client} onSettings={() => openSettings('api-keys')} />
  const shown: Route = route.kind === 'start' ? { kind: 'page', id: START_PAGE } : route
  const page = shown.kind === 'page' ? pages.find(p => p.id === shown.id) : undefined

  if (route.kind === 'window') return <PoppedView client={client} viewId={route.view} sessionId={route.sessionId} />

  const rail: RailTarget = shown.kind === 'page' ? { kind: 'page', id: shown.id } : route.kind === 'settings' ? { kind: 'settings' } : { kind: 'chat' }
  const chatArea = route.kind === 'home' || route.kind === 'session' || route.kind === 'agent' || route.kind === 'agentEdit'

  return (
    <div className={`app ${chatArea || route.kind === 'settings' ? 'with-sidebar' : ''}`}>
      <NavRail client={client} pages={pages} current={rail} onChat={goHome} onPage={openPage} onSettings={() => openSettings()} />
      {route.kind === 'settings' && <SettingsView client={client} onClose={goHome} section={route.section} onSection={id => setRoute({ kind: 'settings', section: id })} />}
      {chatArea && <AgentRoster client={client} agent={agent} selected={selected} onAgent={openAgent} onSelect={openSession}
        onNewAgent={() => setRoute({ kind: 'agentEdit', id: null })} />}
      {shown.kind === 'page' && (page === undefined
        ? <section className="main empty">{status.state === 'open' ? '当前连接没有提供这个功能。' : '正在连接…'}</section>
        : <page.component key={page.id} client={client} openSession={openSession} openSettings={openSettings} openPage={openPage} arg={shown.kind === 'page' ? shown.arg : undefined} />)}
      {(route.kind === 'home' || route.kind === 'agent') && (
        <AgentConversation key={route.kind === 'agent' ? route.id : MAIN_AGENT} client={client} agentId={route.kind === 'agent' ? route.id : MAIN_AGENT}
          onMain={goHome} onAgent={openAgent} onEdit={editAgent} reminder={reminder} />
      )}
      {route.kind === 'agentEdit' && (
        <AgentEditor key={route.id ?? 'new'} client={client} agentId={route.id}
          onSaved={id => { replacing.current = true; setRoute({ kind: 'agent', id }) }}
          onCancel={() => (route.id === null ? goHome() : setRoute({ kind: 'agent', id: route.id }))}
          onDeleted={() => { replacing.current = true; goHome() }} />
      )}
      {route.kind === 'session' && (
        <SessionView key={route.id} client={client} sessionId={route.id} onAgent={openAgent} onEdit={editAgent} reminder={reminder} />
      )}
      <ApprovalDock client={client} sessionId={selected} onSelect={openSession} />
      <UiSwitch />
    </div>
  )
}

/** An agent's one conversation (`agents/home`): made the first time it is opened. */
function AgentConversation({ client, agentId, onMain, onAgent, onEdit, reminder }: {
  client: AdgClient
  agentId: string
  onMain: () => void
  onAgent: (agentId: string) => void
  onEdit: (agentId: string) => void
  reminder: ReactNode
}) {
  const { sessionId, error } = useHome(client, agentId)
  if (error !== null) {
    return <section className="main empty"><span>{error}<button className="link-button" onClick={onMain}>回到助手</button></span></section>
  }
  if (sessionId === null) return <section className="main empty">正在打开…</section>
  return <SessionView key={sessionId} client={client} sessionId={sessionId} onAgent={onAgent} onEdit={onEdit} reminder={reminder} />
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
