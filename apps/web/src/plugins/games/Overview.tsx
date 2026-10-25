import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { Activity, GameInfo, RequestResult } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { ImageViewer } from '../../components/ImageViewer.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

const DAY = 86_400_000
/** The timeline shows from a couple of days back to four weeks ahead. */
const BEFORE_DAYS = 2
const AFTER_DAYS = 28
/** Mid-tone hues that read on both the light and the dark theme. */
export const PALETTE = ['#3b82c4', '#c0567d', '#2f9e7a', '#c98a1b', '#7a62d6', '#d2643c', '#4d9a3c', '#2a93a8', '#a86bb8', '#8a7a3a']
const SHOWN_KEY = 'adg:games:overview:shown'
const MODE_KEY = 'adg:games:overview:mode'

type Mode = 'time' | 'game'
type Catalog = RequestResult<'games/catalog'>['games']

function load<T>(key: string, fallback: T): T {
  try { const raw = localStorage.getItem(key); return raw === null ? fallback : JSON.parse(raw) as T } catch { return fallback }
}
function keep(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)) } catch { /* private window: the choice lasts until reload */ }
}

/** How far along the user is: their own word, the checklist, or nothing known yet. */
export function progressOf(a: Activity): { state: 'finished' | 'partial' | 'unknown'; done: number; total: number } {
  const total = a.todo.length + a.done.length
  if (a.finished !== undefined) return { state: 'finished', done: total, total }
  if (total === 0) return { state: 'unknown', done: 0, total: 0 }
  return { state: a.todo.length === 0 ? 'finished' : 'partial', done: a.done.length, total }
}

function dayLabel(at: number, timeZone: string): string {
  return new Date(at).toLocaleDateString('zh-CN', { timeZone, month: 'numeric', day: 'numeric' })
}

function leftText(end: number, now: number): string {
  const ms = end - now
  if (ms <= 0) return '已结束'
  if (ms < DAY) return `${Math.max(1, Math.floor(ms / 3_600_000))} 小时`
  return `${Math.floor(ms / DAY)} 天`
}

/**
 * Every game's events in one place: on a shared four-week timeline, ordered
 * by when they end (grouped by urgency) or by game; each with how far along
 * the user is, and a checklist they can keep themselves.
 */
