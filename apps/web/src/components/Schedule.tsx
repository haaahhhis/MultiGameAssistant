import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { timetableText, type AgentReminder, type PipelineSchedule, type PipelineSummary, type RequestResult, type ScheduleAgentSet } from '@adg/protocol'
import { MAIN, MAIN_AGENT, agentOf, useRoles, type Agent } from '../agents.ts'
import { useNow, useStore } from '../hooks.ts'
import { errorText } from '../plugins/scripts/data.ts'
import { confirm } from './Dialog.tsx'
import { Icon } from './Icons.tsx'
import { relativeTime } from './SessionList.tsx'

/**
 * 定时 (docs/design/agent-roles.md §11), the one place timed work is seen,
 * made and changed: at set times one agent is handed one piece of work in
 * plain words (a timed task, `tasks/*`). With them, the reminders the agents
 * set for themselves in their conversations (schedule_create, `reminders/*`),
 * the pipelines that run on a timetable (编排's) and 游戏's daily report (set
 * on the 游戏 page). Agents have no 定时 tab of their own any more.
 *
 * When an agent sets one with its own tool, `ScheduleNotices` says so in a
 * box that leads here, to that one (`focus`).
 */

type Task = RequestResult<'tasks/list'>['items'][number]

const DAYS = ['日', '一', '二', '三', '四', '五', '六']
const WEEK_ORDER = [1, 2, 3, 4, 5, 6, 0]
const WORKDAYS = [1, 2, 3, 4, 5]
const WEEKEND = [0, 6]

/** Things each agent is often given at set times, to start from (a click fills in the form). */
const EXAMPLES: Readonly<Record<string, readonly { title: string; prompt: string }[]>> = {
  [MAIN_AGENT]: [
    { title: '早上说说今天要做什么', prompt: '看看今天有哪些活动快结束、哪些日常还没做，整理成几句话告诉我。' },
  ],
  games: [
    { title: '看三天内结束的活动', prompt: '查各个游戏今天和三天内结束的活动，列出名字、所属游戏和剩余时间；已经做完的不用列。' },
    { title: '看新版本和公告', prompt: '看各个游戏最近一天的新版本、维护和重要公告，有变化的用一两句话说明，没有就说没有。' },
  ],
  scripts: [
    { title: '检查脚本有没有新版本', prompt: '检查已安装的脚本有没有新版本，有的话说明更新了什么；先不要安装。' },
  ],
  intervene: [
    { title: '汇总夜里的异常', prompt: '汇总最近 12 小时运行里出过的异常：哪些已经自动处理了，哪些还要我管、该怎么做。' },
  ],
  pipelines: [
    { title: '检查流水线跑得怎么样', prompt: '看看各条流水线最近一次运行是否成功，失败的说明卡在哪一步、可能的原因。' },
  ],
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

/** Timed tasks (`tasks/list`), kept current. */
function useTasks(client: AdgClient): { items: readonly Task[] | null; error: string | null } {
  const status = useStore(client.connection.status)
  const [revision, setRevision] = useState(0)
  const [state, setState] = useState<{ items: readonly Task[] | null; error: string | null }>({ items: null, error: null })
  useEffect(() => client.connection.on('tasks/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('tasks/list', {}).then(
      r => { if (live) setState({ items: r.items, error: null }) },
      e => { if (live) setState(s => ({ ...s, error: errorText(e) })) },
    )
    return () => { live = false }
  }, [client, status.state, revision])
  return state
}

