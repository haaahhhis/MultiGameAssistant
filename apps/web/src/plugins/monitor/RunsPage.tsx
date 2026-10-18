import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { Incident, MonitorSettings, RunInfo } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { RunLog, RUN_STATE } from '../scripts/RunsCard.tsx'
import { errorText } from '../scripts/data.ts'

const KIND: Readonly<Record<Incident['kind'], string>> = { error: '出错', warning: '警告', failed: '失败', stalled: '卡住', overtime: '超时' }

/** Every run across scripts with its live log, and the incidents the monitor raised. */
export function RunsPage({ client, openSettings }: PageProps) {
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('runs/list', {}).then(r => { if (live) setRuns(r.items) }).catch(e => { if (live) setError(errorText(e)) })
    client.connection.call('monitor/incidents', { status: 'all', limit: 200 }).then(r => { if (live) setIncidents(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state])
  useEffect(() => client.connection.on('runs/state', run => {
    setRuns(list => [run, ...list.filter(r => r.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt))
  }), [client])
  useEffect(() => client.connection.on('monitor/incident', incident => {
    setIncidents(list => [incident, ...list.filter(i => i.id !== incident.id)].sort((a, b) => b.createdAt - a.createdAt))
  }), [client])

  const active = runs.filter(r => r.endedAt === undefined)
  const recent = runs.filter(r => r.endedAt !== undefined).slice(0, 30)
  const open = incidents.filter(i => i.status === 'open')
  const run = runs.find(r => r.id === (selected ?? active[0]?.id ?? runs[0]?.id))
  const openByRun = useMemo(() => {
    const map = new Map<string, number>()
    for (const i of open) map.set(i.runId, (map.get(i.runId) ?? 0) + 1)
    return map
  }, [open])

  const row = (r: RunInfo) => {
    const [tone, label] = RUN_STATE[r.state]
    const count = openByRun.get(r.id) ?? 0
    return (
      <button key={r.id} className={`script-row ${r.id === run?.id ? 'active' : ''}`} onClick={() => setSelected(r.id)}>
        <span className="script-row-main">
          <span className="script-row-name">{r.scriptName} · {r.taskTitle}</span>
          <span className="muted small">{r.kind === 'settings' ? '设置会话 · ' : ''}{relativeTime(r.startedAt, now)}{r.retryOf === undefined ? '' : ' · 重新运行'}</span>
        </span>
        {count > 0 ? <span className="badge warn">异常 {count}</span> : <span className={`badge ${tone}`}>{label}</span>}
      </button>
    )
  }

  return (
    <section className="main scripts-page">
      <header className="page-header">
        <div className="breadcrumb"><span>运行</span><span className="breadcrumb-divider">/</span><h1>运行监控</h1></div>
        <div className="page-actions">
          <button className="small-button" onClick={() => openSettings()}><Icon name="plug" />消息通知</button>
          <button className={`small-button ${showSettings ? 'primary' : ''}`} onClick={() => setShowSettings(v => !v)}><Icon name="settings" />监控设置</button>
        </div>
      </header>
      <div className="scripts-body">
        <aside className="scripts-list" aria-label="运行列表">
          {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
          <div className="sidebar-label">正在运行（{active.length}）</div>
          {active.length === 0 && <div className="muted small pad">没有正在运行的任务</div>}
          {active.map(row)}
          {recent.length > 0 && <div className="sidebar-label pack-label">最近</div>}
          {recent.map(row)}
        </aside>
        <div className="scripts-detail">
          <div className="script-detail">
            {showSettings && <MonitorSettingsCard client={client} />}
            {open.length > 0 && (
              <section className="card">
                <div className="card-head"><div><h3>待处理的异常（{open.length}）</h3><p className="muted small">脚本包里写了自动处理的（如重连模拟器、重新运行）会先自动处理；处理不了的才推送到飞书。</p></div></div>
                <div className="incident-list">{open.map(i => <IncidentRow key={i.id} client={client} incident={i} now={now} onOpen={() => setSelected(i.runId)} />)}</div>
              </section>
            )}
            {run === undefined && open.length === 0 && (
              <div className="empty"><Icon name="monitor" /><p>还没有运行记录。在「脚本」页运行一个任务，或对 agent 说「跑一下方舟日常」。</p></div>
            )}
            {run !== undefined && <RunCard client={client} run={run} incidents={incidents.filter(i => i.runId === run.id)} now={now} openRun={setSelected} />}
          </div>
        </div>
      </div>
    </section>
  )
}

function RunCard({ client, run, incidents, now, openRun }: { client: AdgClient; run: RunInfo; incidents: Incident[]; now: number; openRun: (id: string) => void }) {
  const [tone, label] = RUN_STATE[run.state]
  const [error, setError] = useState<string | null>(null)
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>{run.scriptName} · {run.taskTitle}</h3>
          <p className="muted small">
            {new Date(run.startedAt).toLocaleString('zh-CN', { hour12: false })}
            {run.endedAt === undefined ? '' : ` → ${new Date(run.endedAt).toLocaleTimeString('zh-CN', { hour12: false })}`}
            {run.resources.length > 0 ? ` · ${run.resources.join(' · ')}` : ''}
          </p>
        </div>
        <div className="key-actions">
          <span className={`badge ${tone}`}>{label}</span>
          {run.endedAt === undefined && <button className="danger-outline small-button" onClick={() => void client.connection.call('runs/stop', { runId: run.id }).catch(e => setError(errorText(e)))}>停止</button>}
        </div>
      </div>
      {run.outcome !== undefined && <div className="muted small">结果：{run.outcome}</div>}
      {run.retryOf !== undefined && <button className="link-button small" onClick={() => openRun(run.retryOf!)}>这是 {run.retryOf} 的重新运行</button>}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
      <RunLog key={run.id} client={client} run={run} />
      {incidents.length > 0 && (
        <div className="incident-list">
          <div className="sidebar-label">这次运行的异常</div>
          {incidents.map(i => <IncidentRow key={i.id} client={client} incident={i} now={now} />)}
        </div>
      )}
    </section>
  )
}

function IncidentRow({ client, incident, now, onOpen }: { client: AdgClient; incident: Incident; now: number; onOpen?: () => void }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shot, setShot] = useState<string | null>(null)
  const act = async (action: 'stop' | 'retry' | 'resolve') => {
    setBusy(true)
    setError(null)
    try {
      await client.connection.call('monitor/act', { incidentId: incident.id, action })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const showShot = async () => {
    if (shot !== null) return setShot(null)
    try {
      const image = await client.connection.call('monitor/screenshot', { incidentId: incident.id })
      setShot(`data:${image.mime};base64,${image.data}`)
    } catch (e) {
      setError(errorText(e))
    }
  }
  return (
    <div className={`incident ${incident.severity} ${incident.status}`}>
      <div className="incident-head">
        <span className={`badge ${incident.severity === 'error' ? 'warn' : ''}`}>{KIND[incident.kind]}</span>
        {onOpen === undefined ? <span className="incident-title">{incident.title}</span> : <button className="link-button incident-title" onClick={onOpen}>{incident.title}</button>}
        <span className="session-time">{relativeTime(incident.createdAt, now)}</span>
      </div>
      <div className="incident-detail">{incident.detail}</div>
      {incident.steps.length > 0 && (
        <ul className="incident-steps">
          {incident.steps.map((s, index) => <li key={index} className={s.ok ? 'ok' : 'failed'}>{s.ok ? '✓' : '✗'} {s.detail}</li>)}
        </ul>
      )}
      {incident.status === 'resolved' && <div className="muted small">已处理：{incident.resolution}</div>}
      {incident.status === 'open' && (
        <div className="key-actions">
          {incident.screenshot && <button className="small-button" onClick={() => void showShot()}><Icon name="image" />{shot === null ? '截图' : '收起截图'}</button>}
          <span className="spacer" />
          <button className="danger-outline small-button" disabled={busy} onClick={() => void act('stop')}>停止</button>
          <button className="small-button" disabled={busy} onClick={() => void act('retry')}>重试</button>
          <button className="small-button" disabled={busy} onClick={() => void act('resolve')}>忽略</button>
        </div>
      )}
      {shot !== null && <img className="incident-shot" src={shot} alt="异常时的截图" />}
      {error !== null && <div className="notice error left small"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}

function MonitorSettingsCard({ client }: { client: AdgClient }) {
  const [settings, setSettings] = useState<MonitorSettings | null>(null)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { client.connection.call('monitor/settings', {}).then(setSettings).catch(e => setError(errorText(e))) }, [client])
  const set = (patch: Partial<MonitorSettings>) => client.connection.call('monitor/settings/set', patch).then(setSettings).catch(e => setError(errorText(e)))
  return (
    <section className="card">
      <h3>监控设置</h3>
      {settings !== null && (
        <>
          <label className="field-label" htmlFor="stall-minutes">多少分钟没有新日志算卡住（脚本包没写时；0 = 不检测）</label>
          <input id="stall-minutes" className="text-input plain" type="number" min={0} max={1440} defaultValue={settings.defaultStallMinutes}
            onBlur={e => void set({ defaultStallMinutes: Math.max(0, Math.min(1440, Math.round(Number(e.target.value) || 0))) })} />
          <label className="check-label"><input type="checkbox" checked={settings.screenshot} onChange={e => void set({ screenshot: e.target.checked })} />出错时截图（模拟器画面或桌面）并随通知发送</label>
          <label className="check-label"><input type="checkbox" checked={settings.notifyWarnings} onChange={e => void set({ notifyWarnings: e.target.checked })} />警告也推送（默认只推送出错、失败、卡住）</label>
        </>
      )}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}
