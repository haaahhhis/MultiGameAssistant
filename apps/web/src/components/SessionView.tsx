import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { buildChat, type AdgClient, type ChatItem } from '@adg/client-core'
import { MAIN, MAIN_AGENT, agentIdOf, agentOf, requestedLabel, useRoles } from '../agents.ts'
import { useSessionHandle, useSessionViews, useStore } from '../hooks.ts'
import { viewsFor } from '../plugins.ts'
import { desktop } from '../desktop.ts'
import { BrowserPanel } from './BrowserPanel.tsx'
import { Composer } from './Composer.tsx'
import { Icon } from './Icons.tsx'
import { SideBar } from './sessionTools.ts'
import { CommandsPanel, SIDE_PANELS, SidePanelHost, TasksPanel, commandsOf, type SidePanelId } from './SidePanels.tsx'
import { SubAgentPane, settledTasks, subAgentIds, taskLabels, useSubAgents, type OpenTask } from '../plugins/chat/SubTasks.tsx'

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
  const side = useSidePanel()
  const subAgents = useSubAgents(client, session.id)
  const runningTasks = subAgents.filter(t => t.running).length
  // The chat once more, for the sub-tasks' names and the commands: only while a panel that shows them is open.
  const needsChat = side.panel === 'tasks' || side.panel === 'commands'
  const built = useMemo(
    () => needsChat ? buildChat(state.events, state.live, state.pending) : NO_ITEMS,
    // `version` covers in-place live appends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [needsChat, state.events, state.live, state.pending, state.version],
  )
  const childIds = useMemo(() => subAgentIds(state.events), [state.events])
  const labels = useMemo(() => taskLabels(built, childIds), [built, childIds])
  const settled = useMemo(() => settledTasks(built, childIds), [built, childIds])
  const own = useMemo(() => commandsOf(built), [built])
  const sideBar = useMemo(() => ({ openTask: side.openTask }), [side.openTask])
  // Up in the window's title bar, left of its buttons, as the Claude app has them (elsewhere, the page's strip in its place).
  const tools = (
    <div className="title-tools in-title-bar" role="toolbar" aria-label="侧栏">
      {SIDE_PANELS.filter(p => p.id !== 'browser' || side.bridge !== undefined).map(p => {
        const on = side.panel === p.id
        const hint = p.id === 'tasks' && runningTasks > 0 ? `子任务：${runningTasks} 个进行中`
          : p.id === 'browser' && side.working ? 'agent 正在操作内置浏览器' : p.hint
        return (
          <button key={p.id} type="button" className={`side-icon${on ? ' active' : ''}`} aria-pressed={on} aria-label={p.title} title={hint}
            onClick={() => side.setPanel(on ? null : p.id)}>
            <Icon name={p.icon} />
            {p.id === 'tasks' && runningTasks > 0 && <span className="side-icon-badge">{runningTasks}</span>}
            {p.id === 'browser' && side.working && <span className="side-icon-dot" />}
          </button>
        )
      })}
      <ViewMenu views={views} onSelect={setTab} />
    </div>
  )

  return (
    <section className="main">
      {/* An earlier conversation says whose it is and what it is called; an agent's own one needs no header. */}
      {!home && (
        <div className="session-bar">
          {!home && (
            <div className="breadcrumb session-crumb">
              {onAgent !== undefined
                ? <button type="button" className="link-button breadcrumb-link" title={`回到「${agent.name}」的对话`} onClick={() => onAgent(agentId)}>{agent.name}</button>
                : <span>{agent.name}</span>}
              <span className="breadcrumb-divider">/</span>
              <SessionTitle title={state.title} onRename={title => client.renameSession(session.id, title)} />
              <span className="session-crumb-note">以前的对话{agentId !== MAIN_AGENT && item?.requestedBy !== undefined ? ` · ${requestedLabel(item.requestedBy)}` : ''}</span>
            </div>
          )}
        </div>
      )}
      {createPortal(tools, document.body)}
      {state.error !== null && <div className="banner error">{state.error}</div>}
      <div className={`session-body${side.panel !== null ? ' with-side' : ''}`}>
        <div className="session-column">
          <div className="view">
            {/* Another view (轨迹) in the conversation's place: back to it. */}
            {active !== undefined && views[0] !== undefined && active.id !== views[0].id && (
              <div className="view-back">
                <button type="button" className="small-button" onClick={() => setTab(views[0]!.id)}><Icon name="back" />返回{views[0].title}</button>
                <span className="view-back-title">{active.title}</span>
              </div>
            )}
            {active === undefined
              ? <div className="empty">当前连接没有提供可用的视图插件。</div>
              : <SideBar.Provider value={sideBar}><active.component client={client} session={session} state={state} readOnly={readOnly} /></SideBar.Provider>}
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
        </div>
        {side.panel !== null && (
          <div className={`side-slot side-${side.panel}`}>
            {side.panel === 'browser' && side.bridge !== undefined
              ? <BrowserPanel bridge={side.bridge} onClose={() => side.setPanel(null)} />
              : side.panel === 'tasks' && side.task !== null
              // Its close goes back to the list.
              ? <SideBar.Provider value={sideBar}><SubAgentPane key={side.task.id} client={client} task={side.task} parent={agent.name} trail={agentId === MAIN_AGENT ? [] : [MAIN.name]} onClose={() => side.openTask(null)} /></SideBar.Provider>
              : side.panel === 'tasks'
              ? <SidePanelHost title="子任务" onClose={() => side.setPanel(null)}><TasksPanel tasks={subAgents} labels={labels} settled={settled} onOpen={side.openTask} /></SidePanelHost>
              : <SidePanelHost title="命令" onClose={() => side.setPanel(null)}><CommandsPanel client={client} own={own} tasks={subAgents} labels={labels} /></SidePanelHost>}
          </div>
        )}
      </div>
    </section>
  )
}

