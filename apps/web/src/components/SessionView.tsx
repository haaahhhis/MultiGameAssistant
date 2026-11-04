import { useEffect, useState, type ReactNode } from 'react'
import type { AdgClient } from '@adg/client-core'
import { MAIN, MAIN_AGENT, agentIdOf, agentOf, requestedLabel, useHandOffs, useRoles } from '../agents.ts'
import { exchangeHref } from '../plugins/chat/Delegation.tsx'
import { popoutUrl } from '../config.ts'
import { useSessionHandle, useSessionViews, useStore } from '../hooks.ts'
import { viewsFor } from '../plugins.ts'
import { Composer } from './Composer.tsx'
import { Icon } from './Icons.tsx'

export function SessionView({ client, sessionId, reminder, initialPrompt, onInitialSent, onAgent, onEdit }: {
  client: AdgClient
  sessionId: string
  /** Open an agent's conversation (its name in an earlier conversation's header). */
  onAgent?: (agentId: string) => void
  /** Change an agent the person made. */
  onEdit?: (agentId: string) => void
  reminder?: ReactNode
  /** Typed on the home page; sent once, as soon as the session is open. */
  initialPrompt?: string | undefined
  onInitialSent?: () => void
}) {
  const session = useSessionHandle(client, sessionId)
  if (session === null) return <div className="main empty">正在打开会话…</div>
  return <OpenSession client={client} session={session} reminder={reminder} initialPrompt={initialPrompt} onInitialSent={onInitialSent} onAgent={onAgent} onEdit={onEdit} />
}

function OpenSession({ client, session, reminder, initialPrompt, onInitialSent, onAgent, onEdit }: {
  client: AdgClient
  session: NonNullable<ReturnType<typeof useSessionHandle>>
  reminder?: ReactNode
  initialPrompt?: string | undefined
  onInitialSent?: (() => void) | undefined
  onAgent?: ((agentId: string) => void) | undefined
  onEdit?: ((agentId: string) => void) | undefined
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
  // Work another agent handed here, still going: the two agents are talking, the person watches (§11).
  const handOffs = useHandOffs(client, session.id)
  const watching = handOffs.find(h => h.toSession === session.id && h.state === 'running')
  const [tab, setTab] = useState(() => readTab())
  const active = views.find(v => v.id === tab) ?? views[0]
  useEffect(() => writeTab(tab), [tab])

  return (
    <section className="main">
      <header className="session-header">
        <div className="session-heading">
          {home ? (
            <div className="breadcrumb agent-heading">
              <span className={`agent-avatar small agent-${agent.id}`}><Icon name={agent.icon} /></span>
              <h1>{agent.name}</h1>
              {role?.custom === true && onEdit !== undefined && (
                <button type="button" className="icon-button rename-button" title="编辑这个 agent" aria-label="编辑这个 agent" onClick={() => onEdit(agentId)}><Icon name="pencil" /></button>
              )}
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
          <nav className="tabs" role="tablist" aria-label="会话视图">
            {views.map(view => (
              <button key={view.id} role="tab" aria-selected={view.id === active?.id}
                className={view.id === active?.id ? 'active' : ''} onClick={() => setTab(view.id)}>
                {view.title}
              </button>
            ))}
          </nav>
          {active !== undefined && (
            <button className="icon-button popout-button" title={`在新窗口打开「${active.title}」`} aria-label={`在新窗口打开「${active.title}」`}
              onClick={() => window.open(popoutUrl(active.id, session.id), `dsh-${active.id}-${session.id}`)}>
              <Icon name="popout" />
            </button>
          )}
        </div>
      </header>
      {state.error !== null && <div className="banner error">{state.error}</div>}
      <div className="view">
        {active === undefined
          ? <div className="empty">当前连接没有提供可用的视图插件。</div>
          : <active.component client={client} session={session} state={state} />}
      </div>
      {reminder}
      {watching !== undefined ? (
        <footer className="watch-only">
          <Icon name="info" />
          <span>{watching.by}交给{agent.name}的事还在做：{watching.title}。做完之前你只能旁观。</span>
          <a className="small-button" href={exchangeHref(watching)}>看它们的交流</a>
          {state.running && <button className="small-button" onClick={() => void session.cancel()}>停止</button>}
        </footer>
      ) : (
        <Composer client={client} session={session} running={state.running} disabled={connection.state !== 'open'}
          initialPrompt={initialPrompt} onInitialSent={onInitialSent} />
      )}
    </section>
  )
}

/** One session view on its own, for a popped-out window: no sidebar, no composer. */
export function PoppedView({ client, viewId, sessionId }: { client: AdgClient; viewId: string; sessionId: string }) {
  const session = useSessionHandle(client, sessionId)
  const views = useSessionViews(client)
  const connection = useStore(client.connection.status)
  const view = views.find(v => v.id === viewId)
  if (session === null || view === undefined) {
    return <div className="popped"><section className="main empty">{connection.state === 'open' && view === undefined ? '当前连接没有提供这个视图。' : '正在打开…'}</section></div>
  }
  return <PoppedSession client={client} session={session} view={view} />
}

function PoppedSession({ client, session, view }: {
  client: AdgClient
  session: NonNullable<ReturnType<typeof useSessionHandle>>
  view: ReturnType<typeof useSessionViews>[number]
}) {
  const state = useStore(session.state)
  useEffect(() => { document.title = `${view.title} · ${state.title ?? '会话'}` }, [view.title, state.title])
  return (
    <div className="popped">
      <section className="main">
        <header className="session-header">
          <div className="session-heading">
            <div className="breadcrumb"><span>{view.title}</span><span className="breadcrumb-divider">/</span><h1>{state.title ?? '新会话'}</h1></div>
            <div className="session-meta"><RunState running={state.running} /><span>与主窗口同步更新</span></div>
          </div>
        </header>
        {state.error !== null && <div className="banner error">{state.error}</div>}
        <div className="view"><view.component client={client} session={session} state={state} /></div>
      </section>
    </div>
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
