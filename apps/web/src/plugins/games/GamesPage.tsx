import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { Activity, GameInfo, GamesSettings, RequestResult } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { Icon } from '../../components/Icons.tsx'
import { ImageViewer } from '../../components/ImageViewer.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'
import { Overview, progressOf } from './Overview.tsx'
import './games.css'

type Listing = RequestResult<'games/list'>

const DAY = 86_400_000
const HOUR = 3_600_000

/** "10/25 03:59" in the game's time zone ("2027/03/10 16:00" in another year). */
function when(at: number, timeZone: string): string {
  const year = (t: number) => new Date(t).toLocaleString('en-US', { timeZone, year: 'numeric' })
  const other = year(at) !== year(Date.now())
  return new Date(at).toLocaleString('zh-CN', { timeZone, hour12: false, ...(other ? { year: 'numeric' } : {}), month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
}

function left(end: number, now: number): { big: string; unit: string } {
  const ms = end - now
  if (ms <= 0) return { big: '0', unit: '已结束' }
  if (ms < DAY) return { big: String(Math.max(1, Math.floor(ms / HOUR))), unit: '小时' }
  return { big: String(Math.floor(ms / DAY)), unit: '天' }
}

/** The game board: all events at a glance (Overview), each game's events from the data sites and the game screen, and the daily report. */
export function GamesPage({ client, openSession, openSettings, openPage, arg }: PageProps) {
  const status = useStore(client.connection.status)
  const now = useNow(60_000)
  const [data, setData] = useState<Listing | null>(null)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<string>(arg ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)

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
  const showReport = selected === 'report'
  const current = showReport ? undefined : games.find(g => g.id === selected)
  // Nothing (or a game that is gone) selected: everything at a glance.
  const showOverview = !showReport && current === undefined

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
    const parts = results.map(r => !readable(r.game) ? `${name(r.game)}没有能直接读的数据站（让 agent 去读）`
      : r.ok ? `${name(r.game)} ${r.count} 个活动` : `${name(r.game)}没读到：${r.detail ?? '未知原因'}`)
    return `刷新完成：${parts.join('；')}`
  })

  const row = (g: GameInfo) => {
    const mine = (data?.activities ?? []).filter(a => a.game === g.id && (a.startsAt ?? 0) <= now)
    const soon = mine.filter(a => a.endsAt !== undefined && a.endsAt > now && a.endsAt - now < (data?.settings.report.soonDays ?? 3) * DAY).length
    return (
      <button key={g.id} className={`script-row ${current?.id === g.id && !showReport ? 'active' : ''}`} onClick={() => { setSelected(g.id); setMessage(null) }}>
        <span className="script-row-main">
          <span className="script-row-name">{g.name}</span>
          <span className="muted small">{mine.length === 0 ? '还没有活动' : `${mine.length} 个活动${mine.some(a => progressOf(a).state !== 'unknown') ? `，做完 ${mine.filter(a => progressOf(a).state === 'finished').length} 个` : ''}`}{g.refreshed === undefined ? '' : ` · ${relativeTime(g.refreshed.at, now)}刷新`}{g.followed === true ? ' · 关注' : ''}</span>
        </span>
        {soon > 0 && <span className="badge warn">{soon} 个快结束</span>}
      </button>
    )
  }

  return (
    <section className="main scripts-page games-page">
      <header className="page-header">
        <div className="breadcrumb"><span>游戏</span><span className="breadcrumb-divider">/</span><h1>游戏看板</h1></div>
        <div className="page-actions">
          <button className="small-button" disabled={busy !== null || games.length === 0} onClick={() => void refresh()}><Icon name="refresh" />{busy === 'refresh:' ? '刷新中…' : '刷新全部数据站'}</button>
        </div>
      </header>
      <div className="scripts-body">
        <aside className="scripts-list" aria-label="游戏列表">
          <button className={`script-row ${showOverview ? 'active' : ''}`} onClick={() => { setSelected(''); setMessage(null) }}>
            <span className="script-row-main">
              <span className="script-row-name">全部活动</span>
              <span className="muted small">{data === null ? '' : `${data.activities.filter(a => (a.startsAt ?? 0) <= now && (a.endsAt ?? Infinity) > now).length} 个进行中 · 按时间排在一起`}</span>
            </span>
          </button>
          <div className="list-divider" />
          {games.map(row)}
          <div className="list-divider" />
          <button className={`script-row ${showReport ? 'active' : ''}`} onClick={() => { setSelected('report'); setMessage(null) }}>
            <span className="script-row-main">
              <span className="script-row-name">每日日报</span>
              <span className="muted small">{data === null ? '' : data.settings.report.enabled ? `每天 ${data.settings.report.at} 发到飞书` : '没有开启'}</span>
            </span>
          </button>
        </aside>
        <div className="scripts-detail">
          <div className="script-detail">
            {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
            {message !== null && <div className="notice info left small"><Icon name="info" /><span>{message}</span></div>}
            {data !== null && games.length === 0 && <div className="empty"><Icon name="gamepad" /><p>没有游戏包。</p></div>}
            {data !== null && showOverview && games.length > 0 && (
              <Overview client={client} games={games} activities={data.activities} now={now} soonDays={data.settings.report.soonDays}
                onOpenGame={id => { setSelected(id); setMessage(null) }} onChanged={() => setRevision(r => r + 1)} />
            )}
            {data !== null && showReport && <ReportCard client={client} data={data} games={games} now={now} openSettings={openSettings} onChanged={() => setRevision(r => r + 1)} />}
            {data !== null && current !== undefined && !showReport && (
              <GameDetail
                client={client} game={current} activities={data.activities.filter(a => a.game === current.id)} settings={data.settings} now={now}
                busy={busy} onRefresh={() => void refresh(current.id)}
                onRead={() => void act(`read:${current.id}`, async () => {
                  const { sessionId } = await client.connection.call('games/read', { game: current.id })
                  openSession(sessionId)
                })}
                onUnfollow={() => void act(`unfollow:${current.id}`, async () => {
                  // A followed game's id is sra-<the API's id> (game-intel's followedId).
                  await client.connection.call('games/follow', { sra: current.id.replace(/^sra-/, ''), follow: false })
                  setSelected('')
                  return `不再关注${current.name}`
                })}
                onRemove={id => void act(`remove:${id}`, async () => { await client.connection.call('games/activity/remove', { activityId: id }) })}
                openSession={openSession} openPage={openPage}
              />
            )}
          </div>
        </div>
      </div>
    </section>
  )
}

function GameDetail({ client, game, activities, settings, now, busy, onRefresh, onRead, onUnfollow, onRemove, openSession, openPage }: {
  client: AdgClient
  game: GameInfo
  activities: Activity[]
  settings: GamesSettings
  now: number
  busy: string | null
  onRefresh: () => void
  onRead: () => void
  onUnfollow: () => void
  onRemove: (id: string) => void
  openSession: (id: string) => void
  openPage: (id: string) => void
}) {
  const running = activities.filter(a => (a.startsAt ?? 0) <= now)
  const upcoming = activities.filter(a => a.startsAt !== undefined && a.startsAt > now)
  const auto = game.sources.some(s => s.auto)
  const reading = game.reading
  return (
    <>
      <section className="card game-head">
        <div className="card-head">
          <div>
            <h3>{game.name}</h3>
            <p className="muted small">
              {game.scripts.length > 0 && <>玩它的脚本：{game.scripts.map((s, i) => <span key={s}>{i > 0 ? '、' : ''}<button className="link-button" onClick={() => openPage('scripts')}>{s}</button></span>)} · </>}
              游戏画面：{game.screen === undefined ? '未设置' : game.screen.target === 'emulator' ? '模拟器' : 'PC 窗口'}
            </p>
          </div>
          <div className="game-actions">
            <button className="small-button" disabled={busy !== null || !auto} title={auto ? '从数据站读取活动时间，不用模型' : '这个游戏没有能直接读的数据站，让 agent 去读'} onClick={onRefresh}><Icon name="refresh" />{busy === `refresh:${game.id}` ? '刷新中…' : '刷新数据站'}</button>
            {game.followed === true
              ? <button className="small-button" disabled={busy !== null} title="不再显示这个游戏的活动" onClick={onUnfollow}>取消关注</button>
              : <button className="small-button primary" disabled={busy !== null || reading?.state === 'running'} title="agent 会看游戏画面，进活动页读取剩余时间和没做完的事；只看不花东西" onClick={onRead}><Icon name="gamepad" />{reading?.state === 'running' ? 'agent 正在读…' : '让 agent 进游戏读取'}</button>}
          </div>
        </div>
        {game.version !== undefined && (
          <div className="game-version">
            <span className="badge ok">版本 {game.version.name}</span>
            {game.version.title !== undefined && <strong>{game.version.title}</strong>}
            {game.version.startsAt !== undefined && game.version.endsAt !== undefined && (
              <span className="muted small">{when(game.version.startsAt, game.timezone)} – {when(game.version.endsAt, game.timezone)}{game.version.endsAt > now ? `，还有 ${left(game.version.endsAt, now).big} ${left(game.version.endsAt, now).unit}` : ''}</span>
            )}
            <span className="muted small">来自{game.version.source}</span>
          </div>
        )}
        <div className="source-row">
          {game.sources.map(s => (
            <span key={s.id} className="source-chip" title={s.auto ? '自动读取（不用模型）' : '由 agent 用网页工具读取'}>
              <span className={`source-dot ${s.auto ? 'auto' : ''}`} />
              {s.homepage === undefined ? s.name : <a href={s.homepage} target="_blank" rel="noreferrer">{s.name}</a>}
              <span className="muted">{s.auto ? '自动' : 'agent 读'}</span>
            </span>
          ))}
        </div>
        {game.refreshed !== undefined && !game.refreshed.ok && <div className="notice error left small"><Icon name="alert" /><span>上次刷新（{relativeTime(game.refreshed.at, now)}）没读到：{game.refreshed.detail}</span></div>}
        {reading !== undefined && (
          <div className={`reading ${reading.state}`}>
            <span className={`badge ${reading.state === 'done' ? 'ok' : reading.state === 'failed' ? 'warn' : ''}`}>{reading.state === 'running' ? '读取中' : reading.state === 'done' ? '上次读取' : '没读完'}</span>
            <span className="reading-text">{relativeTime(reading.at, now)}{reading.summary === undefined ? '' : `：${reading.summary}`}</span>
            {reading.sessionId !== undefined && <button className="link-button" onClick={() => openSession(reading.sessionId!)}>查看对话</button>}
          </div>
        )}
      </section>

      {running.length === 0 && upcoming.length === 0 && (
        <div className="empty"><Icon name="calendar" /><p>{auto ? '还没有活动记录。点「刷新数据站」读取活动时间。' : '这个游戏没有能直接读的数据站。点「让 agent 进游戏读取」，agent 会看官网公告和游戏画面。'}</p></div>
      )}
      {running.length > 0 && (
        <div className="activity-list">
          {running.map(a => <ActivityCard key={a.id} client={client} activity={a} timeZone={game.timezone} soonDays={settings.report.soonDays} now={now} onRemove={() => onRemove(a.id)} openSession={openSession} />)}
        </div>
      )}
      {upcoming.length > 0 && (
        <section className="card">
          <h3>即将开始</h3>
          <ul className="version-list">
            {upcoming.map(a => <li key={a.id}><span className="version-name">{when(a.startsAt!, game.timezone)}</span><span>{a.name}</span>{a.endsAt !== undefined && <span className="muted small">到 {when(a.endsAt, game.timezone)}</span>}</li>)}
          </ul>
        </section>
      )}
    </>
  )
}

function ActivityCard({ client, activity: a, timeZone, soonDays, now, onRemove, openSession }: {
  client: AdgClient
  activity: Activity
  timeZone: string
  soonDays: number
  now: number
  onRemove: () => void
  openSession: (id: string) => void
}) {
  const [shot, setShot] = useState<{ src: string; width: number; height: number } | null>(null)
  const [shotError, setShotError] = useState<string | null>(null)
  const ended = a.endsAt !== undefined && a.endsAt <= now
  const end = ended ? a.shopEndsAt : a.endsAt
  const soon = end !== undefined && end - now < soonDays * DAY
  // The bar runs from the start to the last day anything is open (the shop, when it outlasts the event).
  const last = a.endsAt === undefined ? undefined : Math.max(a.endsAt, a.shopEndsAt ?? 0)
  const span = a.startsAt !== undefined && last !== undefined ? last - a.startsAt : undefined
  const elapsed = span === undefined || span <= 0 ? undefined : Math.min(1, Math.max(0, (now - a.startsAt!) / span))
  const eventEnd = span === undefined || a.shopEndsAt === undefined || a.endsAt === undefined ? undefined : (a.endsAt - a.startsAt!) / span
  const count = end === undefined ? undefined : left(end, now)

  const openShot = async () => {
    setShotError(null)
    try {
      const { mediaType, data } = await client.connection.call('games/evidence', { activityId: a.id })
      const src = `data:${mediaType};base64,${data}`
      const img = new Image()
      img.onload = () => setShot({ src, width: img.naturalWidth, height: img.naturalHeight })
      img.src = src
    } catch (e) {
      setShotError(errorText(e))
    }
  }

  return (
    <article className={`activity ${soon ? 'soon' : ''} ${ended ? 'shop-only' : ''}`}>
      <div className="activity-count" aria-label={count === undefined ? '结束时间未知' : `${count.big}${count.unit}`}>
        {count === undefined ? <span className="activity-unknown">?</span> : <><strong>{count.big}</strong><span>{count.unit}</span></>}
        <small>{ended ? '商店' : '剩余'}</small>
      </div>
      <div className="activity-main">
        <div className="activity-title">
          <h4>{a.url === undefined ? a.name : <a href={a.url} target="_blank" rel="noreferrer">{a.name}</a>}</h4>
          {a.kind !== undefined && <span className="badge kind">{a.kind}</span>}
          <span className="spacer" />
          {a.site !== undefined && <span className="badge" title={`${relativeTime(a.site.at, now)}读取`}>{a.site.name}</span>}
          {a.screen !== undefined && <span className="badge ok" title={`agent ${relativeTime(a.screen.at, now)}在游戏里看到`}>游戏内 {relativeTime(a.screen.at, now)}</span>}
          <button className="icon-button" title="从日历里去掉（读错了或不关心）" onClick={onRemove}><Icon name="close" /></button>
        </div>
        <div className="activity-dates muted small">
          {a.startsAt !== undefined && <span>{when(a.startsAt, timeZone)} 开始</span>}
          {a.endsAt !== undefined && <span>{when(a.endsAt, timeZone)} {ended ? '已结束' : '结束'}</span>}
          {a.shopEndsAt !== undefined && <span>商店开到 {when(a.shopEndsAt, timeZone)}</span>}
          {a.endsAt === undefined && a.screen?.remaining !== undefined && <span>游戏里显示「{a.screen.remaining}」</span>}
        </div>
        {a.description !== undefined && <p className="activity-description" title={a.description}>{a.description}</p>}
        {elapsed !== undefined && (
          <div className="timeline" aria-hidden="true">
            <div className="timeline-fill" style={{ width: `${elapsed * 100}%` }} />
            {eventEnd !== undefined && <div className="timeline-mark" style={{ left: `${eventEnd * 100}%` }} title="活动结束，之后只开商店" />}
          </div>
        )}
        {(a.todo.length > 0 || a.done.length > 0 || a.progress !== undefined) && (
          <div className="activity-todo">
            {a.todo.map(t => <span key={`t${t}`} className="todo-chip">{t}</span>)}
            {a.done.map(t => <span key={`d${t}`} className="todo-chip done">✓ {t}</span>)}
            {a.progress !== undefined && <span className="todo-chip progress">{a.progress}</span>}
          </div>
        )}
        {a.screen !== undefined && a.todo.length === 0 && a.done.length === 0 && <div className="muted small">游戏里没看到没做完的事。</div>}
        {a.mismatch !== undefined && <div className="notice warn-note left small"><Icon name="alert" /><span>{a.mismatch}</span></div>}
        {(a.screen?.evidence === true || a.screen?.sessionId !== undefined) && (
          <div className="activity-links">
            {a.screen?.evidence === true && <button className="link-button" onClick={() => void openShot()}>看截图</button>}
            {a.screen?.sessionId !== undefined && <button className="link-button" onClick={() => openSession(a.screen!.sessionId!)}>agent 的对话</button>}
            {shotError !== null && <span className="muted small">{shotError}</span>}
          </div>
        )}
      </div>
      {shot !== null && <ImageViewer src={shot.src} width={shot.width} height={shot.height} name={`${a.name}.png`} onClose={() => setShot(null)} />}
    </article>
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
            <p className="muted small">每天先读一遍数据站，再把各游戏进行中的活动、剩余天数和没做完的事发到飞书。进度来自 agent 最近一次进游戏读取（可以在编排里加一个 agent 节点，日常跑完后读一次）。</p>
          </div>
          <span className={`badge ${settings.enabled ? 'ok' : ''}`}>{settings.enabled ? '已开启' : '未开启'}</span>
        </div>
        <label className="check-label"><input type="checkbox" checked={settings.enabled} disabled={busy} onChange={e => void set({ enabled: e.target.checked })} />每天定时发送</label>
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
          <div><h3>今天的日报</h3><p className="muted small">发到飞书的就是这份。</p></div>
          <button className="small-button primary" disabled={busy} onClick={() => void send()}><Icon name="send" />{busy ? '发送中…' : '现在发送'}</button>
        </div>
        {sent !== null && <div className="notice info left small"><Icon name="info" /><span>{sent}</span></div>}
        {preview !== null && <div className="report-preview"><strong>{preview.title}</strong>{'\n\n'}{preview.text}</div>}
      </section>
    </>
  )
}