const NO_ITEMS: readonly ChatItem[] = []

/**
 * The sidebar beside the conversation: which panel is open (kept in this
 * browser), and the sub-task open in it. The browser comes up by itself when
 * an agent starts working in it, unless another panel is open or the user
 * closed the browser in the last minutes.
 */
function useSidePanel() {
  const bridge = desktop()?.browser
  const [chosen, setChosen] = useState<SidePanelId | null>(() => readPanel())
  const panel = chosen === 'browser' && bridge === undefined ? null : chosen
  const [task, setTask] = useState<OpenTask | null>(null)
  const browserClosedAt = useRef(0)
  const current = useRef(panel)
  current.current = panel
  const setPanel = (next: SidePanelId | null) => {
    if (current.current === 'browser' && next !== 'browser') browserClosedAt.current = Date.now()
    setChosen(next)
    setTask(null)
    writePanel(next)
  }
  // Stable: the chat's cards open sub-tasks with it.
  const openTask = useMemo(() => (next: OpenTask | null) => {
    setTask(next)
    if (next !== null) { setChosen('tasks'); writePanel('tasks') }
  }, [])
  // When an agent last acted in the browser, for the icon's dot.
  const [agentAt, setAgentAt] = useState(0)
  useEffect(() => {
    if (bridge === undefined) return
    let seen: number | undefined
    return bridge.onChange(state => {
      const started = seen !== undefined && state.agentAt > seen
      seen = state.agentAt
      setAgentAt(state.agentAt)
      if (started && current.current === null && Date.now() - browserClosedAt.current > AUTO_OPEN_QUIET_MS) setChosen('browser')
    })
  }, [bridge])
  const working = Date.now() - agentAt < WORKING_MS
  // The dot goes once the agent has been quiet a while: draw again then.
  const [, redraw] = useState(0)
  useEffect(() => {
    if (!working) return
    const timer = setTimeout(() => redraw(n => n + 1), agentAt + WORKING_MS - Date.now() + 50)
    return () => clearTimeout(timer)
  }, [working, agentAt])
  return { bridge, panel, setPanel, task: panel === 'tasks' ? task : null, openTask, working }
}

const PANEL_KEY = 'adg.sidePanel'
/** Closed by the user this recently: the agent's work does not bring it back. */
const AUTO_OPEN_QUIET_MS = 3 * 60_000
/** An agent acted in the browser this recently: it is working there. */
const WORKING_MS = 5_000
function readPanel(): SidePanelId | null {
  try {
    const saved = localStorage.getItem(PANEL_KEY)
    // Before the sidebar, the browser alone was kept open or not.
    if (saved === null) return localStorage.getItem('adg.browserPanel') === '1' ? 'browser' : null
    return SIDE_PANELS.some(p => p.id === saved) ? saved as SidePanelId : null
  } catch { return null }
}
function writePanel(panel: SidePanelId | null): void {
  try { localStorage.setItem(PANEL_KEY, panel ?? '') } catch { /* storage unavailable */ }
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

/**
 * The … at the end of the title bar's icons: the conversation's other views
 * (轨迹). One opens in the conversation's place, with 返回 back to it.
 */
function ViewMenu({ views, onSelect }: { views: readonly { id: string; title: string }[]; onSelect: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (root.current?.contains(e.target as Node) !== true) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])
  // The first view is the conversation itself; the menu offers the others.
  const others = views.slice(1)
  if (others.length === 0) return null
  return (
    <div className="view-menu" ref={root}>
      <button type="button" className={`side-icon${open ? ' active' : ''}`} aria-haspopup="menu" aria-expanded={open} aria-label="更多" title="更多" onClick={() => setOpen(!open)}>
        <Icon name="more" />
      </button>
      {open && (
        <div className="view-menu-list" role="menu">
          {others.map(view => (
            <button key={view.id} type="button" role="menuitem" onClick={() => { onSelect(view.id); setOpen(false) }}>
              <Icon name={view.id === 'trajectory' ? 'flow' : 'eye'} />{view.title}
            </button>
          ))}
        </div>
      )}
    </div>
  )
}

const TAB_KEY = 'adg.sessionTab'
function readTab(): string {
  try { return localStorage.getItem(TAB_KEY) ?? 'chat' } catch { return 'chat' }
}
function writeTab(tab: string): void {
  try { localStorage.setItem(TAB_KEY, tab) } catch { /* storage unavailable */ }
}
