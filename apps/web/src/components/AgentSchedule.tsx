import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { AgentReminder, PipelineSchedule, PipelineSummary, RequestResult } from '@adg/protocol'
import { MAIN, MAIN_AGENT, agentOf, useRoles, type Agent } from '../agents.ts'
import { useNow, useStore } from '../hooks.ts'
import { errorText } from '../plugins/scripts/data.ts'
import { confirm } from './Dialog.tsx'
import { Icon } from './Icons.tsx'
import { Select } from './Select.tsx'
import { relativeTime } from './SessionList.tsx'

/**
 * Timed tasks (docs/design/agent-roles.md §11): at set times one agent is
 * handed one piece of work in plain words. Each agent keeps its own on its
 * 定时 tab (`AgentSchedule`); 「定时任务」 in the roster shows every agent's
 * together, with the pipelines that run on a timetable (`ScheduleOverview`).
 * The reminders an agent set for itself in its conversation (schedule_create,
 * `reminders/list`) are listed with them.
 */

type Task = RequestResult<'tasks/list'>['items'][number]

const DAYS = ['日', '一', '二', '三', '四', '五', '六']
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]

function scheduleText(s: PipelineSchedule): string {
  if (!s.enabled) return '已暂停'
  if (s.times.length === 0) return s.after === undefined ? '没有设时间' : `「${s.after}」跑完后`
  const days = s.days.length === 0 || s.days.length === 7 ? '每天' : `每周${WEEK_ORDER.filter(d => s.days.includes(d)).map(d => DAYS[d]).join('、')}`
  return `${days} ${[...s.times].sort().join('、')}`
}

/** The next time on the timetable after `now` (local clock), within a week. */
export function nextAt(s: PipelineSchedule, now: number): number | undefined {
  if (!s.enabled) return undefined
  const day = new Date(now)
  day.setHours(0, 0, 0, 0)
  for (let i = 0; i < 8; i++, day.setDate(day.getDate() + 1)) {
    if (s.days.length > 0 && !s.days.includes(day.getDay())) continue
    const times = s.times.map(t => { const [h, m] = t.split(':').map(Number) as [number, number]; return new Date(day.getFullYear(), day.getMonth(), day.getDate(), h, m).getTime() })
      .filter(at => at > now).sort((a, b) => a - b)
    if (times[0] !== undefined) return times[0]
  }
  return undefined
}

const clock = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })

/** Timed tasks (`tasks/list`), all or one agent's, kept current. */
function useTasks(client: AdgClient, agent?: string): { items: readonly Task[] | null; error: string | null } {
  const status = useStore(client.connection.status)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ items: readonly Task[] | null; error: string | null }>({ items: null, error: null })
  useEffect(() => client.connection.on('tasks/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('tasks/list', agent === undefined ? {} : { agent }).then(
      r => { if (live) setState({ items: r.items, error: null }) },
      e => { if (live) setState(s => ({ ...s, error: errorText(e) })) },
    )
    return () => { live = false }
  }, [client, agent, status.state, revision])
  return state
}

