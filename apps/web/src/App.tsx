import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { ModelSelection } from '@adg/protocol'
import type { AdgClient } from '@adg/client-core'
import { DEEPSEEK_API_KEY } from '@adg/protocol'
import { ApprovalDock } from './components/ApprovalDock.tsx'
import { NavRail, type RailTarget } from './components/NavRail.tsx'
import { PoppedView, SessionView } from './components/SessionView.tsx'
import { SettingsView } from './components/SettingsView.tsx'
import { ModelPicker } from './components/ModelPicker.tsx'
import { SessionList, relativeTime, sessionTitle } from './components/SessionList.tsx'
import { Icon, AdgMark } from './components/Icons.tsx'
import { readRoute, writeRoute, type Route } from './config.ts'
import { useCredentials, useModelCatalog, useNow, usePages, useStore } from './hooks.ts'

/** A first message typed on the home page, sent once its new session opens. */
type Handoff = { readonly sessionId: string; readonly text: string }

/**
 * Three-column shell: the navigation rail, then either the chat area (session
 * list + session or home), a plugin page, or settings.
 */
export function App({ client }: { client: AdgClient }) {
  const [route, setRoute] = useState<Route>(() => readRoute())
  const [handoff, setHandoff] = useState<Handoff | null>(null)
  const sessions = useStore(client.sessions)
  const pages = usePages(client)
  const status = useStore(client.connection.status)
  useEffect(() => writeRoute(route), [route])
  // In-app links (an agent reply's [编排页](#/p/pipelines/…)) change the address: follow it.
  useEffect(() => {
    const onHash = () => setRoute(readRoute())
    window.addEventListener('hashchange', onHash)
    return () => window.removeEventListener('hashchange', onHash)
  }, [])

  // Drop a selection that no longer exists once the list has loaded.
  useEffect(() => {
    if (route.kind === 'session' && sessions.loaded && !sessions.items.some(i => i.id === route.id)) setRoute({ kind: 'home' })
  }, [route, sessions])

  const openSession = (id: string) => setRoute({ kind: 'session', id })
  const openSettings = (section?: string) => setRoute({ kind: 'settings', ...(section === undefined ? {} : { section }) })
  const openPage = (id: string) => setRoute({ kind: 'page', id })
  const goHome = () => setRoute({ kind: 'home' })
  const selected = route.kind === 'session' ? route.id : null
  const page = route.kind === 'page' ? pages.find(p => p.id === route.id) : undefined

  if (route.kind === 'window') return <PoppedView client={client} viewId={route.view} sessionId={route.sessionId} />

  const rail: RailTarget = route.kind === 'page' ? { kind: 'page', id: route.id } : route.kind === 'settings' ? { kind: 'settings' } : { kind: 'chat' }
  const chatArea = route.kind === 'home' || route.kind === 'session'

  return (
    <div className={`app ${chatArea || route.kind === 'settings' ? 'with-sidebar' : ''}`}>
      <NavRail client={client} pages={pages} current={rail} onChat={goHome} onPage={openPage} onSettings={() => openSettings()} />
      {route.kind === 'settings' && <SettingsView client={client} onClose={goHome} section={route.section} onSection={id => setRoute({ kind: 'settings', section: id })} />}
      {chatArea && <SessionList client={client} selected={selected} onSelect={openSession} onNew={goHome} />}
      {route.kind === 'page' && (page === undefined
        ? <section className="main empty">{status.state === 'open' ? '当前连接没有提供这个功能。' : '正在连接…'}</section>
        : <page.component key={page.id} client={client} openSession={openSession} openSettings={openSettings} openPage={openPage} arg={route.kind === 'page' ? route.arg : undefined} />)}
      {route.kind === 'home' && (
        <Home client={client} onSettings={() => openSettings('api-keys')} onOpen={openSession}
          onStart={(sessionId, text) => { setHandoff({ sessionId, text }); openSession(sessionId) }} />
      )}
      {route.kind === 'session' && (
        <SessionView
          key={route.id} client={client} sessionId={route.id}
          initialPrompt={handoff?.sessionId === route.id ? handoff.text : undefined}
          onInitialSent={() => setHandoff(null)}
          reminder={<ApiKeyReminder client={client} onSettings={() => openSettings('api-keys')} />}
        />
      )}
      <ApprovalDock client={client} sessionId={selected} onSelect={openSession} />
    </div>
  )
}

