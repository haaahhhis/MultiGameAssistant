import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { isMarker, withStartEnd } from '@adg/protocol'
import type { Pipeline, PipelineCheck, PipelineRun, PipelineSummary, ScheduleSettings } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'
import { PipelineEditor } from './PipelineEditor.tsx'

const RUN_STATE: Readonly<Record<PipelineRun['state'], [string, string]>> = {
  running: ['', '运行中'], succeeded: ['ok', '成功'], failed: ['warn', '有失败'], cancelled: ['', '已取消'],
}

const blank = (): Pipeline => ({
  id: `pipeline-${Date.now().toString(36)}`,
  name: '新流水线',
  nodes: [{ id: 'start', kind: 'start', position: { x: 40, y: 120 } }, { id: 'end', kind: 'end', position: { x: 360, y: 120 } }],
  edges: [],
  onFailure: { retries: 0, then: 'continue' },
  schedule: { enabled: false, times: [], days: [], catchUpMinutes: 10 },
  stopEmulatorAfter: false,
  closeGameAfter: false,
  powerAfter: 'none',
})

/** Pipelines: the list, the canvas editor, runs. */
export function PipelinesPage({ client, openSettings, arg }: PageProps) {
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [list, setList] = useState<PipelineSummary[] | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const [pipeline, setPipeline] = useState<Pipeline | null>(null)
  const [saved, setSaved] = useState<string>('')
  const [runs, setRuns] = useState<PipelineRun[]>([])
  const [shownRun, setShownRun] = useState<string | null>(null)
  const [check, setCheck] = useState<PipelineCheck | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)

  useEffect(() => client.connection.on('pipelines/changed', () => setRevision(r => r + 1)), [client])
  // Which pipelines run when the app starts (the scheduler's settings; shown per pipeline here).
  const capabilities = useStore(client.capabilities)
  const [startup, setStartup] = useState<ScheduleSettings | null>(null)
  const [startupRevision, setStartupRevision] = useState(0)
  useEffect(() => client.connection.on('schedule/changed', () => setStartupRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('schedule')) return
    let live = true
    client.connection.call('schedule/status', {}).then(r => { if (live) setStartup(r.settings) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, capabilities, startupRevision])
  const setStartupSettings = async (patch: Partial<ScheduleSettings>) => {
    try { setStartup((await client.connection.call('schedule/settings/set', patch)).settings) } catch (e) { setError(errorText(e)) }
  }
  // A link to one pipeline (#/p/pipelines/<id>) opens it.
  useEffect(() => { if (arg !== undefined) setSelected(arg) }, [arg])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('pipelines/list', {}).then(r => {
      if (!live) return
      setList(r.items)
      setSelected(id => id ?? r.items[0]?.id ?? null)
    }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, revision])

  // Load the selected pipeline (unless it is a new one still being drawn).
  useEffect(() => {
    if (selected === null || status.state !== 'open') return
    if (pipeline?.id === selected && list?.every(p => p.id !== selected)) return
    let live = true
    client.connection.call('pipelines/get', { id: selected }).then(got => {
      if (!live) return
      // Older pipelines get 开始 and 结束 on the canvas; they are saved with the next change.
      const p = withStartEnd(got)
      setPipeline(p)
      setSaved(JSON.stringify(p))
      setCheck(null)
    }).catch(() => {})
    client.connection.call('pipelines/runs', { pipelineId: selected, limit: 10 }).then(r => { if (live) setRuns(r.items) }).catch(() => {})
    setShownRun(null)
    return () => { live = false }
  }, [client, selected, status.state, revision])

  useEffect(() => client.connection.on('pipelines/run', run => {
    if (run.pipelineId !== selected) return
    setRuns(list => [run, ...list.filter(r => r.id !== run.id)].sort((a, b) => b.startedAt - a.startedAt).slice(0, 10))
  }), [client, selected])

  const dirty = pipeline !== null && JSON.stringify(pipeline) !== saved
  const isNew = pipeline !== null && list !== null && list.every(p => p.id !== pipeline.id)
  const run = runs.find(r => r.id === (shownRun ?? runs[0]?.id))
  const activeRun = runs.find(r => r.state === 'running')

  // A changed pipeline is checked again shortly after the change.
  useEffect(() => {
    if (pipeline === null || !pipeline.nodes.some(n => !isMarker(n))) { setCheck(null); return }
    const timer = setTimeout(() => {
      client.connection.call('pipelines/check', { pipeline }).then(setCheck).catch(() => {})
    }, 400)
    return () => clearTimeout(timer)
  }, [client, pipeline])

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name)
    setError(null)
    try {
      await fn()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const save = () => act('save', async () => {
    if (pipeline === null) return
    const result = await client.connection.call('pipelines/save', { pipeline })
    setPipeline(result.pipeline)
    setSaved(JSON.stringify(result.pipeline))
    setCheck(result.check)
    setSelected(result.pipeline.id)
  })
  const runNow = (from?: string) => act('run', async () => {
    if (pipeline === null) return
    if (dirty || isNew) await save()
    const started = await client.connection.call('pipelines/run', { id: pipeline.id, ...(from === undefined ? {} : { from }) })
    setShownRun(started.id)
  })
  const remove = () => act('remove', async () => {
    if (pipeline === null) return
    if (!isNew) await client.connection.call('pipelines/remove', { id: pipeline.id })
    setPipeline(null)
    setSelected(null)
  })

  const update = useCallback((next: Pipeline) => setPipeline(next), [])
  const create = () => { const p = blank(); setPipeline(p); setSaved(''); setSelected(p.id); setRuns([]); setCheck(null) }

  return (
    <section className="main scripts-page pipelines-page">
      <header className="page-header">
        <div className="breadcrumb"><span>编排</span><span className="breadcrumb-divider">/</span><h1>流水线</h1></div>
        <PipelineSwitcher list={list ?? []} current={pipeline} isNew={isNew} now={now} onPick={setSelected} />
        <div className="page-actions">
          <button className="small-button" onClick={() => openSettings('schedule')}><Icon name="settings" />定时与自启</button>
          <button className="primary small-button" onClick={create}><Icon name="plus" />新建流水线</button>
        </div>
      </header>
      <div className="pipeline-main">
          {pipeline === null ? (
            <div className="empty"><Icon name="flow" />
              {list !== null && list.length === 0
                ? <><p>还没有流水线。</p><p className="muted small">新建一条，或对 agent 说「先跑方舟日常，同时跑三月七，都完了发飞书」</p></>
                : <p>在上面选一条流水线，或新建一条。</p>}
            </div>
          ) : (
            <>
              <div className="pipeline-toolbar">
                <input className="text-input plain pipeline-name" value={pipeline.name} maxLength={60} aria-label="流水线名称" onChange={e => setPipeline({ ...pipeline, name: e.target.value })} />
                {pipeline.draft === true && <span className="badge warn" title="agent 生成的草稿：保存后才会按定时运行">agent 草稿</span>}
                {dirty && <span className="muted small">未保存</span>}
                <span className="spacer" />
                {activeRun !== undefined
                  ? <button className="danger-outline small-button" disabled={busy !== null} onClick={() => void act('cancel', () => client.connection.call('pipelines/cancel', { runId: activeRun.id }))}>取消运行</button>
                  : <button className="small-button" disabled={busy !== null || !pipeline.nodes.some(n => !isMarker(n)) || check?.ok === false} onClick={() => void runNow()}><Icon name="arrow" />运行</button>}
                <button className="primary small-button" disabled={busy !== null || (!dirty && !isNew && pipeline.draft !== true)} onClick={() => void save()}>{busy === 'save' ? '保存中…' : pipeline.draft === true && !dirty ? '确认并保存' : '保存'}</button>
                <button className="small-button" disabled={busy !== null || activeRun !== undefined} onClick={() => { if (confirm(`删除流水线「${pipeline.name}」？`)) void remove() }}>删除</button>
              </div>
              {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
              <PipelineEditor key={pipeline.id} client={client} pipeline={pipeline} onChange={update} run={run} check={check}
                runFrom={activeRun !== undefined || busy !== null || check?.ok === false ? undefined : nodeId => void runNow(nodeId)}
                idle={<PipelineSide pipeline={pipeline} check={check} runs={runs} shownRun={run?.id} onShowRun={setShownRun} others={list ?? []} onChange={update} now={now} startup={startup} onStartup={patch => void setStartupSettings(patch)} />} />
            </>
          )}
      </div>
    </section>
  )
}

function ChecksCard({ check, pipeline }: { check: PipelineCheck | null; pipeline: Pipeline }) {
  if (check === null) return null
  const title = (id?: string) => {
    const node = pipeline.nodes.find(n => n.id === id)
    return node === undefined ? '' : `${node.title ?? node.id}：`
  }
  return (
    <section className="side-pane">
      <div className="card-head">
        <div><h3>运行前检查</h3><p className="muted small">{check.estimateMinutes === undefined ? '部分任务没有预计时长' : `预计约 ${check.estimateMinutes} 分钟`}</p></div>
        <span className={`badge ${check.ok ? 'ok' : 'warn'}`}>{check.ok ? '可以运行' : '有问题'}</span>
      </div>
      {check.issues.length === 0 && <div className="muted small">没有发现问题。</div>}
      <ul className="incident-steps">
        {check.issues.map((issue, index) => (
          <li key={index} className={issue.level === 'error' ? 'failed' : issue.level === 'warning' ? 'failed' : ''}>
            {issue.level === 'error' ? '✗' : issue.level === 'warning' ? '!' : 'ℹ'} {title(issue.nodeId)}{issue.message}
          </li>
        ))}
      </ul>
    </section>
  )
}

function RunsList({ runs, shown, onShow, now }: { runs: PipelineRun[]; shown: string | undefined; onShow: (id: string) => void; now: number }) {
  if (runs.length === 0) return <section className="side-pane"><p className="muted small">还没有运行过。</p></section>
  const TRIGGER: Record<string, string> = { manual: '手动', schedule: '定时', autostart: '启动时', agent: 'agent', after: '接续' }
  return (
    <section className="side-pane">
      <div className="run-history">
        {runs.map(r => (
          <button key={r.id} className={`run-row ${r.id === shown ? 'active' : ''}`} onClick={() => onShow(r.id)}>
            <span className={`badge ${RUN_STATE[r.state][0]}`}>{RUN_STATE[r.state][1]}</span>
            <span className="run-title">{TRIGGER[r.trigger.kind] ?? r.trigger.kind}</span>
            <span className="muted small run-outcome">{r.outcome ?? '…'}</span>
            <span className="session-time">{relativeTime(r.startedAt, now)}</span>
          </button>
        ))}
      </div>
      <p className="muted small">选中一次运行，画布上的节点会显示它的状态；点节点看详情和对应的脚本运行。</p>
    </section>
  )
}

/** Which pipeline: a dropdown in the header, so the canvas gets the width. */
function PipelineSwitcher({ list, current, isNew, now, onPick }: { list: PipelineSummary[]; current: Pipeline | null; isNew: boolean; now: number; onPick: (id: string) => void }) {
  const [open, setOpen] = useState(false)
  const box = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false) }
    document.addEventListener('mousedown', close)
    return () => document.removeEventListener('mousedown', close)
  }, [open])
  if (list.length === 0 && current === null) return <span className="spacer" />
  return (
    <div className="pipeline-switcher" ref={box}>
      <button className="small-button switcher-button" aria-haspopup="listbox" aria-expanded={open} onClick={() => setOpen(o => !o)}>
        <Icon name="flow" /><span className="switcher-name">{current?.name ?? '选择流水线'}{isNew ? '（未保存）' : ''}</span>
        <span className="muted small">{list.length} 条</span><Icon name="chevron-down" />
      </button>
      {open && (
        <div className="switcher-menu" role="listbox" aria-label="流水线">
          {list.map(p => (
            <button key={p.id} role="option" aria-selected={p.id === current?.id} className={`switcher-item ${p.id === current?.id && !isNew ? 'active' : ''}`} onClick={() => { onPick(p.id); setOpen(false) }}>
              <span className="switcher-item-main">
                <span>{p.name}</span>
                <span className="muted small">
                  {p.nodes} 个步骤
                  {p.schedule.enabled && p.schedule.times.length > 0 ? ` · 每天 ${p.schedule.times.join('、')}` : ''}
                  {p.lastRun === undefined ? '' : ` · ${relativeTime(p.lastRun.startedAt, now)}`}
                </span>
              </span>
              {p.draft ? <span className="badge warn">草稿</span> : p.lastRun !== undefined ? <span className={`badge ${RUN_STATE[p.lastRun.state][0]}`}>{RUN_STATE[p.lastRun.state][1]}</span> : null}
            </button>
          ))}
          {list.length === 0 && <div className="muted small pad">还没有保存的流水线</div>}
        </div>
      )}
    </div>
  )
}

