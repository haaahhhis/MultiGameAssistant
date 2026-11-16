import { useEffect, useState, type ReactNode } from 'react'
import type { AdgClient } from '@adg/client-core'
import { MAIN, MAIN_AGENT, agentIdOf, agentOf, requestedLabel, useRoles } from '../agents.ts'
import { useSessionHandle, useSessionViews, useStore } from '../hooks.ts'
import { viewsFor } from '../plugins.ts'
import { Composer } from './Composer.tsx'
import { Icon } from './Icons.tsx'
import { SessionTools } from './sessionTools.ts'

export function SessionView({ client, sessionId, reminder, initialPrompt, onInitialSent, onAgent }: {
  client: AdgClient
  sessionId: string
  /** Open an agent's conversation (its name in an earlier conversation's header). */
  onAgent?: (agentId: string) => void
  /** Change an agent the person made. */
  reminder?: ReactNode
  /** Typed on the home page; sent once, as soon as the session is open. */
  initialPrompt?: string | undefined
  onInitialSent?: () => void
}) {
  const session = useSessionHandle(client, sessionId)
  if (session === null) return <div className="main empty">正在打开会话…</div>
  return <OpenSession client={client} session={session} reminder={reminder} initialPrompt={initialPrompt} onInitialSent={onInitialSent} onAgent={onAgent} />
}

/**
 * An earlier conversation (any but an agent's one conversation) can only be
 * read. One that has been working while on screen is not earlier yet: a job
 * just started from a page, where the agent may stop to ask something. It
 * becomes read-only the next time it is opened.
 */
function useReadOnly(item: { home?: string | undefined; blank?: boolean | undefined } | undefined, active: boolean): boolean {
  const [wasActive, setWasActive] = useState(false)
  if (active && !wasActive) setWasActive(true)
  return item !== undefined && item.home === undefined && item.blank !== true && !active && !wasActive
}

function OpenSession({ client, session, reminder, initialPrompt, onInitialSent, onAgent }: {
  client: AdgClient
  session: NonNullable<ReturnType<typeof useSessionHandle>>
  reminder?: ReactNode
  initialPrompt?: string | undefined
  onInitialSent?: (() => void) | undefined
  onAgent?: ((agentId: string) => void) | undefined
}) {
  const state = useStore(session.state)
  const connection = useStore(client.connection.status)
  // Whose session this is: 助手's, or a role agent's (and who asked it to).
  const roles = useRoles(client)
  const item = useStore(client.sessions).items.find(i => i.id === session.id)
  const agentId = item === undefined ? MAIN_AGENT : agentIdOf(item, roles)
  const role = roles.find(r => r.id === agentId)
  const agent = role === undefined ? MAIN : agentOf(role)
  // An agent's one conversation is the agent; any other is an earlier conversation of its.
  const home = item?.home !== undefined
  const views = viewsFor(useSessionViews(client), state)
  const [tab, setTab] = useState(() => readTab())
  const active = views.find(v => v.id === tab) ?? views[0]
  useEffect(() => writeTab(tab), [tab])
  const readOnly = useReadOnly(item, state.running || state.queue.length > 0 || initialPrompt !== undefined)
  // Where the view on screen puts its own controls, beside the tabs.
  const [tools, setTools] = useState<HTMLElement | null>(null)

  return (
    <section className="main">
      <header className="session-header">
        <div className="session-heading">
          {home ? (
            <div className="breadcrumb agent-heading">
              <span className={`agent-avatar small agent-${agent.id}`}><Icon name={agent.icon} /></span>
              <h1>{agent.name}</h1>
            </div>
          ) : (
            <div className="breadcrumb">
              {onAgent !== undefined
                ? <button type="button" className="link-button breadcrumb-link" title={`回到「${agent.name}」的对话`} onClick={() => onAgent(agentId)}>{agent.name}</button>
                : <span>{agent.name}</span>}
              <span className="breadcrumb-divider">/</span>
              <SessionTitle title={state.title} onRename={title => client.renameSession(session.id, title)} />
            </div>
          )}
          <div className="session-meta">
            <RunState running={state.running} />
            {home ? <span>{agent.description}</span> : <span>以前的对话</span>}
            {!home && agentId !== MAIN_AGENT && item?.requestedBy !== undefined && <span>{requestedLabel(item.requestedBy)}</span>}
          </div>
        </div>
        <div className="session-actions">
          <div className="session-tools" ref={setTools} />
          <nav className="tabs" role="tablist" aria-label="会话视图">
            {views.map(view => (
              <button key={view.id} role="tab" aria-selected={view.id === active?.id}
                className={view.id === active?.id ? 'active' : ''} onClick={() => setTab(view.id)}>
                {view.title}
              </button>
            ))}
          </nav>
        </div>
      </header>
      {state.error !== null && <div className="banner error">{state.error}</div>}
      <div className="view">
        {active === undefined
          ? <div className="empty">当前连接没有提供可用的视图插件。</div>
          : <SessionTools.Provider value={tools}><active.component client={client} session={session} state={state} readOnly={readOnly} /></SessionTools.Provider>}
      </div>
      {readOnly ? (
        <div className="session-readonly">
          <Icon name="archive" />
          <span>这是以前的对话，只能查看，不能继续。</span>
          {onAgent !== undefined && <button type="button" className="small-button" onClick={() => onAgent(agentId)}>回到「{agent.name}」的对话</button>}
        </div>
      ) : (
        <>
          <Composer client={client} session={session} running={state.running} disabled={connection.state !== 'open'}
            initialPrompt={initialPrompt} onInitialSent={onInitialSent} reminder={reminder} />
        </>
      )}
    </section>
  )
}

/** The conversation's name; the pencil (or a double-click) edits it in place. Enter saves, Esc cancels. */
function SessionTitle({ title, onRename }: { title: string | null; onRename: (title: string) => Promise<void> }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const shown = title ?? '新会话'
  const save = async () => {
    const next = editing?.trim() ?? ''
    if (next === '' || next === title) { setEditing(null); return }
    try {
      await onRename(next)
      setEditing(null)
      setError(null)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    }
  }
  if (editing !== null) {
    return (
      <span className="title-edit">
        <input className="text-input" autoFocus value={editing} maxLength={80} aria-label="会话名称" onChange={e => setEditing(e.target.value)}
          onFocus={e => e.target.select()}
          onKeyDown={e => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing) void save()
            if (e.key === 'Escape') { setEditing(null); setError(null) }
          }}
          onBlur={() => void save()} />
        {error !== null && <span className="error small">{error}</span>}
      </span>
    )
  }
  return (
    <span className="session-title">
      <h1 title="双击改名" onDoubleClick={() => setEditing(shown)}>{shown}</h1>
      <button type="button" className="icon-button rename-button" title="改名" aria-label="给这个会话改名" onClick={() => setEditing(shown)}><Icon name="pencil" /></button>
    </span>
  )
}

function RunState({ running }: { running: boolean }) {
  return running
    ? <span className="status-pill running"><span className="pill-dot" />运行中</span>
    : <span className="status-pill">空闲</span>
}

const TAB_KEY = 'adg.sessionTab'
function readTab(): string {
  try { return localStorage.getItem(TAB_KEY) ?? 'chat' } catch { return 'chat' }
}
function writeTab(tab: string): void {
  try { localStorage.setItem(TAB_KEY, tab) } catch { /* storage unavailable */ }
}
