import { createContext, useContext, useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { Incident, Intervention, MonitorSettings, RunInfo } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { Fold } from '../../components/Fold.tsx'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { RunLog, RUN_STATE } from '../scripts/RunsCard.tsx'
import { errorText } from '../scripts/data.ts'

/** The agent's interventions by incident, and opening its session, for the incident rows. */
const Agent = createContext<{ byIncident: ReadonlyMap<string, Intervention>; openSession: (id: string) => void }>({ byIncident: new Map(), openSession: () => {} })

const IV_STATE: Readonly<Record<Intervention['state'], string>> = {
  running: 'agent 正在处理', resolved: 'agent 已处理', retried: 'agent 处理后重新运行', 'gave-up': 'agent 处理不了', 'taken-over': '你接管了', timeout: 'agent 超时', failed: 'agent 没能开始',
}

const KIND: Readonly<Record<Incident['kind'], string>> = { error: '出错', warning: '警告', failed: '失败', stalled: '卡住', overtime: '超时' }

/** Every run across scripts with its live log, and the incidents the monitor raised. */
export function RunsPage({ client, openSettings, openSession }: PageProps) {
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [runs, setRuns] = useState<RunInfo[]>([])
  const [incidents, setIncidents] = useState<Incident[]>([])
  const [selected, setSelected] = useState<string | null>(null)
  const [showSettings, setShowSettings] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [interventions, setInterventions] = useState<Intervention[]>([])
  const capabilities = useStore(client.capabilities)
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('intervene')) return
    let live = true
    client.connection.call('intervene/list', { limit: 100 }).then(r => { if (live) setInterventions(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, capabilities])
  useEffect(() => client.connection.on('intervene/changed', item => {
    setInterventions(list => [item, ...list.filter(i => i.id !== item.id)])
  }), [client])
  const agent = useMemo(() => {
    const byIncident = new Map<string, Intervention>()
    for (const item of [...interventions].sort((a, b) => a.startedAt - b.startedAt)) if (item.incidentId !== undefined) byIncident.set(item.incidentId, item)
    return { byIncident, openSession }
  }, [interventions, openSession])

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
    <Agent.Provider value={agent}>
    <section className="main scripts-page">
      <header className="page-header">
        <div className="breadcrumb"><span>运行</span><span className="breadcrumb-divider">/</span><h1>运行监控</h1></div>
        <div className="page-actions">
          <button className="small-button" onClick={() => openSettings('feishu')}><Icon name="plug" />消息通知</button>
          <button className={`small-button ${showSettings ? 'primary' : ''}`} onClick={() => setShowSettings(v => !v)}><Icon name="settings" />监控设置</button>
        </div>
      </header>
      <div className="scripts-body">
        <aside className="scripts-list" aria-label="运行列表">
          {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
          <Fold id="monitor.active" title="正在运行" count={active.length} className="list-fold">
            {active.length === 0 && <div className="muted small pad">没有正在运行的任务</div>}
            {active.map(row)}
          </Fold>
          {recent.length > 0 && (
            <Fold id="monitor.recent" title="最近" count={recent.length} className="list-fold">
              {recent.map(row)}
            </Fold>
          )}
        </aside>
        <div className="scripts-detail">
          <div className="script-detail">
            {showSettings && <MonitorSettingsCard client={client} />}
            {open.length > 0 && (
              <section className="card">
                <Fold id="monitor.open-incidents" title={<h3>待处理的异常（{open.length}）</h3>} className="card-fold">
                  <p className="muted small">脚本包里写了自动处理的（如重连模拟器、重新运行）会先自动处理；处理不了的才推送到飞书。</p>
                  <div className="incident-list">{open.map(i => <IncidentRow key={i.id} client={client} incident={i} now={now} onOpen={() => setSelected(i.runId)} />)}</div>
                </Fold>
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
    </Agent.Provider>
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
      <Fold id="monitor.run-log" title="日志">
        <RunLog key={run.id} client={client} run={run} />
      </Fold>
      {incidents.length > 0 && (
        <Fold id="monitor.run-incidents" title="这次运行的异常" count={incidents.length}>
          <div className="incident-list">
            {incidents.map(i => <IncidentRow key={i.id} client={client} incident={i} now={now} />)}
          </div>
        </Fold>
      )}
    </section>
  )
}

function IncidentRow({ client, incident, now, onOpen }: { client: AdgClient; incident: Incident; now: number; onOpen?: () => void }) {
  const { byIncident, openSession } = useContext(Agent)
  const iv = byIncident.get(incident.id)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [shot, setShot] = useState<string | null>(null)
  const takeover = async () => {
    if (iv === undefined) return
    setBusy(true)
    setError(null)
    try {
      await client.connection.call('intervene/takeover', { id: iv.id })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const act = async (action: 'stop' | 'retry' | 'resolve' | 'resume') => {
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
          {/* The agent's own conclusion is shown once, in its line below. */}
          {incident.steps.filter(s => iv?.summary === undefined || iv.state === 'running' || !s.detail.endsWith(iv.summary)).map((s, index) => <li key={index} className={s.ok ? 'ok' : 'failed'}>{s.ok ? '✓' : '✗'} {s.detail}</li>)}
        </ul>
      )}
      {incident.status === 'resolved' && <div className="muted small">已处理：{incident.resolution}</div>}
      {iv !== undefined && (
        <div className={`agent-line ${iv.state}`}>
          <span className="badge">{IV_STATE[iv.state]}{iv.mode === 'diagnose' ? '（只诊断）' : ''}</span>
          {iv.summary !== undefined && <span className="small">{iv.summary}</span>}
          {iv.paused && <span className="badge warn">脚本暂停中</span>}
          <span className="spacer" />
          {iv.sessionId !== undefined && <button className="link-button small" onClick={() => openSession(iv.sessionId!)}>看 agent 的处理过程</button>}
          {iv.state === 'running' && <button className="small-button" disabled={busy} onClick={() => void takeover()}>我来接管</button>}
        </div>
      )}
      {incident.status === 'open' && (
        <div className="key-actions">
          {incident.screenshot && <button className="small-button" onClick={() => void showShot()}><Icon name="image" />{shot === null ? '截图' : '收起截图'}</button>}
          <span className="spacer" />
          {iv?.paused === true && <button className="primary small-button" disabled={busy} onClick={() => void act('resume')}>继续</button>}
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
          <label className="field-label" htmlFor="intervene-mode">自动处理解决不了的问题，先交给 agent（需要能看图的模型）</label>
          <select id="intervene-mode" className="text-input plain" value={settings.intervene} onChange={e => void set({ intervene: e.target.value as MonitorSettings['intervene'] })}>
            <option value="act">诊断并处理：暂停脚本，agent 看屏幕、点击和输入来解决（推荐）</option>
            <option value="diagnose">只诊断：agent 看截图说明原因，由你决定</option>
            <option value="off">关闭：直接通知我</option>
          </select>
          <label className="field-label" htmlFor="intervene-cap">每天最多交给 agent 几次（控制模型费用）</label>
          <input id="intervene-cap" className="text-input plain" type="number" min={0} max={200} defaultValue={settings.interventionsPerDay}
            onBlur={e => void set({ interventionsPerDay: Math.max(0, Math.min(200, Math.round(Number(e.target.value) || 0))) })} />
        </>
      )}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}