export function Overview({ client, games, activities, now, soonDays, onOpenGame, onChanged }: {
  client: AdgClient
  games: readonly GameInfo[]
  activities: readonly Activity[]
  now: number
  soonDays: number
  onOpenGame: (id: string) => void
  onChanged: () => void
}) {
  const [shown, setShown] = useState<string[] | null>(() => load<string[] | null>(SHOWN_KEY, null))
  const [mode, setMode] = useState<Mode>(() => load<Mode>(MODE_KEY, 'time'))
  const [open, setOpen] = useState<string | null>(null)
  useEffect(() => keep(SHOWN_KEY, shown), [shown])
  useEffect(() => keep(MODE_KEY, mode), [mode])

  const color = useMemo(() => new Map(games.map((g, i) => [g.id, PALETTE[i % PALETTE.length]!])), [games])
  const visible = (id: string) => shown === null || shown.includes(id)
  const toggle = (id: string) => setShown(s => {
    const current = s ?? games.map(g => g.id)
    const next = current.includes(id) ? current.filter(x => x !== id) : [...current, id]
    return next.length === games.length ? null : next
  })

  const from = new Date(now - BEFORE_DAYS * DAY).setHours(0, 0, 0, 0)
  const to = from + (BEFORE_DAYS + AFTER_DAYS) * DAY
  const x = (t: number) => Math.min(100, Math.max(0, ((t - from) / (to - from)) * 100))

  const items = activities.filter(a => visible(a.game) && (a.endsAt === undefined || Math.max(a.endsAt, a.shopEndsAt ?? 0) > now))
  const byEnd = (a: Activity, b: Activity) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity) || a.name.localeCompare(b.name)
  const running = items.filter(a => (a.startsAt ?? 0) <= now)
  const upcoming = items.filter(a => a.startsAt !== undefined && a.startsAt > now).sort((a, b) => a.startsAt! - b.startsAt!)

  const sections: { key: string; title: string; hint?: string; rows: Activity[]; game?: GameInfo }[] = []
  if (mode === 'time') {
    const endOfWeek = from + (BEFORE_DAYS + 7) * DAY
    const soon = running.filter(a => a.endsAt !== undefined && a.endsAt - now < soonDays * DAY).sort(byEnd)
    const week = running.filter(a => !soon.includes(a) && a.endsAt !== undefined && a.endsAt < endOfWeek).sort(byEnd)
    const later = running.filter(a => !soon.includes(a) && !week.includes(a)).sort(byEnd)
    sections.push(
      { key: 'soon', title: '快结束', hint: `${soonDays} 天内`, rows: soon },
      { key: 'week', title: '本周内结束', rows: week },
      { key: 'later', title: '之后结束', rows: later },
      { key: 'upcoming', title: '即将开始', rows: upcoming },
    )
  } else {
    for (const g of games) {
      if (!visible(g.id)) continue
      const rows = [...running.filter(a => a.game === g.id).sort(byEnd), ...upcoming.filter(a => a.game === g.id)]
      sections.push({ key: g.id, title: g.name, rows, game: g })
    }
  }

  const counts = running.reduce((c, a) => {
    const p = progressOf(a)
    return { ...c, [p.state]: c[p.state] + 1 }
  }, { finished: 0, partial: 0, unknown: 0 })
  const soonCount = running.filter(a => a.endsAt !== undefined && a.endsAt - now < soonDays * DAY && progressOf(a).state !== 'finished').length

  // Day ticks: every day faintly, a label every week from today.
  const ticks: { at: number; label?: string }[] = []
  for (let t = from; t <= to; t += DAY) {
    const fromToday = Math.round((t - new Date(now).setHours(0, 0, 0, 0)) / DAY)
    ticks.push({ at: t, ...(fromToday > 0 && fromToday % 7 === 0 ? { label: dayLabel(t, Intl.DateTimeFormat().resolvedOptions().timeZone) } : {}) })
  }

  return (
    <div className="games-overview">
      <section className="card games-overview-head">
        <div className="card-head">
          <div>
            <h3>全部活动</h3>
            <p className="muted small">
              进行中 {running.length} 个 · <span className={soonCount > 0 ? 'tone-warn' : ''}>{soonCount} 个快结束还没做完</span> · 做完 {counts.finished} 个 · 做了一部分 {counts.partial} 个 · 没记录 {counts.unknown} 个
            </p>
          </div>
          <div className="segmented-control ov-mode" role="group" aria-label="排序">
            <button className={mode === 'time' ? 'active' : ''} aria-pressed={mode === 'time'} onClick={() => setMode('time')}>按时间</button>
            <button className={mode === 'game' ? 'active' : ''} aria-pressed={mode === 'game'} onClick={() => setMode('game')}>按游戏</button>
          </div>
        </div>
        <div className="chip-row games-overview-games" role="group" aria-label="显示哪些游戏">
          {games.map(g => (
            <button key={g.id} className={`chip chip-button game-chip ${visible(g.id) ? 'active' : ''}`} style={{ '--game': color.get(g.id) } as CSSProperties} aria-pressed={visible(g.id)} onClick={() => toggle(g.id)}>
              <span className="game-dot" />{g.name}
            </button>
          ))}
        </div>
      </section>

      <section className="card games-overview-board">
        <div className="ov-grid">
        <div className="ov-row ov-axis" aria-hidden="true">
          <div className="ov-label" />
          <div className="ov-track">
            {ticks.map(t => <span key={t.at} className={`ov-tick ${t.label !== undefined ? 'major' : ''}`} style={{ left: `${x(t.at)}%` }}>{t.label !== undefined && <em>{t.label}</em>}</span>)}
          </div>
          <div className="ov-side" />
        </div>
        {sections.every(s => s.rows.length === 0) && <div className="empty"><Icon name="calendar" /><p>{games.length === 0 ? '没有游戏。' : '选中的游戏现在没有活动。点「刷新全部数据站」读取，或在上面多选几个游戏。'}</p></div>}
        {sections.filter(s => s.rows.length > 0).map(s => (
          <div key={s.key} className="ov-section">
            <div className="ov-section-title">
              {s.game !== undefined && <span className="game-dot" style={{ '--game': color.get(s.game.id) } as CSSProperties} />}
              <span>{s.title}</span>
              {s.hint !== undefined && <span className="muted small">{s.hint}</span>}
              {s.game?.version !== undefined && <span className="muted small">版本 {s.game.version.name}{s.game.version.title === undefined ? '' : `「${s.game.version.title}」`}</span>}
              <span className="muted small">{s.rows.length} 个</span>
              {s.game !== undefined && <button className="link-button small" onClick={() => onOpenGame(s.game!.id)}>打开</button>}
            </div>
            {s.rows.map(a => {
              const game = games.find(g => g.id === a.game)
              return (
                <ActivityRow key={a.id} client={client} activity={a} game={game} color={color.get(a.game) ?? PALETTE[0]!} showGame={mode === 'time'}
                  now={now} soonDays={soonDays} x={x} open={open === a.id} onToggle={() => setOpen(o => (o === a.id ? null : a.id))}
                  onOpenGame={() => onOpenGame(a.game)} onChanged={onChanged} />
              )
            })}
          </div>
        ))}
        <div className="ov-today" style={{ left: `calc(var(--ov-label) + (100% - var(--ov-label) - var(--ov-side)) * ${x(now) / 100})` }} aria-hidden="true"><span>今天</span></div>
        </div>
      </section>
    </div>
  )
}

