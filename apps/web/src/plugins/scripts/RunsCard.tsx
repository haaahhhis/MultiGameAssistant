import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { RunInfo, RunLogLine, TaskInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { relativeTime } from '../../components/SessionList.tsx'
import { errorText } from './data.ts'

const STATE: Readonly<Record<RunInfo['state'], [string, string]>> = {
  starting: ['', '启动中'], running: ['', '运行中'], stopping: ['warn', '停止中'],
  succeeded: ['ok', '成功'], failed: ['warn', '失败'], cancelled: ['', '已停止'],
}
const INPUT: Readonly<Record<TaskInfo['input'], string>> = { desktop: '占用鼠标键盘', window: '后台窗口', adb: '模拟器', none: '不占用' }

/** A script's tasks with a run form, and its recent runs with a live log. */
export function RunsCard({ client, scriptId, packId }: { client: AdgClient; scriptId: string; packId: string | undefined }) {
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [tasks, setTasks] = useState<{ tasks: TaskInfo[]; runnable: boolean; problem?: string | undefined } | null>(null)
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [taskId, setTaskId] = useState('')
  const [values, setValues] = useState<Record<string, string>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shown, setShown] = useState<string | null>(null)

  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('runs/tasks', { scriptId }).then(r => {
      if (!live) return
      setTasks(r)
      setTaskId(id => id === '' ? r.tasks[0]?.id ?? '' : id)
    }).catch(e => { if (live) setError(errorText(e)) })
    client.connection.call('runs/list', { scriptId }).then(r => { if (live) setRuns(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, scriptId, packId, status.state])

  useEffect(() => client.connection.on('runs/state', run => {
    if (run.scriptId !== scriptId) return
    setRuns(list => [run, ...list.filter(r => r.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt))
  }), [client, scriptId])

  const task = tasks?.tasks.find(t => t.id === taskId)
  useEffect(() => {
    if (task === undefined) return
    setValues(Object.fromEntries(Object.entries(task.params).map(([k, p]) => [k, p.default === undefined ? '' : String(p.default)])))
  }, [task?.id])

  const active = runs.find(r => r.endedAt === undefined)
  const viewing = runs.find(r => r.id === (shown ?? active?.id ?? runs[0]?.id))

  const start = async () => {
    if (task === undefined) return
    setBusy(true)
    setError(null)
    try {
      const params: Record<string, string | number | boolean> = {}
      for (const [name, spec] of Object.entries(task.params)) {
        const raw = values[name] ?? ''
        if (raw === '') continue
        params[name] = spec.type === 'boolean' ? raw === 'true' : spec.type === 'integer' || spec.type === 'number' ? Number(raw) : raw
      }
      const run = await client.connection.call('runs/start', { scriptId, taskId: task.id, params })
      setShown(run.id)
      if (run.state === 'failed') setError(run.outcome ?? '运行失败')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div><h3>任务</h3><p className="muted small">按脚本包运行，使用本地配置；原项目的配置在运行结束后会还原。</p></div>
      </div>
      {tasks === null && error === null && <div className="muted small">加载中…</div>}
      {tasks !== null && !tasks.runnable && <div className="notice info left small">{tasks.problem}</div>}
      {tasks !== null && tasks.tasks.length > 0 && (
        <div className="run-form">
          <label className="field-label" htmlFor="task-select">任务</label>
          <select id="task-select" className="text-input plain" value={taskId} onChange={e => setTaskId(e.target.value)}>
            {tasks.tasks.map(t => <option key={t.id} value={t.id}>{t.title}（{t.id}）</option>)}
          </select>
          {task !== undefined && (
            <div className="task-facts muted small">
              <span className="badge">{INPUT[task.input]}</span>
              {task.account !== undefined && <span className="badge">账号 {task.account}</span>}
              {task.expectedDuration !== undefined && <span>约 {task.expectedDuration}</span>}
              {task.description !== undefined && <span>{task.description}</span>}
            </div>
          )}
          {task !== undefined && Object.entries(task.params).map(([name, spec]) => (
            <label key={name} className="param-row">
              <span className="field-label">{name}{spec.description === undefined ? '' : ` · ${spec.description}`}</span>
              {spec.type === 'boolean' ? (
                <select className="text-input plain" value={values[name] ?? ''} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}>
                  <option value="true">是</option><option value="false">否</option>
                </select>
              ) : spec.enum !== undefined ? (
                <select className="text-input plain" value={values[name] ?? ''} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))}>
                  {spec.enum.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
                </select>
              ) : (
                <input className="text-input plain" value={values[name] ?? ''} placeholder={spec.default === undefined ? '必填' : String(spec.default)}
                  inputMode={spec.type === 'string' ? 'text' : 'numeric'} onChange={e => setValues(v => ({ ...v, [name]: e.target.value }))} />
              )}
            </label>
          ))}
          <div className="key-actions">
            <span className="spacer" />
            {active !== undefined && <button className="danger-outline small-button" onClick={() => void client.connection.call('runs/stop', { runId: active.id }).catch(e => setError(errorText(e)))}>停止当前运行</button>}
            <button className="primary small-button" disabled={busy || !tasks.runnable || active !== undefined} onClick={() => void start()}><Icon name="arrow" />{busy ? '启动中…' : '运行'}</button>
          </div>
        </div>
      )}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}

      {runs.length > 0 && (
        <div className="run-history">
          <div className="sidebar-label">最近运行</div>
          {runs.slice(0, 6).map(run => {
            const [tone, label] = STATE[run.state]
            return (
              <button key={run.id} className={`run-row ${run.id === viewing?.id ? 'active' : ''}`} onClick={() => setShown(run.id)}>
                <span className={`badge ${tone}`}>{label}</span>
                <span className="run-title">{run.taskTitle}</span>
                <span className="muted small run-outcome">{run.outcome ?? run.resources.join(' · ')}</span>
                <span className="session-time">{relativeTime(run.startedAt, now)}</span>
              </button>
            )
          })}
          {viewing !== undefined && <RunLog key={viewing.id} client={client} run={viewing} />}
        </div>
      )}
    </section>
  )
}

function RunLog({ client, run }: { client: AdgClient; run: RunInfo }) {
  const [lines, setLines] = useState<RunLogLine[]>([])
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    let live = true
    client.connection.call('runs/logs', { runId: run.id, limit: 500 }).then(r => { if (live) setLines(r.lines) }).catch(() => {})
    const off = client.connection.on('runs/log', update => {
      if (update.runId === run.id) setLines(list => [...list, ...update.lines].slice(-1000))
    })
    return () => { live = false; off() }
  }, [client, run.id])
  useEffect(() => {
    const el = box.current
    if (el !== null) el.scrollTop = el.scrollHeight
  }, [lines.length])
  const warnings = useMemo(() => run.warnings, [run.warnings])
  return (
    <div className="run-log-wrap">
      {warnings.map(w => <div key={w} className="notice info left small"><Icon name="info" /><span>{w}</span></div>)}
      <div className="run-log" ref={box} role="log" aria-label="运行日志">
        {lines.length === 0 && <div className="muted small">还没有日志</div>}
        {lines.map((line, index) => (
          <div key={index} className={`log-line ${line.level ?? ''} ${line.source === 'adg' ? 'adg' : ''}`}>
            <span className="log-time">{new Date(line.at).toLocaleTimeString()}</span>
            <span className="log-source">{line.source === 'adg' ? '平台' : line.source}</span>
            <span className="log-text">{line.text}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