/** Reminders the agents set for themselves (`reminders/list`), all or one agent's, kept current. */
function useReminders(client: AdgClient, agent?: string): readonly AgentReminder[] {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const [revision, setRevision] = useState(0)
  const [items, setItems] = useState<readonly AgentReminder[]>([])
  useEffect(() => client.connection.on('reminders/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('agents')) return
    let live = true
    client.connection.call('reminders/list', agent === undefined ? {} : { agent }).then(r => { if (live) setItems(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, agent, status.state, capabilities, revision])
  return items
}

/** Pipelines (`pipelines/list`), for the ones on a timetable. */
function usePipelines(client: AdgClient): readonly PipelineSummary[] {
  const status = useStore(client.connection.status)
  const [revision, setRevision] = useState(0)
  const [items, setItems] = useState<readonly PipelineSummary[]>([])
  useEffect(() => client.connection.on('pipelines/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('pipelines/list', {}).then(r => { if (live) setItems(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, revision])
  return items
}

/** 游戏's own timer: the daily report (set on the games page), when there is one. */
function useDailyReport(client: AdgClient): { schedule: PipelineSchedule; next?: number | undefined } | null {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const [report, setReport] = useState<{ schedule: PipelineSchedule; next?: number | undefined } | null>(null)
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('games')) return
    let live = true
    client.connection.call('games/list', {}).then(r => {
      if (live) setReport({ schedule: { enabled: r.settings.report.enabled, times: [r.settings.report.at], days: [], catchUpMinutes: 0 }, next: r.report.next })
    }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, capabilities])
  return report
}

function DailyReportLine({ report, now }: { report: { schedule: PipelineSchedule }; now: number }) {
  const next = nextAt(report.schedule, now)
  return (
    <a className="task-card pipeline-line" href="#/p/games/report" title="在游戏页的「日报」里设置">
      <Icon name="send" />
      <span className="task-title">每日日报</span>
      <span className="muted small">{scheduleText(report.schedule)}{next === undefined ? '' : ` · 下次 ${clock(next)}`} · 发到飞书</span>
      <Icon name="chevron" />
    </a>
  )
}

/** 助手 and the role agents, as the roster lists them. */
function useAgents(client: AdgClient): readonly Agent[] {
  const roles = useRoles(client)
  return useMemo(() => [MAIN, ...roles.map(agentOf)], [roles])
}

/** One agent's 定时 tab: its timed tasks; 编排's also lists the pipelines on a timetable. */
export function AgentSchedule({ client, agentId }: { client: AdgClient; agentId: string }) {
  const agents = useAgents(client)
  const agent = agents.find(a => a.id === agentId) ?? MAIN
  const { items, error } = useTasks(client, agentId)
  const reminders = useReminders(client, agentId)
  const pipelines = usePipelines(client)
  const report = useDailyReport(client)
  const now = useNow(30_000)
  const [editing, setEditing] = useState<Task | 'new' | null>(null)
  const timed = pipelines.filter(p => p.schedule.enabled && p.draft !== true)
  return (
    <section className="main scripts-page agent-schedule">
      <header className="page-header">
        <div className="breadcrumb"><span>{agent.name}</span><span className="breadcrumb-divider">/</span><h1>定时任务</h1></div>
        <div className="page-actions">
          <button className="small-button primary" onClick={() => setEditing('new')} disabled={editing !== null}><Icon name="plus" />新建定时任务</button>
        </div>
      </header>
      <div className="schedule-body">
        <p className="muted small">到点把一段话交给{agent.name}去做，在它的对话里做。{agentId === MAIN_AGENT ? '' : '做完后，要紧的由助手告诉你。'}要跑脚本的多步任务，用「编排」做成流水线。</p>
        {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
        {editing === 'new' && <TaskForm client={client} agents={agents} task={{ agent: agentId }} onDone={() => setEditing(null)} />}
        {agentId === 'games' && report !== null && <DailyReportLine report={report} now={now} />}
        {items !== null && items.length === 0 && reminders.length === 0 && editing === null && <div className="empty-card muted">{agent.name}还没有定时任务。</div>}
        {items?.map(task => editing !== 'new' && editing?.id === task.id
          ? <TaskForm key={task.id} client={client} agents={agents} task={task} onDone={() => setEditing(null)} />
          : <TaskCard key={task.id} client={client} task={task} now={now} onEdit={() => setEditing(task)} />)}
        {reminders.length > 0 && (
          <section className="schedule-group">
            <h3>{agent.name}在对话里设的提醒</h3>
            <p className="muted small">你在对话里让它「几点提醒我…」时它自己设的。到点后它在对话里接着做，回复也会同步到飞书和 QQ。</p>
            {reminders.map(r => <ReminderCard key={r.id} client={client} reminder={r} now={now} />)}
          </section>
        )}
        {agentId === 'pipelines' && (
          <section className="schedule-group">
            <h3>按时运行的流水线</h3>
            {timed.length === 0 && <p className="muted small">没有开着定时的流水线。</p>}
            {timed.map(p => <PipelineLine key={p.id} pipeline={p} now={now} />)}
          </section>
        )}
      </div>
    </section>
  )
}

/** 「定时任务」: what comes next for every agent, then each agent's timed tasks. */
export function ScheduleOverview({ client, onAgent }: { client: AdgClient; onAgent: (agentId: string) => void }) {
  const agents = useAgents(client)
  const { items, error } = useTasks(client)
  const reminders = useReminders(client)
  const pipelines = usePipelines(client)
  const report = useDailyReport(client)
  const now = useNow(30_000)
  const [creating, setCreating] = useState(false)
  const pipelinesAgent = agents.find(a => a.id === 'pipelines')
  const gamesAgent = agents.find(a => a.id === 'games')
  const coming = useMemo(() => [
    ...(report === null ? [] : [{ key: 'daily-report', agent: gamesAgent, title: '每日日报', at: nextAt(report.schedule, now) }]),
    ...(items ?? []).map(t => ({ key: t.id, agent: agents.find(a => a.id === t.agent), title: t.title, at: nextAt(t.schedule, now) })),
    ...pipelines.filter(p => p.draft !== true).map(p => ({ key: p.id, agent: pipelinesAgent, title: `流水线「${p.name}」`, at: nextAt(p.schedule, now) })),
    ...reminders.map(r => ({ key: r.id, agent: agents.find(a => a.id === r.agent), title: `提醒：${r.title}`, at: r.next as number | undefined })),
  ].filter((c): c is typeof c & { at: number } => c.at !== undefined).sort((a, b) => a.at - b.at).slice(0, 8), [items, reminders, pipelines, agents, pipelinesAgent, gamesAgent, report, now])
  return (
    <section className="main scripts-page agent-schedule">
      <header className="page-header">
        <div className="breadcrumb"><h1>定时任务</h1></div>
        <div className="page-actions">
          <a className="small-button" href="#/settings/schedule"><Icon name="settings" />开机自启与唤醒</a>
          <button className="small-button primary" onClick={() => setCreating(true)} disabled={creating}><Icon name="plus" />新建定时任务</button>
        </div>
      </header>
      <div className="schedule-body">
        {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
        {creating && <TaskForm client={client} agents={agents} task={{ agent: MAIN_AGENT }} chooseAgent onDone={() => setCreating(false)} />}
        <section className="schedule-group">
          <h3>接下来</h3>
          {coming.length === 0 && <p className="muted small">一周内没有要按时做的事。</p>}
          <ol className="schedule-timeline">
            {coming.map(c => (
              <li key={`${c.key}@${c.at}`}>
                <span className="schedule-when">{clock(c.at)}</span>
                <span className={`agent-avatar small agent-${c.agent?.id ?? 'unknown'}`}><Icon name={c.agent?.icon ?? 'sparkles'} /></span>
                <span className="schedule-who">{c.agent?.name ?? '?'}</span>
                <span className="schedule-what">{c.title}</span>
              </li>
            ))}
          </ol>
        </section>
        {agents.map(agent => {
          const mine = (items ?? []).filter(t => t.agent === agent.id)
          const own = reminders.filter(r => r.agent === agent.id)
          const timed = agent.id === 'pipelines' ? pipelines.filter(p => p.schedule.enabled && p.draft !== true) : []
          const daily = agent.id === 'games' && report?.schedule.enabled === true ? report : null
          if (mine.length === 0 && own.length === 0 && timed.length === 0 && daily === null) return null
          return (
            <section key={agent.id} className="schedule-group">
              <h3 className="schedule-agent">
                <span className={`agent-avatar small agent-${agent.id}`}><Icon name={agent.icon} /></span>
                {agent.name}
                <span className="tab-count">{mine.length + own.length + timed.length + (daily === null ? 0 : 1)}</span>
                <span className="spacer" />
                <button className="link-button" onClick={() => onAgent(agent.id)}>管理</button>
              </h3>
              {daily !== null && <DailyReportLine report={daily} now={now} />}
              {mine.map(task => <TaskCard key={task.id} client={client} task={task} now={now} />)}
              {own.map(r => <ReminderCard key={r.id} client={client} reminder={r} now={now} />)}
              {timed.map(p => <PipelineLine key={p.id} pipeline={p} now={now} />)}
            </section>
          )
        })}
      </div>
    </section>
  )
}

function PipelineLine({ pipeline, now }: { pipeline: PipelineSummary; now: number }) {
  const next = nextAt(pipeline.schedule, now)
  return (
    <a className="task-card pipeline-line" href={`#/p/pipelines/${encodeURIComponent(pipeline.id)}`}>
      <Icon name="flow" />
      <span className="task-title">{pipeline.name}</span>
      <span className="muted small">{scheduleText(pipeline.schedule)}{next === undefined ? '' : ` · 下次 ${clock(next)}`}</span>
      <Icon name="chevron" />
    </a>
  )
}

/** A reminder the agent set for itself: when, what for; it can be removed (not edited: ask the agent). */
function ReminderCard({ client, reminder, now }: { client: AdgClient; reminder: AgentReminder; now: number }) {
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    if (!await confirm({ title: '删除这个提醒？', message: 'agent 到时候就不会再被叫起来做这件事。要改时间，直接在对话里跟它说。', quote: reminder.title, confirmLabel: '删除', danger: true })) return
    setError(null)
    client.connection.call('reminders/remove', { id: reminder.id }).catch(e => setError(errorText(e)))
  }
  return (
    <div className="task-card reminder-card">
      <div className="task-card-head">
        <Icon name="calendar" />
        <span className="task-title">{reminder.title}</span>
        <span className="muted small">{reminder.rule === '一次' ? '' : `${reminder.rule} · `}{reminder.repeats ? '下次 ' : ''}{clock(reminder.next)}{reminder.next > now ? `（${until(reminder.next - now)}后）` : ''}</span>
        <span className="spacer" />
        <button className="icon-button" onClick={() => void remove()} title="删除这个提醒" aria-label="删除"><Icon name="close" /></button>
      </div>
      <div className="task-prompt">{reminder.prompt}</div>
      {error !== null && <div className="error small">{error}</div>}
    </div>
  )
}

/** How long until, roughly: 3 分钟 / 5 小时 / 7 天. */
function until(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000))
  if (minutes < 60) return `${minutes} 分钟`
  const hours = Math.round(minutes / 60)
  return hours < 48 ? `${hours} 小时` : `${Math.round(hours / 24)} 天`
}

function TaskCard({ client, task, now, onEdit }: { client: AdgClient; task: Task; now: number; onEdit?: () => void }) {
  const [error, setError] = useState<string | null>(null)
  const next = nextAt(task.schedule, now)
  const run = task.lastRun
  const act = (method: 'tasks/run' | 'tasks/remove') => {
    setError(null)
    client.connection.call(method, { id: task.id }).catch(e => setError(errorText(e)))
  }
  const toggle = () => {
    setError(null)
    client.connection.call('tasks/save', { task: { ...task, schedule: { ...task.schedule, enabled: !task.schedule.enabled } } }).catch(e => setError(errorText(e)))
  }
  return (
    <div className={`task-card ${task.schedule.enabled ? '' : 'paused'}`}>
      <div className="task-card-head">
        <span className="task-title">{task.title}</span>
        <span className="muted small">{scheduleText(task.schedule)}{next === undefined ? '' : ` · 下次 ${clock(next)}`}</span>
        <span className="spacer" />
        <button className="small-button" onClick={() => act('tasks/run')} disabled={run?.state === 'running'} title="现在就交给它做一次">{run?.state === 'running' ? '在做' : '立即运行'}</button>
        <button className="small-button" onClick={toggle}>{task.schedule.enabled ? '暂停' : '开启'}</button>
        {onEdit !== undefined && <button className="icon-button" onClick={onEdit} title="修改" aria-label="修改"><Icon name="pencil" /></button>}
        {onEdit !== undefined && <button className="icon-button" onClick={() => void confirm({ title: '删除这个定时任务？', message: '删掉后到点不会再交给 agent 做，不能撤销。', quote: task.title, confirmLabel: '删除', danger: true }).then(ok => { if (ok) act('tasks/remove') })} title="删除" aria-label="删除"><Icon name="close" /></button>}
      </div>
      <div className="task-prompt">{task.prompt}</div>
      {run !== undefined && (
        <div className={`task-run tone-${run.state === 'done' ? 'ok' : run.state === 'failed' ? 'failed' : 'running'}`}>
          {run.state === 'running' ? <span className="tool-spinner" aria-hidden /> : <Icon name={run.state === 'done' ? 'check' : 'alert'} />}
          <span>{run.state === 'running' ? '正在做' : `${relativeTime(run.endedAt ?? run.startedAt, now)}${run.state === 'done' ? '做完' : '没做成'}`}{run.outcome === undefined ? '' : `：${run.outcome.split('\n')[0]}`}</span>
        </div>
      )}
      {error !== null && <div className="error small">{error}</div>}
    </div>
  )
}

function TaskForm({ client, agents, task, chooseAgent = false, onDone }: {
  client: AdgClient
  agents: readonly Agent[]
  task: Partial<Task> & { agent: string }
  chooseAgent?: boolean
  onDone: () => void
}) {
  const [agent, setAgent] = useState(task.agent)
  const [title, setTitle] = useState(task.title ?? '')
  const [prompt, setPrompt] = useState(task.prompt ?? '')
  const [times, setTimes] = useState((task.schedule?.times ?? ['09:00']).join(', '))
  const [days, setDays] = useState<readonly number[]>(task.schedule?.days ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const list = times.split(/[,，、\s]+/).filter(t => t !== '').map(t => (/^\d:\d\d$/.test(t) ? `0${t}` : t))
      await client.connection.call('tasks/save', {
        task: {
          ...(task.id === undefined ? {} : { id: task.id }),
          agent, title, prompt,
          schedule: { enabled: task.schedule?.enabled ?? true, times: list, days: [...days], catchUpMinutes: task.schedule?.catchUpMinutes ?? 10 },
        },
      })
      onDone()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="task-card task-form">
      {chooseAgent && (
        <div className="field-label">交给谁
          <Select aria-label="交给谁" value={agent} onChange={setAgent} options={agents.map(a => ({ value: a.id, label: a.name }))} />
        </div>
      )}
      <label className="field-label">名字<input className="text-input plain" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} placeholder="例如：看今天结束的活动" /></label>
      <label className="field-label">交给它的话<textarea className="text-input plain" rows={3} value={prompt} maxLength={4000} onChange={e => setPrompt(e.target.value)} placeholder="写完整：要做什么、要交回什么" /></label>
      <div className="task-form-row">
        <label className="field-label">时间<input className="text-input plain-mono" value={times} onChange={e => setTimes(e.target.value)} placeholder="09:00, 21:30" /></label>
        <div className="field-label">星期
          <div className="day-chips">
            {WEEK_ORDER.map(d => (
              <button key={d} type="button" className={`day-chip ${days.includes(d) ? 'on' : ''}`} aria-pressed={days.includes(d)}
                onClick={() => setDays(days.includes(d) ? days.filter(x => x !== d) : [...days, d])}>{DAYS[d]}</button>
            ))}
            <span className="muted small">{days.length === 0 ? '不选就是每天' : ''}</span>
          </div>
        </div>
      </div>
      {error !== null && <div className="error small">{error}</div>}
      <div className="task-form-actions">
        <button className="small-button" onClick={onDone} disabled={busy}>取消</button>
        <button className="small-button primary" onClick={() => void save()} disabled={busy || title.trim() === '' || prompt.trim() === ''}>保存</button>
      </div>
    </div>
  )
}