function ActivityRow({ client, activity: a, game, color, showGame, now, soonDays, x, open, onToggle, onOpenGame, onChanged }: {
  client: AdgClient
  activity: Activity
  game: GameInfo | undefined
  color: string
  showGame: boolean
  now: number
  soonDays: number
  x: (t: number) => number
  open: boolean
  onToggle: () => void
  onOpenGame: () => void
  onChanged: () => void
}) {
  const p = progressOf(a)
  const started = (a.startsAt ?? 0) <= now
  const end = a.endsAt
  const soon = started && end !== undefined && end - now < soonDays * DAY && p.state !== 'finished'
  const left = x(a.startsAt ?? now - 30 * DAY)
  const right = end === undefined ? 100 : x(end)
  const shop = a.shopEndsAt === undefined || end === undefined || a.shopEndsAt <= end ? undefined : x(a.shopEndsAt)
  return (
    <div className={`ov-item ${open ? 'open' : ''}`} style={{ '--game': color } as CSSProperties}>
      <button className={`ov-row ${soon ? 'soon' : ''} ${p.state === 'finished' ? 'finished' : ''}`} onClick={onToggle} aria-expanded={open}>
        <div className="ov-label">
          <span className="ov-name">{a.name}</span>
          <span className="ov-meta">
            {showGame && <><span className="game-dot" />{game?.name ?? a.game}</>}
            {a.kind !== undefined && <span className="ov-kind">{a.kind}</span>}
          </span>
        </div>
        <div className="ov-track">
          <span className={`ov-bar ${started ? '' : 'future'} ${left <= 0 ? 'cut-left' : ''} ${end === undefined || right >= 100 ? 'cut-right' : ''}`}
            style={{ left: `${left}%`, width: `${Math.max(1.2, right - left)}%` }}>
            {p.total > 0 && <span className="ov-bar-done" style={{ width: `${(p.done / p.total) * 100}%` }} />}
          </span>
          {shop !== undefined && <span className="ov-shop" style={{ left: `${right}%`, width: `${Math.max(0.6, shop - right)}%` }} title="之后只开商店" />}
        </div>
        <div className="ov-side">
          <span className={`ov-left ${soon ? 'tone-warn' : ''}`}>{!started ? `${leftText(a.startsAt!, now)}后开始` : end === undefined ? '时间未知' : end <= now && a.shopEndsAt !== undefined ? `商店 ${leftText(a.shopEndsAt, now)}` : leftText(end, now)}</span>
          <ProgressPill progress={p} />
        </div>
      </button>
      {open && <ActivityDetail client={client} activity={a} game={game} onOpenGame={onOpenGame} onChanged={onChanged} />}
    </div>
  )
}

