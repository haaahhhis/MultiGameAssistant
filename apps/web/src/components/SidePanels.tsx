import { useMemo, useState, type ReactNode } from 'react'
import { buildChat, type AdgClient, type ChatItem } from '@adg/client-core'
import type { SessionItem } from '@adg/protocol'
import { useNow, useSessionHandle, useStore } from '../hooks.ts'
import { taskWords, type OpenTask, type TaskState } from '../plugins/chat/SubTasks.tsx'
import { relativeTime } from './SessionList.tsx'
import { Icon, type IconName } from './Icons.tsx'

/**
 * The conversation's right sidebar, as the Claude app has it: the header's
 * icons each open one panel here — its sub-tasks, the commands its agents
 * run, the built-in browser — one at a time.
 */
export type SidePanelId = 'tasks' | 'commands' | 'browser'

export const SIDE_PANELS: readonly { id: SidePanelId; icon: IconName; title: string; hint: string }[] = [
  { id: 'tasks', icon: 'list', title: '子任务', hint: '子任务：正在做和做完的，点开看每一个的对话' },
  { id: 'commands', icon: 'terminal', title: '命令', hint: '命令：这个对话和它的子任务运行的命令和程序' },
  { id: 'browser', icon: 'globe', title: '浏览器', hint: '内置浏览器：看 agent 操作网页，也可以自己接手' },
]

/** The sidebar's frame: the panel's name, what it adds to its header, and close. */
export function SidePanelHost({ title, actions, onClose, children }: {
  title: string
  actions?: ReactNode
  onClose: () => void
  children: ReactNode
}) {
  return (
    <aside className="side-panel" aria-label={title}>
      <header className="side-panel-head">
        <h2>{title}</h2>
        {actions}
        <button type="button" className="icon-button" title="关闭侧栏" aria-label="关闭侧栏" onClick={onClose}><Icon name="close" /></button>
      </header>
      <div className="side-panel-body">{children}</div>
    </aside>
  )
}

const RUNNING: TaskState = { label: '进行中', tone: 'running' }
const DONE: TaskState = { label: '完成', tone: 'ok' }

/** A sub-task's name: what it was given to do, where the conversation says. */
export function taskLabel(task: SessionItem, labels: ReadonlyMap<string, string>): string {
  return labels.get(task.id) ?? (taskWords(task.title ?? '') || '子任务')
}

/** The sub-tasks, 进行中 and 已结束 apart; one opens its conversation in the sidebar (SubAgentPane). */
export function TasksPanel({ tasks, labels, settled, onOpen }: {
  tasks: readonly SessionItem[]
  labels: ReadonlyMap<string, string>
  settled: ReadonlyMap<string, TaskState>
  onOpen: (task: OpenTask) => void
}) {
  const now = useNow(60_000)
  const latest = [...tasks].sort((a, b) => b.updatedAt - a.updatedAt)
  const running = latest.filter(t => t.running)
  const done = latest.filter(t => !t.running)
  const row = (task: SessionItem) => {
    const state = task.running ? RUNNING : settled.get(task.id) ?? DONE
    const words = taskLabel(task, labels)
    return (
      <li key={task.id}>
        <button className="subtask-tracker-row" title={words} onClick={() => onOpen({ id: task.id, label: words })}>
          {task.running ? <span className="tool-spinner" aria-hidden /> : <Icon name={state === DONE ? 'check' : 'alert'} className={`tone-${state.tone}`} />}
          <span className="subtask-tracker-label">{words}</span>
          <span className={`delegation-state tone-${state.tone}`}>{task.running ? state.label : `${state.label} · ${relativeTime(task.updatedAt, now)}`}</span>
          <Icon name="chevron" className="exchange-open" />
        </button>
      </li>
    )
  }
  if (tasks.length === 0) return <div className="side-empty">这个对话还没有开过子任务。<br />agent 把具体的活交给子 agent 时，会列在这里。</div>
  return (
    <div className="side-list">
      <section>
        <div className="subtask-tracker-head">进行中<span className="skills-count">{running.length}</span></div>
        {running.length === 0 ? <p className="muted small subtask-tracker-empty">现在没有在跑的子任务</p> : <ul>{running.map(row)}</ul>}
      </section>
      {done.length > 0 && (
        <section>
          <div className="subtask-tracker-head">已结束<span className="skills-count">{done.length}</span></div>
          <ul>{done.map(row)}</ul>
        </section>
      )}
    </div>
  )
}

type ToolItem = Extract<ChatItem, { kind: 'tool' }>

/** The tools that run something: a shell command, or a program calling tools (a sub-agent's run_code). */
const COMMAND_TOOLS = new Set(['pwsh', 'bash', 'run_code'])

/** What a command call ran, and what for. */
export function commandOf(item: ToolItem): { text: string; description: string; program: boolean } {
  let args: Record<string, unknown> = {}
  try { args = JSON.parse(item.arguments) as Record<string, unknown> } catch { /* still streaming */ }
  const program = item.name === 'run_code'
  const text = typeof (program ? args['code'] : args['command']) === 'string' ? String(program ? args['code'] : args['command']) : ''
  return { text, description: typeof args['description'] === 'string' ? args['description'] : '', program }
}