type SideTab = 'check' | 'runs' | 'schedule'

/** The pipeline's own panel beside the canvas: check, runs, schedule and failure handling. */
function PipelineSide({ pipeline, check, runs, shownRun, onShowRun, others, onChange, now, startup, onStartup }: {
  pipeline: Pipeline; check: PipelineCheck | null; runs: PipelineRun[]; shownRun: string | undefined; onShowRun: (id: string) => void
  others: PipelineSummary[]; onChange: (p: Pipeline) => void; now: number
  startup: ScheduleSettings | null; onStartup: (patch: Partial<ScheduleSettings>) => void
}) {
  const [tab, setTab] = useState<SideTab>(runs.some(r => r.state === 'running') ? 'runs' : 'check')
  const errors = check?.issues.filter(i => i.level === 'error').length ?? 0
  return (
    <div className="pipeline-side">
      <nav className="tabs side-tabs" role="tablist" aria-label="流水线">
        <button role="tab" aria-selected={tab === 'check'} className={tab === 'check' ? 'active' : ''} onClick={() => setTab('check')}>检查{errors > 0 ? ` · ${errors}` : ''}</button>
        <button role="tab" aria-selected={tab === 'runs'} className={tab === 'runs' ? 'active' : ''} onClick={() => setTab('runs')}>运行记录</button>
        <button role="tab" aria-selected={tab === 'schedule'} className={tab === 'schedule' ? 'active' : ''} onClick={() => setTab('schedule')}>定时与失败</button>
      </nav>
      {tab === 'check' && (check === null ? <p className="muted small pad">加上步骤后会自动检查。</p> : <ChecksCard check={check} pipeline={pipeline} />)}
      {tab === 'runs' && <RunsList runs={runs} shown={shownRun} onShow={onShowRun} now={now} />}
      {tab === 'schedule' && <ScheduleCard pipeline={pipeline} others={others} onChange={onChange} startup={startup} onStartup={onStartup} />}
      <p className="muted small pad">点画布上的节点或连线来修改它；选中后按 Delete 删除。</p>
    </div>
  )
}