export function ProgressPill({ progress: p }: { progress: ReturnType<typeof progressOf> }) {
  if (p.state === 'finished') return <span className="ov-progress done"><Icon name="check" />做完了</span>
  if (p.state === 'unknown') return <span className="ov-progress unknown">未记录</span>
  return (
    <span className="ov-progress partial" title={`做了 ${p.done} 项，还剩 ${p.total - p.done} 项`}>
      <span className="ov-ring" style={{ '--pct': `${(p.done / p.total) * 100}%` } as CSSProperties} />{p.done}/{p.total}
    </span>
  )
}

/** The event's description and dates, and its checklist: tick, untick, add, or call the whole thing done. */
/**
 * Where an activity's facts came from: each data site and web page keeps its own
 * record, so refreshing a data site never removes what the agent read from a page.
 */
export function ActivitySources({ activity: a }: { activity: Activity }) {
  const now = useNow(60_000)
  const sources = a.sources ?? (a.site === undefined ? [] : [{ id: a.site.source, name: a.site.name, at: a.site.at, web: false }])
  if (sources.length === 0 && a.screen === undefined) return null
  const primary = a.site?.name
  return (
    <div className="activity-sources">
      <span className="muted small">来源</span>
      {sources.map(s => (
        <span key={s.id} className={`fact-chip ${s.web ? 'web' : 'site'}`} title={s.web ? '网页上读到的；刷新数据站不会删掉它' : '数据站，每次刷新更新'}>
          {s.name}<small>{s.web ? '网页' : '数据站'} · {relativeTime(s.at, now)}</small>
          {sources.length > 1 && s.name === primary && <small className="fact-main">时间以它为准</small>}
        </span>
      ))}
      {a.screen !== undefined && <span className="fact-chip screen" title="agent 进游戏看到的剩余时间和进度">游戏画面<small>agent 看过 · {relativeTime(a.screen.at, now)}</small></span>}
    </div>
  )
}