const STARTERS = [
  '从 GitHub 安装 MAA，并检查运行环境',
  '分析一下这个脚本目录怎么启动：D:\\Scripts\\',
  '每天凌晨 4:30 跑一遍明日方舟日常',
]

function Home({ client, onSettings, onOpen, onStart }: {
  client: AdgClient
  onSettings: () => void
  onOpen: (sessionId: string) => void
  onStart: (sessionId: string, text: string) => void
}) {
  const sessions = useStore(client.sessions)
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [text, setText] = useState('')
  const [model, setModel] = useState<ModelSelection | undefined>(undefined)
  const capabilities = useStore(client.capabilities)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const recent = sessions.items.filter(item => item.origin !== 'subagent' && !item.blank).slice(0, 4)
  const disabled = status.state !== 'open'

  const start = async () => {
    const value = text.trim()
    if (value === '' || disabled || busy) return
    setBusy(true)
    setError(null)
    try {
      // The conversation is created now, when there is something to say; the chosen model goes with it.
      const sessionId = await client.createSession()
      if (model !== undefined) await client.selectModel(sessionId, model).catch(() => {})
      onStart(sessionId, value)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      void start()
    }
  }

  return (
    <section className="main welcome">
      <header className="welcome-header">
        <span>对话<span className="breadcrumb-divider">/</span><strong>开始</strong></span>
      </header>
      <div className="welcome-content">
        <div className="welcome-hero">
          <p className="eyebrow">AUTO DAILY GAMEPLAY</p>
          <h1>今天要跑点什么？</h1>
          <p className="welcome-description">安装脚本、读懂它怎么用、编排多个脚本一起跑，出了问题帮你看。用一句话告诉 agent 就行。</p>
        </div>

        <div className="composer-box hero-composer">
          <textarea
            ref={area}
            aria-label="描述你想完成的事"
            value={text}
            onChange={e => setText(e.target.value)}
            onKeyDown={onKeyDown}
            rows={3}
            placeholder={disabled ? '未连接到 agent' : '例如：帮我清一下明日方舟日常，刷 1-7，不吃药'}
            disabled={disabled}
          />
          <div className="composer-actions">
            {capabilities.has('models') && <ModelPicker client={client} disabled={disabled || busy} value={model} onChange={setModel} />}
            {error !== null && <span className="error small">{error}</span>}
            <span className="spacer" />
            <span className="composer-kbd"><kbd>Enter</kbd> 开始</span>
            <button className="send-button" aria-label="开始会话" onClick={() => void start()} disabled={disabled || busy || text.trim() === ''}>
              <Icon name="arrow" />
            </button>
          </div>
        </div>

        <div className="starters">
          {STARTERS.map(starter => (
            <button key={starter} className="starter" onClick={() => { setText(starter); area.current?.focus() }}>
              <Icon name="chevron" />{starter}
            </button>
          ))}
        </div>

        <ApiKeyReminder client={client} onSettings={onSettings} />

        {recent.length > 0 && (
          <div className="resume">
            <div className="resume-head"><span className="sidebar-label">继续上次</span></div>
            {recent.map(item => (
              <button key={item.id} className="resume-item" onClick={() => onOpen(item.id)}>
                <span className="resume-text">
                  <span className="resume-title">{sessionTitle(item)}</span>
                  {item.cwd !== undefined && <span className="resume-path">{item.cwd}</span>}
                </span>
                <span className="session-time">{item.running ? '运行中' : relativeTime(item.updatedAt, now)}</span>
              </button>
            ))}
          </div>
        )}
      </div>
    </section>
  )
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
          <p className="eyebrow">AUTO DAILY GAMEPLAY</p>
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