const DAYS = ['日', '一', '二', '三', '四', '五', '六']
const POWER_WORD = { sleep: '睡眠', hibernate: '休眠', shutdown: '关机' } as const

function ScheduleCard({ pipeline, others, onChange, startup, onStartup }: {
  pipeline: Pipeline; others: PipelineSummary[]; onChange: (p: Pipeline) => void
  startup: ScheduleSettings | null; onStartup: (patch: Partial<ScheduleSettings>) => void
}) {
  const onStart = startup?.autostartPipelines.includes(pipeline.id) === true
  const s = pipeline.schedule
  const [times, setTimes] = useState(s.times.join('，'))
  useEffect(() => setTimes(s.times.join('，')), [pipeline.id])
  const set = (patch: Partial<Pipeline['schedule']>) => onChange({ ...pipeline, schedule: { ...s, ...patch } })
  const parsed = useMemo(() => times.split(/[,，\s]+/).map(t => t.trim()).filter(Boolean).map(t => (/^\d:\d\d$/.test(t) ? `0${t}` : t)), [times])
  const bad = parsed.filter(t => !/^([01]\d|2[0-3]):[0-5]\d$/.test(t))
  return (
    <section className="side-pane">
      <label className="check-label"><input type="checkbox" checked={s.enabled} onChange={e => set({ enabled: e.target.checked })} />按定时自动运行{pipeline.draft === true ? '（草稿要先保存）' : ''}</label>
      <label className="field-label" htmlFor="pl-times">时间（24 小时制，多个用逗号分开）</label>
      <input id="pl-times" className="text-input" value={times} placeholder="04:30，16:30" onChange={e => setTimes(e.target.value)}
        onBlur={() => { if (bad.length === 0) set({ times: [...new Set(parsed)].sort() }) }} />
      {bad.length > 0 && <div className="notice error left small"><Icon name="alert" /><span>时间写成 HH:MM：{bad.join('、')}</span></div>}
      <div className="chip-row" role="group" aria-label="星期">
        {DAYS.map((d, i) => (
          <button key={d} className={`chip ${s.days.includes(i) ? 'active' : ''}`} onClick={() => set({ days: s.days.includes(i) ? s.days.filter(x => x !== i) : [...s.days, i].sort() })}>周{d}</button>
        ))}
        <span className="muted small">{s.days.length === 0 ? '不选＝每天' : ''}</span>
      </div>
      {startup !== null && (
        <div className="startup-box">
          <label className="check-label">
            <input type="checkbox" checked={onStart} disabled={pipeline.draft === true}
              onChange={e => onStartup({ autostartPipelines: e.target.checked ? [...startup.autostartPipelines, pipeline.id] : startup.autostartPipelines.filter(id => id !== pipeline.id) })} />
            软件启动时运行{pipeline.draft === true ? '（草稿要先保存）' : ''}
          </label>
          {onStart && (
            <>
              <label className="check-label sub"><input type="checkbox" checked={startup.firstStartOnly} onChange={e => onStartup({ firstStartOnly: e.target.checked })} />只在每天第一次启动时运行</label>
              <label className="check-label sub"><input type="checkbox" checked={startup.skipIfRanToday} onChange={e => onStartup({ skipIfRanToday: e.target.checked })} />今天已经成功运行过就跳过</label>
              <p className="muted small">打开桌面版（自己打开或开机自启）后{startup.autostart ? `开机自启时等 ${startup.autostartDelaySeconds} 秒、自己打开时等 10 秒` : '等 10 秒'}再运行；dsh 崩溃后自动重启不算。这两项对所有「软件启动时运行」的流水线生效。</p>
            </>
          )}
        </div>
      )}
      <label className="field-label" htmlFor="pl-catchup">错过多少分钟以内还补跑（睡眠、刚开机）</label>
      <input id="pl-catchup" className="text-input plain" type="number" min={0} max={720} value={s.catchUpMinutes} onChange={e => set({ catchUpMinutes: Math.max(0, Math.min(720, Math.round(Number(e.target.value) || 0))) })} />
      <label className="field-label" htmlFor="pl-after">另一条流水线成功后接着运行</label>
      <select id="pl-after" className="text-input plain" value={s.after ?? ''} onChange={e => { const { after: _a, ...rest } = s; onChange({ ...pipeline, schedule: e.target.value === '' ? rest : { ...rest, after: e.target.value } }) }}>
        <option value="">不接续</option>
        {others.filter(o => o.id !== pipeline.id).map(o => <option key={o.id} value={o.id}>{o.name}</option>)}
      </select>
      <label className="field-label" htmlFor="pl-fail">节点失败时（节点自己没设置时）</label>
      <div className="select-stack">
        <select id="pl-fail" className="text-input plain" aria-label="重试次数" value={pipeline.onFailure.retries} onChange={e => onChange({ ...pipeline, onFailure: { ...pipeline.onFailure, retries: Number(e.target.value) } })}>
          {[0, 1, 2, 3, 4, 5].map(n => <option key={n} value={n}>{n === 0 ? '不重试' : `重试 ${n} 次`}</option>)}
        </select>
        <select className="text-input plain" aria-label="仍失败时" value={pipeline.onFailure.then} onChange={e => onChange({ ...pipeline, onFailure: { ...pipeline.onFailure, then: e.target.value as 'continue' | 'stop' } })}>
          <option value="continue">然后继续其他分支</option>
          <option value="stop">然后停止流水线</option>
        </select>
      </div>
      <div className="field-label">结束后</div>
      <label className="check-label"><input type="checkbox" checked={pipeline.closeGameAfter} onChange={e => onChange({ ...pipeline, closeGameAfter: e.target.checked })} />关闭游戏（任务玩过的电脑游戏和模拟器里的游戏）</label>
      <label className="check-label"><input type="checkbox" checked={pipeline.stopEmulatorAfter} onChange={e => onChange({ ...pipeline, stopEmulatorAfter: e.target.checked })} />关闭模拟器</label>
      <label className="field-label" htmlFor="pl-power">然后电脑</label>
      <select id="pl-power" className="text-input plain" value={pipeline.powerAfter} onChange={e => onChange({ ...pipeline, powerAfter: e.target.value as Pipeline['powerAfter'] })}>
        <option value="none">保持开着</option>
        <option value="sleep">睡眠</option>
        <option value="hibernate">休眠</option>
        <option value="shutdown">关机</option>
      </select>
      {pipeline.powerAfter !== 'none' && (
        <p className="muted small">等其他任务都结束后先倒计时{startup === null ? '' : ` ${startup.powerCountdownSeconds} 秒`}，界面和飞书里都可以取消；15 分钟内还有定时任务就不{POWER_WORD[pipeline.powerAfter]}。在这里手动点运行、或运行被取消时不会{POWER_WORD[pipeline.powerAfter]}。{pipeline.powerAfter === 'shutdown' ? '关机会强制关闭所有程序。' : '想让电脑按时醒来跑定时任务，在「设置 → 定时与自启」打开定时唤醒。'}</p>
      )}
    </section>
  )
}
