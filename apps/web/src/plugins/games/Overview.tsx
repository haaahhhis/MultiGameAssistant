import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { Activity, GameInfo, RequestResult } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { errorText } from '../scripts/data.ts'
import { useFirstImage, useRemoteImage } from './images.ts'

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
export function Overview({ client, games, activities, now, soonDays, open, onOpen, onOpenGame }: {
  client: AdgClient
  games: readonly GameInfo[]
  activities: readonly Activity[]
  now: number
  soonDays: number
  /** The event whose details are open in the panel. */
  open: string | null
  onOpen: (id: string) => void
  onOpenGame: (id: string) => void
}) {
  const [shown, setShown] = useState<string[] | null>(() => load<string[] | null>(SHOWN_KEY, null))
  const [mode, setMode] = useState<Mode>(() => load<Mode>(MODE_KEY, 'time'))
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

  // Whatever the shown games are: a hidden game's tile still says what it has.
  const liveOf = (id: string) => activities.filter(a => a.game === id && (a.startsAt ?? 0) <= now && (a.endsAt === undefined || Math.max(a.endsAt, a.shopEndsAt ?? 0) > now))

  return (
    <div className="games-overview">
      <div className="game-tiles" role="group" aria-label="各游戏">
        {games.map(g => {
          const live = liveOf(g.id)
          return (
            <GameTile key={g.id} client={client} game={g} color={color.get(g.id) ?? PALETTE[0]!} now={now} shown={visible(g.id)} running={live.length}
              soon={live.filter(a => a.endsAt !== undefined && a.endsAt - now < soonDays * DAY && progressOf(a).state !== 'finished').length}
              covers={live.map(a => a.cover).filter(c => c?.startsWith('shot:') !== true).slice(0, 6)}
              onOpen={() => onOpenGame(g.id)} onToggle={() => toggle(g.id)} />
          )
        })}
      </div>

      <section className="card games-overview-board">
        <div className="ov-toolbar">
          <div className="ov-stats">
            <Stat value={running.length} label="进行中" />
            <Stat value={soonCount} label="快结束未做完" tone={soonCount > 0 ? 'warn' : undefined} />
            <Stat value={counts.finished} label="做完" />
            <Stat value={counts.partial} label="做了一部分" />
            <Stat value={counts.unknown} label="没记录" />
          </div>
          <div className="segmented-control ov-mode" role="group" aria-label="排序">
            <button className={mode === 'time' ? 'active' : ''} aria-pressed={mode === 'time'} onClick={() => setMode('time')}>按时间</button>
            <button className={mode === 'game' ? 'active' : ''} aria-pressed={mode === 'game'} onClick={() => setMode('game')}>按游戏</button>
          </div>
        </div>
        <div className="ov-grid">
        <div className="ov-lines" aria-hidden="true">
          {ticks.filter(t => t.label !== undefined).map(t => <i key={t.at} style={{ left: `${x(t.at)}%` }} />)}
        </div>
        <div className="ov-row ov-axis" aria-hidden="true">
          <div className="ov-label" />
          <div className="ov-track">
            {ticks.map(t => <span key={t.at} className={`ov-tick ${t.label !== undefined ? 'major' : ''}`} style={{ left: `${x(t.at)}%` }}>{t.label !== undefined && <em>{t.label}</em>}</span>)}
            <span className="ov-today-label" style={{ left: `${x(now)}%` }}>今天</span>
          </div>
          <div className="ov-side" />
        </div>
        {sections.every(s => s.rows.length === 0) && <div className="empty"><Icon name="calendar" /><p>{games.length === 0 ? '没有游戏。' : '显示的游戏现在没有活动。点「刷新全部」读取，或点上面游戏卡片的眼睛多显示几个。'}</p></div>}
        {sections.filter(s => s.rows.length > 0).map(s => (
          <div key={s.key} className={`ov-section ${s.key === 'soon' ? 'warn' : ''} ${s.game !== undefined ? 'by-game' : ''}`} style={s.game === undefined ? undefined : { '--game': color.get(s.game.id) } as CSSProperties}>
            <div className="ov-section-title">
              {s.game !== undefined && <span className="game-dot" />}
              <span className="ov-section-name">{s.title}</span>
              <span className="ov-section-count">{s.rows.length}</span>
              {s.hint !== undefined && <span className="muted small">{s.hint}</span>}
              {s.game?.version !== undefined && <span className="muted small ov-section-version">{s.game.version.name}{s.game.version.title === undefined ? '' : `「${s.game.version.title}」`}</span>}
              {s.game !== undefined && <button className="link-button small ov-section-open" onClick={() => onOpenGame(s.game!.id)}>打开<Icon name="chevron" /></button>}
            </div>
            {s.rows.map(a => {
              const game = games.find(g => g.id === a.game)
              return (
                <ActivityRow key={a.id} client={client} activity={a} game={game} color={color.get(a.game) ?? PALETTE[0]!} showGame={mode === 'time'}
                  now={now} soonDays={soonDays} x={x} open={open === a.id} onToggle={() => onOpen(a.id)} />
              )
            })}
          </div>
        ))}
        <div className="ov-today" style={{ left: `calc(var(--ov-label) + (100% - var(--ov-label) - var(--ov-side)) * ${x(now) / 100})` }} aria-hidden="true" />
        </div>
      </section>
    </div>
  )
}