export function commandsOf(items: readonly ChatItem[]): ToolItem[] {
  return items.filter((i): i is ToolItem => i.kind === 'tool' && COMMAND_TOOLS.has(i.name))
}

/**
 * The commands this conversation and its sub-tasks run: those still running
 * first, then by when they ran. A sub-task's are read from its own
 * conversation, only while the panel is open (the latest ones).
 */
export function CommandsPanel({ client, own, tasks, labels }: {
  client: AdgClient
  /** This conversation's own commands. */
  own: readonly ToolItem[]
  tasks: readonly SessionItem[]
  labels: ReadonlyMap<string, string>
}) {
  const shown = useMemo(() => [...tasks].sort((a, b) => Number(b.running) - Number(a.running) || b.updatedAt - a.updatedAt).slice(0, TASKS_READ), [tasks])
  return (
    <div className="side-list commands">
      {shown.map(task => <TaskCommands key={task.id} client={client} task={task} label={taskLabel(task, labels)} />)}
      <CommandGroup title="这个对话" running={false} commands={own} empty="这个对话自己没有运行命令（命令多由子任务运行）" />
      {tasks.length > TASKS_READ && <p className="muted small side-note">更早的 {tasks.length - TASKS_READ} 个子任务的命令在它们的对话里（子任务面板）</p>}
    </div>
  )
}

/** Sub-tasks whose commands the panel reads: the running ones and the latest ended. */
const TASKS_READ = 8

function TaskCommands({ client, task, label }: { client: AdgClient; task: SessionItem; label: string }) {
  const handle = useSessionHandle(client, task.id)
  return handle === null
    ? <CommandGroup title={label} running={task.running} commands={[]} empty="正在打开…" />
    : <OpenTaskCommands handle={handle} label={label} running={task.running} />
}

function OpenTaskCommands({ handle, label, running }: { handle: NonNullable<ReturnType<typeof useSessionHandle>>; label: string; running: boolean }) {
  const state = useStore(handle.state)
  // `version` covers in-place live appends.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const commands = useMemo(() => commandsOf(buildChat(state.events, state.live, state.pending)), [state.events, state.live, state.pending, state.version])
  if (commands.length === 0 && !running) return null
  return <CommandGroup title={label} running={running} commands={commands} empty="还没有运行命令" />
}

function CommandGroup({ title, running, commands, empty }: { title: string; running: boolean; commands: readonly ToolItem[]; empty: string }) {
  // An ended sub-task's commands fold to their count; open ones show.
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? (running || commands.some(c => c.status === 'running') || title === '这个对话')
  return (
    <section className="command-group">
      <button type="button" className="command-group-head" aria-expanded={expanded} onClick={() => setOpen(!expanded)}>
        <Icon name={expanded ? 'chevron-down' : 'chevron'} />
        <span className="command-group-title" title={title}>{title}</span>
        {running && <span className="tool-spinner" aria-label="进行中" />}
        <span className="skills-count">{commands.length}</span>
      </button>
      {expanded && (commands.length === 0
        ? <p className="muted small side-note">{empty}</p>
        : <ol className="command-list">{commands.map(c => <CommandRow key={c.id} item={c} />)}</ol>)}
    </section>
  )
}

function CommandRow({ item }: { item: ToolItem }) {
  const { text, description, program } = commandOf(item)
  const [showOutput, setShowOutput] = useState(item.status === 'error')
  const now = useNow(item.status === 'running' ? 1000 : 60_000)
  const output = (item.result ?? item.error ?? '').trimEnd()
  return (
    <li className={`command-row status-${item.status}`}>
      <div className="command-row-head">
        {item.status === 'running' ? <span className="tool-spinner" aria-hidden /> : <Icon name={item.status === 'error' ? 'alert' : 'check'} />}
        <span className="command-desc">{description !== '' ? description : program ? '运行程序' : '运行命令'}</span>
        <span className="command-time">{item.status === 'running' ? `运行中 ${Math.max(0, Math.round((now - item.time) / 1000))} 秒` : relativeTime(item.time, now)}</span>
      </div>
      <pre className="command-text"><span className="command-prompt">{program ? 'ts' : item.name === 'bash' ? '$' : 'PS>'}</span>{text}</pre>
      {output !== '' && (
        <>
          <button type="button" className="link-button command-output-toggle" onClick={() => setShowOutput(!showOutput)}>{showOutput ? '收起输出' : '看输出'}</button>
          {showOutput && <pre className="command-output">{output.length > OUTPUT_SHOWN ? `…\n${output.slice(-OUTPUT_SHOWN)}` : output}</pre>}
        </>
      )}
    </li>
  )
}

/** The output's tail a row shows; the whole of it is in the conversation. */
const OUTPUT_SHOWN = 6000