/** Reminders the agents set for themselves (`reminders/list`), kept current. */
function useReminders(client: AdgClient): readonly AgentReminder[] {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const [revision, setRevision] = useState(0)
  const [items, setItems] = useState<readonly AgentReminder[]>([])
  useEffect(() => client.connection.on('reminders/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('agents')) return
    let live = true
    client.connection.call('reminders/list', {}).then(r => { if (live) setItems(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, capabilities, revision])
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

/** 游戏's daily report (set on the 游戏 page, its 日报), when the games plugin is there. */
function useDailyReport(client: AdgClient): { schedule: PipelineSchedule } | null {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const [report, setReport] = useState<{ schedule: PipelineSchedule } | null>(null)
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('games')) return
    let live = true
    client.connection.call('games/list', {}).then(r => {
      if (live) setReport({ schedule: { enabled: r.settings.report.enabled, times: [r.settings.report.at], days: [], catchUpMinutes: 0 } })
    }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, capabilities])
  return report
}

/** 助手 and the role agents, as the roster lists them. */
function useAgents(client: AdgClient): readonly Agent[] {
  const roles = useRoles(client)
  return useMemo(() => [MAIN, ...roles.map(agentOf)], [roles])
}

function Avatar({ agent, size = 'small' }: { agent: Agent | undefined; size?: 'small' | '' }) {
  return <span className={`agent-avatar ${size} agent-${agent?.id ?? 'unknown'}`}><Icon name={agent?.icon ?? 'sparkles'} /></span>
}

/**
 * 「定时任务」: make one (who, what, when), every agent's together — what
 * comes next, then each agent's — and change or remove any of them here.
 */
export function ScheduleOverview({ client, focus, agent: firstAgent }: { client: AdgClient; focus?: string | undefined; agent?: string | undefined }) {
  const agents = useAgents(client)
  const { items, error } = useTasks(client)
  const reminders = useReminders(client)
  const pipelines = usePipelines(client)
  const report = useDailyReport(client)
  const now = useNow(30_000)
  const [filter, setFilter] = useState<string | null>(firstAgent ?? null)
  /** The form: a new one (for this agent), or one task changed in place. */
  const [form, setForm] = useState<{ kind: 'new'; agent: string } | { kind: 'edit'; id: string } | null>(null)
  const [lit, setLit] = useState<string | undefined>(undefined)
  const body = useRef<HTMLDivElement>(null)
  /** The focus already shown: an agent's link lights its one once, not again on every change after. */
  const shownFocus = useRef<string | undefined>(undefined)

  const timed = pipelines.filter(p => p.schedule.enabled && p.draft !== true)
  const daily = report?.schedule.enabled === true ? report : null
  const counts = new Map(agents.map(a => [a.id, 0]))
  for (const t of items ?? []) counts.set(t.agent, (counts.get(t.agent) ?? 0) + 1)
  for (const r of reminders) counts.set(r.agent, (counts.get(r.agent) ?? 0) + 1)
  counts.set('pipelines', (counts.get('pipelines') ?? 0) + timed.length)
  if (daily !== null) counts.set('games', (counts.get('games') ?? 0) + 1)
  const total = [...counts.values()].reduce((a, b) => a + b, 0)
  const shown = agents.filter(a => filter === null || a.id === filter)

  // An old link to one agent's 定时 tab: that agent's, even when 定时 is already open.
  useEffect(() => { if (firstAgent !== undefined) setFilter(firstAgent) }, [firstAgent])
  // An agent's link to what it just set: once it is listed, show it (all agents, if it is another's), lit for a moment.
  useEffect(() => {
    if (focus === undefined || shownFocus.current === focus) return
    const owner = items?.find(t => t.id === focus)?.agent ?? reminders.find(r => r.id === focus)?.agent
    if (owner === undefined) return
    shownFocus.current = focus
    setFilter(f => (f === null || f === owner ? f : null))
    setLit(focus)
  }, [focus, items, reminders])
  useEffect(() => {
    if (lit === undefined) return
    const element = body.current?.querySelector(`[data-schedule-id="${CSS.escape(lit)}"]`)
    if (element === null || element === undefined) return
    element.scrollIntoView({ block: 'center', behavior: 'smooth' })
    const timer = setTimeout(() => setLit(undefined), 2600)
    return () => clearTimeout(timer)
  }, [lit])

  const coming = useMemo(() => [
    ...(daily === null ? [] : [{ key: 'daily-report', agent: 'games', title: '每日日报', at: nextAt(daily.schedule, now) }]),
    ...(items ?? []).map(t => ({ key: t.id, agent: t.agent, title: t.title, at: nextAt(t.schedule, now) })),
    ...timed.map(p => ({ key: p.id, agent: 'pipelines', title: `流水线「${p.name}」`, at: nextAt(p.schedule, now) })),
    ...reminders.map(r => ({ key: r.id, agent: r.agent, title: `提醒：${r.title}`, at: r.next as number | undefined })),
  ].filter((c): c is typeof c & { at: number } => c.at !== undefined && (filter === null || c.agent === filter))
    .sort((a, b) => a.at - b.at).slice(0, 8), [items, reminders, timed, daily, now, filter])

  const startNew = (agent: string) => { setForm({ kind: 'new', agent }); body.current?.scrollTo({ top: 0, behavior: 'smooth' }) }
  return (
    <section className="main scripts-page agent-schedule">
      <header className="page-header">
        <div className="breadcrumb"><h1>定时任务</h1>{total > 0 && <span className="tab-count">{total}</span>}</div>
        <div className="page-actions">
          <a className="small-button" href="#/settings/schedule"><Icon name="settings" />开机自启与唤醒</a>
          <button className="small-button primary" onClick={() => startNew(filter ?? MAIN_AGENT)} disabled={form?.kind === 'new'}><Icon name="plus" />新建定时任务</button>
        </div>
      </header>
      <div className="schedule-body" ref={body}>
        <p className="muted small">到点把一件事交给某个 agent，在它的对话里做；做完后要紧的由助手告诉你。所有 agent 的定时任务、它们在对话里自己设的提醒、按时运行的流水线和游戏的每日日报都在这里。要跑脚本的多步任务，用「编排」做成流水线。</p>
        {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
        {form?.kind === 'new' && <TaskForm client={client} agents={agents} task={{ agent: form.agent }} onDone={() => setForm(null)} />}

        <div className="schedule-filter" role="group" aria-label="只看谁的">
          <button className={`agent-chip ${filter === null ? 'on' : ''}`} aria-pressed={filter === null} onClick={() => setFilter(null)}>全部<span className="tab-count">{total}</span></button>
          {agents.map(a => (
            <button key={a.id} className={`agent-chip ${filter === a.id ? 'on' : ''}`} aria-pressed={filter === a.id} onClick={() => setFilter(filter === a.id ? null : a.id)}>
              <Avatar agent={a} />{a.name}<span className="tab-count">{counts.get(a.id) ?? 0}</span>
            </button>
          ))}
        </div>

        <section className="schedule-group">
          <h3>接下来</h3>
          {coming.length === 0 && <p className="muted small">一周内没有要按时做的事。</p>}
          <ol className="schedule-timeline">
            {coming.map(c => {
              const agent = agents.find(a => a.id === c.agent)
              return (
                <li key={`${c.key}@${c.at}`}>
                  <span className="schedule-when">{clock(c.at)}</span>
                  <Avatar agent={agent} />
                  <span className="schedule-who">{agent?.name ?? '?'}</span>
                  <span className="schedule-what">{c.title}</span>
                </li>
              )
            })}
          </ol>
        </section>

        {shown.map(agent => {
          const mine = (items ?? []).filter(t => t.agent === agent.id)
          const own = reminders.filter(r => r.agent === agent.id)
          const lines = agent.id === 'pipelines' ? timed : []
          const dailyHere = agent.id === 'games' ? daily : null
          const empty = mine.length === 0 && own.length === 0 && lines.length === 0 && dailyHere === null
          if (empty && filter !== agent.id) return null
          return (
            <section key={agent.id} className="schedule-group">
              <h3 className="schedule-agent">
                <Avatar agent={agent} />
                {agent.name}
                <span className="tab-count">{mine.length + own.length + lines.length + (dailyHere === null ? 0 : 1)}</span>
                <span className="spacer" />
                <button className="link-button" onClick={() => startNew(agent.id)}><Icon name="plus" />给{agent.name}新建</button>
              </h3>
              {empty && <div className="empty-card muted">{agent.name}还没有定时任务。</div>}
              {dailyHere !== null && <DailyReportLine report={dailyHere} now={now} />}
              {mine.map(task => form?.kind === 'edit' && form.id === task.id
                ? <TaskForm key={task.id} client={client} agents={agents} task={task} onDone={() => setForm(null)} />
                : <TaskCard key={task.id} client={client} task={task} now={now} lit={lit === task.id} onEdit={() => setForm({ kind: 'edit', id: task.id })} />)}
              {own.length > 0 && <p className="muted small schedule-sub">{agent.name}在对话里自己设的提醒：你让它「几点提醒我…」时设的，到点它在对话里接着做。要改时间，直接跟它说。</p>}
              {own.map(r => <ReminderCard key={r.id} client={client} reminder={r} now={now} lit={lit === r.id} />)}
              {lines.map(p => <PipelineLine key={p.id} pipeline={p} now={now} />)}
            </section>
          )
        })}
        {items !== null && total === 0 && form === null && filter === null && (
          <div className="empty-card muted">还没有定时任务。点「新建定时任务」，选一个 agent、写下到点要它做的事。</div>
        )}
      </div>
    </section>
  )
}

/** 游戏's daily report, under 游戏: set on the 游戏 page (its 日报), not here. */
function DailyReportLine({ report, now }: { report: { schedule: PipelineSchedule }; now: number }) {
  const next = nextAt(report.schedule, now)
  return (
    <a className="task-card pipeline-line" href="#/p/daily-report" title="在游戏的「日报」里设置">
      <Icon name="send" />
      <span className="task-title">每日日报</span>
      <span className="muted small">{timetableText(report.schedule)}{next === undefined ? '' : ` · 下次 ${clock(next)}`} · 发到飞书</span>
      <span className="muted small daily-report-where">在游戏的「日报」里设置</span>
      <Icon name="chevron" />
    </a>
  )
}

function PipelineLine({ pipeline, now }: { pipeline: PipelineSummary; now: number }) {
  const next = nextAt(pipeline.schedule, now)
  return (
    <a className="task-card pipeline-line" href={`#/p/pipelines/${encodeURIComponent(pipeline.id)}`}>
      <Icon name="flow" />
      <span className="task-title">{pipeline.name}</span>
      <span className="muted small">{timetableText(pipeline.schedule)}{next === undefined ? '' : ` · 下次 ${clock(next)}`}</span>
      <Icon name="chevron" />
    </a>
  )
}

/** A reminder the agent set for itself: when, what for; it can be removed (not edited: ask the agent). */
function ReminderCard({ client, reminder, now, lit }: { client: AdgClient; reminder: AgentReminder; now: number; lit: boolean }) {
  const [error, setError] = useState<string | null>(null)
  const remove = async () => {
    if (!await confirm({ title: '删除这个提醒？', message: 'agent 到时候就不会再被叫起来做这件事。要改时间，直接在对话里跟它说。', quote: reminder.title, confirmLabel: '删除', danger: true })) return
    setError(null)
    client.connection.call('reminders/remove', { id: reminder.id }).catch(e => setError(errorText(e)))
  }
  return (
    <div className={`task-card reminder-card ${lit ? 'lit' : ''}`} data-schedule-id={reminder.id}>
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

function TaskCard({ client, task, now, lit, onEdit }: { client: AdgClient; task: Task; now: number; lit: boolean; onEdit: () => void }) {
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
  const remove = async () => {
    if (await confirm({ title: '删除这个定时任务？', message: '删掉后到点不会再交给 agent 做，不能撤销。', quote: task.title, confirmLabel: '删除', danger: true })) act('tasks/remove')
  }
  return (
    <div className={`task-card ${task.schedule.enabled ? '' : 'paused'} ${lit ? 'lit' : ''}`} data-schedule-id={task.id}>
      <div className="task-card-head">
        <span className="task-title">{task.title}</span>
        <span className="muted small">{timetableText(task.schedule)}{next === undefined ? '' : ` · 下次 ${clock(next)}`}</span>
        <span className="spacer" />
        <button className="small-button" onClick={() => act('tasks/run')} disabled={run?.state === 'running'} title="现在就交给它做一次">{run?.state === 'running' ? '在做' : '立即运行'}</button>
        <button className="small-button" onClick={toggle}>{task.schedule.enabled ? '暂停' : '开启'}</button>
        <button className="icon-button" onClick={onEdit} title="修改" aria-label="修改"><Icon name="pencil" /></button>
        <button className="icon-button" onClick={() => void remove()} title="删除" aria-label="删除"><Icon name="close" /></button>
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

/** A timed task made or changed: who does it, what they are told, when. */
function TaskForm({ client, agents, task, onDone }: {
  client: AdgClient
  agents: readonly Agent[]
  task: Partial<Task> & { agent: string }
  onDone: () => void
}) {
  const [agent, setAgent] = useState(task.agent)
  const [title, setTitle] = useState(task.title ?? '')
  const [prompt, setPrompt] = useState(task.prompt ?? '')
  const [times, setTimes] = useState((task.schedule?.times ?? ['09:00']).join(', '))
  const [days, setDays] = useState<readonly number[]>(task.schedule?.days ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chosen = agents.find(a => a.id === agent) ?? MAIN
  const examples = EXAMPLES[agent] ?? []
  const same = (a: readonly number[], b: readonly number[]) => a.length === b.length && a.every(d => b.includes(d))
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
      <div className="task-form-step">
        <span className="task-form-label">交给谁</span>
        <div className="agent-pick" role="radiogroup" aria-label="交给谁">
          {agents.map(a => (
            <button key={a.id} type="button" role="radio" aria-checked={a.id === agent} className={`agent-pick-item ${a.id === agent ? 'on' : ''}`} onClick={() => setAgent(a.id)} title={a.description}>
              <Avatar agent={a} size="" />
              <span className="agent-pick-text"><span className="agent-pick-name">{a.name}</span><span className="agent-pick-desc">{a.description}</span></span>
            </button>
          ))}
        </div>
        {agent === 'games' && <p className="muted small">游戏的每日日报不在这里设：在游戏的<a href="#/p/daily-report">「日报」</a>里设置时间和内容。</p>}
      </div>

      <div className="task-form-step">
        <span className="task-form-label">要{chosen.name}做什么</span>
        {examples.length > 0 && (
          <div className="task-examples">
            <span className="muted small">可以从这里开始：</span>
            {examples.map(x => (
              <button key={x.title} type="button" className="example-chip" onClick={() => { setTitle(x.title); setPrompt(x.prompt) }}>{x.title}</button>
            ))}
          </div>
        )}
        <label className="field-label">名字<input className="text-input plain" value={title} maxLength={60} onChange={e => setTitle(e.target.value)} placeholder="例如：看今天结束的活动" /></label>
        <label className="field-label">交给它的话<textarea className="text-input plain" rows={3} value={prompt} maxLength={4000} onChange={e => setPrompt(e.target.value)} placeholder="写完整：要做什么、要交回什么" /></label>
      </div>

      <div className="task-form-step">
        <span className="task-form-label">什么时候</span>
        <div className="task-form-row">
          <label className="field-label">时间<input className="text-input plain-mono" value={times} onChange={e => setTimes(e.target.value)} placeholder="09:00, 21:30" /></label>
          <div className="field-label">星期
            <div className="day-chips">
              <button type="button" className={`day-preset ${days.length === 0 ? 'on' : ''}`} aria-pressed={days.length === 0} onClick={() => setDays([])}>每天</button>
              <button type="button" className={`day-preset ${same(days, WORKDAYS) ? 'on' : ''}`} aria-pressed={same(days, WORKDAYS)} onClick={() => setDays(WORKDAYS)}>工作日</button>
              <button type="button" className={`day-preset ${same(days, WEEKEND) ? 'on' : ''}`} aria-pressed={same(days, WEEKEND)} onClick={() => setDays(WEEKEND)}>周末</button>
              <span className="day-chips-gap" />
              {WEEK_ORDER.map(d => (
                <button key={d} type="button" className={`day-chip ${days.includes(d) ? 'on' : ''}`} aria-pressed={days.includes(d)}
                  onClick={() => setDays(days.includes(d) ? days.filter(x => x !== d) : [...days, d])}>{DAYS[d]}</button>
              ))}
            </div>
          </div>
        </div>
      </div>
      {error !== null && <div className="error small">{error}</div>}
      <div className="task-form-actions">
        <button className="small-button" onClick={onDone} disabled={busy}>取消</button>
        <button className="small-button primary" onClick={() => void save()} disabled={busy || title.trim() === '' || prompt.trim() === ''}>{task.id === undefined ? `交给${chosen.name}` : '保存'}</button>
      </div>
    </div>
  )
}

/**
 * When an agent sets a timed task or a reminder with its own tool (in a
 * conversation, or a sub-agent's), a box says so — who set it, for whom,
 * what, when — with the way to it on 定时. It goes by itself after a while.
 */
export function ScheduleNotices({ client, onOpen }: { client: AdgClient; onOpen: (id: string | undefined) => void }) {
  const agents = useAgents(client)
  const [notices, setNotices] = useState<readonly (ScheduleAgentSet & { key: number })[]>([])
  const next = useRef(0)
  useEffect(() => client.connection.on('schedule/agentSet', notice => {
    const key = next.current++
    setNotices(list => [...list.slice(-2), { ...notice, key }])
    setTimeout(() => setNotices(list => list.filter(n => n.key !== key)), 20_000)
  }), [client])
  if (notices.length === 0) return null
  const close = (key: number) => setNotices(list => list.filter(n => n.key !== key))
  return (
    <div className="schedule-notices" aria-live="polite">
      {notices.map(n => {
        const by = agents.find(a => a.id === n.by)
        const to = agents.find(a => a.id === n.agent)
        const what = n.kind === 'task' ? (n.changed ? '改了一个定时任务' : '设了一个定时任务') : '设了一个提醒'
        return (
          <div key={n.key} className="schedule-notice" role="status">
            <Avatar agent={by} size="" />
            <div className="schedule-notice-text">
              <span className="schedule-notice-head">{by?.name ?? 'agent'}{what}</span>
              <span className="schedule-notice-title">{n.title}</span>
              <span className="muted small">{n.kind === 'task' && n.agent !== n.by ? `交给${to?.name ?? n.agent}` : ''}{n.kind === 'task' && n.agent !== n.by && n.when !== '' ? ' · ' : ''}{n.when}</span>
              <span className="schedule-notice-actions">
                <button className="small-button primary" onClick={() => { close(n.key); onOpen(n.id) }}><Icon name="calendar" />去定时任务看看</button>
              </span>
            </div>
            <button className="icon-button" onClick={() => close(n.key)} title="知道了" aria-label="关闭"><Icon name="close" /></button>
          </div>
        )
      })}
    </div>
  )
}