function Stat({ value, label, tone }: { value: number; label: string; tone?: 'warn' | undefined }) {
  return <span className={`ov-stat ${tone ?? ''} ${value === 0 ? 'zero' : ''}`}><strong>{value}</strong>{label}</span>
}

/** A game at a glance on its art: its version, what is on, what is ending. Opens the game; the eye shows or hides it on the timeline. */
function GameTile({ client, game, color, covers, now, running, soon, shown, onOpen, onToggle }: {
  client: AdgClient
  game: GameInfo
  color: string
  covers: readonly (string | undefined)[]
  now: number
  running: number
  soon: number
  shown: boolean
  onOpen: () => void
  onToggle: () => void
}) {
  const v = game.version
  const art = useFirstImage(client, [v?.cover, game.art, ...covers])
  const ends = v?.endsAt !== undefined && v.endsAt > now ? ` · 还剩 ${leftText(v.endsAt, now)}` : ''
  return (
    <article className={`game-tile ${art === undefined ? 'no-art' : ''} ${shown ? '' : 'off'}`} style={{ '--game': color } as CSSProperties}>
      {art !== undefined && <img className="game-tile-art" src={art} alt="" />}
      <span className="game-tile-shade" />
      <button className="game-tile-open" title={`打开${game.name}`} onClick={onOpen}>
        <span className="game-tile-name"><span className="game-dot" />{game.name}</span>
        <span className="game-tile-version">{v === undefined ? '没有版本信息' : `${v.name}${v.title === undefined ? '' : `「${v.title}」`}${ends}`}</span>
        <span className="game-tile-counts">
          <span><b>{running}</b> 进行中</span>
          {soon > 0 && <span className="soon"><b>{soon}</b> 快结束</span>}
        </span>
      </button>
      <button className="game-tile-eye" aria-pressed={shown} aria-label={`在时间线上显示${game.name}`} title={shown ? '在时间线上隐藏' : '在时间线上显示'} onClick={onToggle}>
        <Icon name={shown ? 'eye' : 'eye-off'} />
      </button>
    </article>
  )
}

function ActivityRow({ client, activity: a, game, color, showGame, now, soonDays, x, open, onToggle }: {
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
}) {
  const p = progressOf(a)
  const started = (a.startsAt ?? 0) <= now
  const end = a.endsAt
  const soon = started && end !== undefined && end - now < soonDays * DAY && p.state !== 'finished'
  const left = x(a.startsAt ?? now - 30 * DAY)
  const right = end === undefined ? 100 : x(end)
  const shop = a.shopEndsAt === undefined || end === undefined || a.shopEndsAt <= end ? undefined : x(a.shopEndsAt)
  const art = useRemoteImage(client, a.cover)
  return (
    <div className={`ov-item ${open ? 'open' : ''}`} style={{ '--game': color } as CSSProperties}>
      <button className={`ov-row ${soon ? 'soon' : ''} ${p.state === 'finished' ? 'finished' : ''}`} onClick={onToggle} aria-expanded={open}>
        <div className="ov-label">
          <span className="ov-thumb">{art !== undefined && <img src={art} alt="" decoding="async" />}</span>
          <span className="ov-text">
            <span className="ov-name" title={a.name}>{a.name}</span>
            {(showGame || a.kind !== undefined) && (
              <span className="ov-meta">
                {showGame && <><span className="game-dot" />{game?.name ?? a.game}</>}
                {a.kind !== undefined && <span className="ov-kind">{a.kind}</span>}
              </span>
            )}
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
