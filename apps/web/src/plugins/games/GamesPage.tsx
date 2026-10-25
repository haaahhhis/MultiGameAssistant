import { useEffect, useState, type CSSProperties } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { GameInfo, GamesSettings, RequestResult } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'
import { GameView, useGameColors } from './GameView.tsx'
import { CatalogPicker, Overview, PALETTE, progressOf } from './Overview.tsx'
import './games.css'

type Listing = RequestResult<'games/list'>

const DAY = 86_400_000

/**
 * The game board. Tabs across the top: 全部活动 (every game's events on one
 * timeline), one tab per game (its version, banners and events from the data
 * sites, beside the user's progress and the pipelines that play it), more
 * games to follow, and the daily report.
 */
export function GamesPage({ client, openSession, openSettings, openPage, arg }: PageProps) {
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [data, setData] = useState<Listing | null>(null)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<string>(arg ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)

  // A link to one game (#/p/games/<id>) selects it, also when the page is already open.
  useEffect(() => { if (arg !== undefined) setSelected(arg) }, [arg])
  useEffect(() => client.connection.on('games/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('games/list', {}).then(r => { if (live) setData(r) }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, revision])

  const games = data?.games ?? []
  const colors = useGameColors(games, PALETTE)
  const showReport = selected === 'report'
  const current = showReport ? undefined : games.find(g => g.id === selected)
  // Nothing (or a game that is gone) selected: everything at a glance.
  const showOverview = !showReport && current === undefined
  const select = (id: string) => { setSelected(id); setMessage(null); setError(null) }

  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key)
    setError(null)
    setMessage(null)
    try {
      const said = await fn()
      if (typeof said === 'string') setMessage(said)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
      setRevision(r => r + 1)
    }
  }
  const refresh = (game?: string) => act(`refresh:${game ?? ''}`, async () => {
    const { results } = await client.connection.call('games/refresh', game === undefined ? {} : { game })
    const name = (id: string) => games.find(g => g.id === id)?.name ?? id
    const readable = (id: string) => games.find(g => g.id === id)?.sources.some(s => s.auto) === true
    const failed = results.filter(r => readable(r.game) && !r.ok)
    if (failed.length > 0) throw new Error(failed.map(r => `${name(r.game)}没读到：${r.detail ?? '未知原因'}`).join('；'))
    return game === undefined ? `刷新完成：${results.filter(r => readable(r.game)).map(r => `${name(r.game)} ${r.count} 个活动`).join('；')}` : undefined
  })

  const tab = (g: GameInfo) => {
    const mine = (data?.activities ?? []).filter(a => a.game === g.id && (a.startsAt ?? 0) <= now && Math.max(a.endsAt ?? Infinity, a.shopEndsAt ?? 0) > now)
    const soon = mine.filter(a => progressOf(a).state !== 'finished' && a.endsAt !== undefined && a.endsAt > now && a.endsAt - now < (data?.settings.report.soonDays ?? 3) * DAY).length
    return (
      <button key={g.id} role="tab" aria-selected={current?.id === g.id} className={`game-tab ${current?.id === g.id ? 'active' : ''}`} style={{ '--game': colors.get(g.id) } as CSSProperties}
        title={`${mine.length} 个进行中${g.refreshed === undefined ? '' : ` · ${relativeTime(g.refreshed.at, now)}刷新`}${g.followed === true ? ' · 关注的游戏' : ''}`} onClick={() => select(g.id)}>
        <span className="game-dot" />{g.name}
        {soon > 0 && <span className="game-tab-badge" title={`${soon} 个快结束还没做完`}>{soon}</span>}
      </button>
    )
  }

  return (
    <section className="main games-page">
      <header className="page-header">
        <div className="breadcrumb"><span>游戏</span><span className="breadcrumb-divider">/</span><h1>{showReport ? '每日日报' : current?.name ?? '全部活动'}</h1></div>
        <div className="page-actions">
          <button className="small-button" disabled={busy !== null || games.length === 0} onClick={() => void refresh()}><Icon name="refresh" />{busy === 'refresh:' ? '刷新中…' : '刷新全部'}</button>
        </div>
      </header>
      <nav className="game-tabs" role="tablist" aria-label="游戏">
        <button role="tab" aria-selected={showOverview} className={`game-tab ${showOverview ? 'active' : ''}`} onClick={() => select('')}><Icon name="calendar" />全部活动</button>
        <span className="game-tabs-divider" />
        {games.map(tab)}
        <button className={`game-tab add ${catalogOpen ? 'active' : ''}`} aria-expanded={catalogOpen} title="关注更多游戏（SRA 公共 API）" onClick={() => setCatalogOpen(o => !o)}><Icon name="plus" />更多游戏</button>
        <span className="spacer" />
        <button role="tab" aria-selected={showReport} className={`game-tab ${showReport ? 'active' : ''}`} onClick={() => select('report')}><Icon name="send" />日报</button>
      </nav>
      <div className="games-body">
        {catalogOpen && (
          <section className="card">
            <CatalogPicker client={client} onChanged={() => setRevision(r => r + 1)}
              onDiscover={name => void act('discover', async () => { const { sessionId } = await client.connection.call('games/discover', { name }); openSession(sessionId) })} />
          </section>
        )}
        {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
        {message !== null && <div className="notice info left small"><Icon name="info" /><span>{message}</span></div>}
        {data !== null && games.length === 0 && <div className="empty"><Icon name="gamepad" /><p>没有游戏。点「更多游戏」关注几个。</p></div>}
        {data !== null && showOverview && games.length > 0 && (
          <Overview client={client} games={games} activities={data.activities} now={now} soonDays={data.settings.report.soonDays}
            onOpenGame={select} onChanged={() => setRevision(r => r + 1)} />
        )}
        {data !== null && showReport && <ReportCard client={client} data={data} games={games} now={now} openSettings={openSettings} onChanged={() => setRevision(r => r + 1)} />}
        {data !== null && current !== undefined && (
          <GameView
            key={current.id} client={client} game={current} activities={data.activities.filter(a => a.game === current.id)}
            color={colors.get(current.id) ?? PALETTE[0]!} now={now} soonDays={data.settings.report.soonDays} busy={busy}
            onRefresh={() => void refresh(current.id)}
            onRead={() => void act(`read:${current.id}`, async () => {
              const { sessionId } = await client.connection.call('games/read', { game: current.id })
              openSession(sessionId)
            })}
            onReadWeb={source => void act(`read-web:${current.id}`, async () => {
              const { sessionId } = await client.connection.call('games/read', { game: current.id, how: 'web', ...(source === undefined ? {} : { source }) })
              openSession(sessionId)
            })}
            onUnfollow={() => void act(`unfollow:${current.id}`, async () => {
              // A followed game's id is sra-<the API's id> (game-intel's followedId).
              await client.connection.call('games/follow', { sra: current.id.replace(/^sra-/, ''), follow: false })
              setSelected('')
              return `不再关注${current.name}`
            })}
            onChanged={() => setRevision(r => r + 1)}
            openSession={openSession} openScripts={() => openPage('scripts')}
          />
        )}
      </div>
    </section>
  )
}

function ReportCard({ client, data, games, now, openSettings, onChanged }: {
  client: AdgClient
  data: Listing
  games: GameInfo[]
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
        <label className="check-label"><input type="checkbox" checked={settings.ai} disabled={busy} onChange={e => void set({ ai: e.target.checked })} />用 AI 总结，只说近期的事（刚开始、快结束、即将开始）；agent 不可用时发下面的完整列表</label>
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
          {' '}<button className="link-button" onClick={() => openSettings('feishu')}>飞书设置</button>
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
