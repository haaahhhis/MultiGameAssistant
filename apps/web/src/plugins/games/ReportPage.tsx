import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { GameInfo, GamesSettings, RequestResult } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'
import './games.css'

type Listing = RequestResult<'games/list'>

/**
 * 日报: one of the 游戏 agent's tabs, beside its 对话 (index.ts: the page
 * belongs to `games`). When it is sent and what it says — the games' events,
 * days left, what is not done — and what went out last. It was a tab of the
 * game board; `#/p/games/report` still comes here.
 */
export function ReportPage({ client, openSettings }: PageProps) {
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [data, setData] = useState<Listing | null>(null)
  const [revision, setRevision] = useState(0)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => client.connection.on('games/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('games/list', {}).then(r => { if (live) { setData(r); setError(null) } }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, revision])
  return (
    <section className="main games-page">
      <header className="page-header games-header">
        <div className="breadcrumb"><h1>日报</h1></div>
      </header>
      <div className="games-body">
        {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
        {data !== null && <ReportCard client={client} data={data} games={data.games} now={now} openSettings={openSettings} onChanged={() => setRevision(r => r + 1)} />}
      </div>
    </section>
  )
}

function ReportCard({ client, data, games, now, openSettings, onChanged }: {
  client: AdgClient
  data: Listing
  games: readonly GameInfo[]
  now: number
  openSettings: (section?: string) => void
  onChanged: () => void
}) {
  const settings = data.settings.report
  const [preview, setPreview] = useState<{ title: string; text: string } | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [sent, setSent] = useState<string | null>(null)
  useEffect(() => {
    let live = true
    client.connection.call('games/report/preview', {}).then(p => { if (live) setPreview(p) }).catch(() => {})
    return () => { live = false }
  }, [client, data])

  const set = async (patch: Partial<GamesSettings['report']>) => {
    setBusy(true)
    setError(null)
    try { await client.connection.call('games/settings/set', { report: patch }); onChanged() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const send = async () => {
    setBusy(true)
    setError(null)
    setSent(null)
    try {
      const { channels } = await client.connection.call('games/report/send', {})
      setSent(channels.length === 0 ? '没有发出去：还没有设置好的聊天渠道。' : `已发到${channels.join('、')}。`)
      onChanged()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <>
      <section className="card">
        <div className="card-head">
          <div>
            <h3>每日日报</h3>
            <p className="muted small">每天先读一遍数据站，再把各游戏的活动、剩余天数和没做完的事发到飞书。进度来自 agent 最近一次进游戏读取（可以在编排里加一个 agent 节点，日常跑完后读一次）。</p>
          </div>
          <span className={`badge ${settings.enabled ? 'ok' : ''}`}>{settings.enabled ? '已开启' : '未开启'}</span>
        </div>
        <label className="check-label"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={e => void set({ enabled: e.target.checked })} />每天定时发送</label>
        <label className="check-label"><input type="checkbox" checked={settings.ai} disabled={busy} onChange={e => void set({ ai: e.target.checked })} />用 AI 总结，只说近期的事（刚开始、快结束、即将开始），语气按「设置 → 回复风格」；agent 不可用时发下面的完整列表</label>
        <div className="field-row">
          <label className="field">
            <span className="field-title">发送时间</span>
            <input className="text-input plain" type="time" defaultValue={settings.at} key={settings.at} disabled={busy} onBlur={e => { if (/^\d{2}:\d{2}$/.test(e.target.value) && e.target.value !== settings.at) void set({ at: e.target.value }) }} />
          </label>
          <label className="field">
            <span className="field-title">剩余几天以内标成「快结束」</span>
            <input className="text-input plain" type="number" min={1} max={30} defaultValue={settings.soonDays} key={settings.soonDays} disabled={busy} onBlur={e => { const n = Math.max(1, Math.min(30, Math.round(Number(e.target.value) || 3))); if (n !== settings.soonDays) void set({ soonDays: n }) }} />
          </label>
        </div>
        <div className="field-title">包括的游戏（都不选就是全部）</div>
        <div className="chip-row">
          {games.map(g => {
            const on = settings.games.includes(g.id)
            return <button key={g.id} className={`chip chip-button ${on ? 'active' : ''}`} disabled={busy} onClick={() => void set({ games: on ? settings.games.filter(x => x !== g.id) : [...settings.games, g.id] })}>{g.name}</button>
          })}
        </div>
        <p className="muted small">
          {data.report.lastSentAt === undefined ? '还没发过。' : `上次：${relativeTime(data.report.lastSentAt, now)}。`}
          {data.report.lastResult === undefined ? '' : ` ${data.report.lastResult}。`}
          {settings.enabled && data.report.next !== undefined && ` 下一次：${new Date(data.report.next).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}。`}
          {' '}<button className="link-button" onClick={() => openSettings('feishu')}>远程连接</button>
        </p>
        {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
      </section>
      <section className="card">
        <div className="card-head">
          <div><h3>今天的日报</h3><p className="muted small">{settings.ai ? '完整列表。发送时 agent 从里面挑出近期的事写成总结，写不出来就发这份。' : '发到飞书的就是这份。'}</p></div>
          <button className="small-button primary" disabled={busy} onClick={() => void send()}><Icon name="send" />{busy ? '发送中…' : '现在发送'}</button>
        </div>
        {sent !== null && <div className="notice info left small"><Icon name="info" /><span>{sent}</span></div>}
        {preview !== null && <div className="report-preview"><strong>{preview.title}</strong>{'\n\n'}{preview.text}</div>}
      </section>
      {data.report.lastText !== undefined && (
        <section className="card">
          <div className="card-head"><div><h3>上次发出的</h3>{data.report.lastSentAt !== undefined && <p className="muted small">{relativeTime(data.report.lastSentAt, now)}</p>}</div></div>
          <div className="report-preview">{data.report.lastText}</div>
        </section>
      )}
    </>
  )
}