export function ActivityDetail({ client, activity: a, game, onOpenGame, onChanged, openSession }: {
  client: AdgClient
  activity: Activity
  game: GameInfo | undefined
  /** Absent: already on the game's own page. */
  onOpenGame?: (() => void) | undefined
  onChanged: () => void
  openSession?: ((id: string) => void) | undefined
}) {
  const [shot, setShot] = useState<{ src: string; width: number; height: number } | null>(null)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const tz = game?.timezone ?? 'Asia/Shanghai'
  const fmt = (t: number) => new Date(t).toLocaleString('zh-CN', { timeZone: tz, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const save = async (patch: { todo?: string[]; done?: string[]; finished?: boolean }) => {
    setBusy(true)
    setError(null)
    try {
      await client.connection.call('games/activity/progress', { activityId: a.id, ...patch })
      onChanged()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const tick = (item: string) => void save({ todo: a.todo.filter(t => t !== item), done: [...a.done, item] })
  const untick = (item: string) => void save({ todo: [...a.todo, item], done: a.done.filter(t => t !== item) })
  const add = () => {
    const text = draft.trim()
    if (text === '' || a.todo.includes(text) || a.done.includes(text)) return
    setDraft('')
    void save({ todo: [...a.todo, text] })
  }
  return (
    <div className="ov-detail">
      {a.description !== undefined && <p className="ov-description">{a.description}</p>}
      <div className="activity-dates muted small">
        {a.startsAt !== undefined && <span>{fmt(a.startsAt)} 开始</span>}
        {a.endsAt !== undefined && <span>{fmt(a.endsAt)} 结束</span>}
        {a.shopEndsAt !== undefined && <span>商店开到 {fmt(a.shopEndsAt)}</span>}
      </div>
      <ActivitySources activity={a} />
      <div className="ov-checklist" role="list" aria-label="要做的事">
        {a.todo.map(t => (
          <label key={`t${t}`} className="ov-check" role="listitem"><input type="checkbox" checked={false} disabled={busy} onChange={() => tick(t)} />{t}</label>
        ))}
        {a.done.map(t => (
          <label key={`d${t}`} className="ov-check done" role="listitem"><input type="checkbox" checked disabled={busy} onChange={() => untick(t)} />{t}</label>
        ))}
        {a.todo.length + a.done.length === 0 && <p className="muted small">还没有要做的事。自己加几项（例如「活动商店换完」「剧情通关」），或者在游戏页让 agent 进游戏读一次。</p>}
      </div>
      <div className="ov-add">
        <input className="text-input plain" value={draft} maxLength={80} placeholder="加一项要做的事，回车添加" disabled={busy}
          onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} />
        <button className="small-button" disabled={busy || draft.trim() === ''} onClick={add}><Icon name="plus" />添加</button>
      </div>
      <div className="ov-detail-actions">
        <label className="check-label"><input type="checkbox" checked={a.finished !== undefined} disabled={busy} onChange={e => void save({ finished: e.target.checked })} />这个活动我做完了</label>
        <span className="spacer" />
        {a.screen?.evidence === true && <button className="link-button small" onClick={() => void client.connection.call('games/evidence', { activityId: a.id }).then(r => {
          const src = `data:${r.mediaType};base64,${r.data}`
          const img = new Image()
          img.onload = () => setShot({ src, width: img.naturalWidth, height: img.naturalHeight })
          img.src = src
        }, e => setError(errorText(e)))}>看游戏截图</button>}
        {a.screen?.sessionId !== undefined && openSession !== undefined && <button className="link-button small" onClick={() => openSession(a.screen!.sessionId!)}>agent 的对话</button>}
        {a.url !== undefined && <a className="link-button small" href={a.url} target="_blank" rel="noreferrer">活动页面</a>}
        {onOpenGame !== undefined && <button className="link-button small" onClick={onOpenGame}>去{game?.name ?? '游戏'}</button>}
        <button className="link-button small muted" title="读错了或不关心" disabled={busy} onClick={() => void client.connection.call('games/activity/remove', { activityId: a.id }).then(onChanged, e => setError(errorText(e)))}>从日历去掉</button>
      </div>
      {error !== null && <div className="notice error left small"><Icon name="alert" /><span>{error}</span></div>}
      {shot !== null && <ImageViewer src={shot.src} width={shot.width} height={shot.height} name={`${a.name}.png`} onClose={() => setShot(null)} />}
    </div>
  )
}

/** The SRA public API's other games: follow one to see its events here too. */
export function CatalogPicker({ client, onChanged, onDiscover }: { client: AdgClient; onChanged: () => void; onDiscover?: (name: string) => void }) {
  const [catalog, setCatalog] = useState<Catalog | null>(null)
  const [wanted, setWanted] = useState('')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  useEffect(() => {
    let live = true
    client.connection.call('games/catalog', {}).then(r => { if (live) setCatalog(r.games) }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, revision])
  const follow = async (sra: string, on: boolean) => {
    setBusy(sra)
    setError(null)
    try {
      await client.connection.call('games/follow', { sra, follow: on })
      setRevision(r => r + 1)
      onChanged()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  return (
    <div className="catalog-picker">
      <p className="muted small">这些游戏的活动来自 <a href="https://starrailassistant.top/reference/public-api/" target="_blank" rel="noreferrer">SRA 公共 API</a>（社区按官方公告整理，免费，不用模型）。勾上的游戏每天自动读一次。</p>
      {catalog === null && error === null && <p className="muted small">正在读取…</p>}
      <div className="catalog-grid">
        {catalog?.map(g => (
          <label key={g.sra} className={`check-label ${g.pack !== undefined ? 'muted' : ''}`} title={g.pack !== undefined ? '已经有游戏包在读它' : undefined}>
            <input type="checkbox" checked={g.pack !== undefined || g.followed} disabled={g.pack !== undefined || busy !== null} onChange={e => void follow(g.sra, e.target.checked)} />
            {g.name}{g.pack !== undefined ? '（已有）' : busy === g.sra ? '…' : ''}
          </label>
        ))}
      </div>
      {onDiscover !== undefined && (
        <form className="discover-row" onSubmit={e => { e.preventDefault(); const name = wanted.trim(); if (name !== '') { onDiscover(name); setWanted('') } }}>
          <span className="field-title">列表里没有？</span>
          <input className="text-input plain" value={wanted} maxLength={60} placeholder="输入游戏名，例如：重返未来：1999" onChange={e => setWanted(e.target.value)} />
          <button className="small-button primary" type="submit" disabled={wanted.trim() === ''}><Icon name="search" />让 agent 去找</button>
          <span className="muted small">agent 会找它的 Wiki、官网公告等来源，建一个游戏包加到游戏页。</span>
        </form>
      )}
      {error !== null && <div className="notice error left small"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}
