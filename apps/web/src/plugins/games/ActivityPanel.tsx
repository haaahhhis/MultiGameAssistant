import { useEffect, useRef, useState, type CSSProperties, type ReactNode } from 'react'
import type { AdgClient } from '@adg/client-core'
import { OWN_SOURCE, SCREEN_SOURCE, type Activity, type GameInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { ImageViewer } from '../../components/ImageViewer.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { errorText } from '../scripts/data.ts'
import { ActivityEditor } from './ActivityEditor.tsx'
import { ActivityMedia, zoneLabel } from './GameView.tsx'
import { useRemoteImage } from './images.ts'
import { ProgressPill, progressOf } from './Overview.tsx'

/**
 * An event's details, in a panel over the side of the page: the board under it
 * never moves, so a card stays where it was clicked, and clicking another one
 * only changes what the panel says. Closes with Esc, its ✕, the same card
 * again, or a click on the page beside it (not while a form is open in it).
 */
export function ActivityPanel({ color, label, onClose, children }: { color: string; label: string; onClose: () => void; children: ReactNode }) {
  const panel = useRef<HTMLElement>(null)
  useEffect(() => {
    const element = panel.current
    if (element === null) return
    const opener = document.activeElement
    element.focus({ preventScroll: true })
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    const element = panel.current
    const stage = element?.parentElement
    if (element === null || element === undefined || stage === null || stage === undefined) return
    // A form may hold unsaved words: it goes only by its own buttons (or its own Esc).
    const held = () => element.querySelector('form.activity-editor') !== null
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !held() && document.querySelector('.image-viewer') === null) onClose()
    }
    const onDown = (e: PointerEvent) => {
      const target = e.target
      if (!(target instanceof Element) || element.contains(target) || !stage.contains(target)) return
      // A card or a row opens itself here instead.
      if (target.closest('.sched-card, .ov-row') !== null || held()) return
      onClose()
    }
    document.addEventListener('keydown', onKey)
    document.addEventListener('pointerdown', onDown)
    return () => {
      document.removeEventListener('keydown', onKey)
      document.removeEventListener('pointerdown', onDown)
    }
  }, [onClose])
  return (
    <>
      <div className="activity-scrim" aria-hidden="true" />
      <aside ref={panel} className="activity-panel" aria-label={label} tabIndex={-1} style={{ '--game': color } as CSSProperties}>
        {children}
      </aside>
    </>
  )
}

/** One place an event's facts come from, as the panel lists it. */
interface SourceRow {
  id: string
  name: string
  note: string
  title: string
  startsAt?: number | undefined
  endsAt?: number | undefined
  shopEndsAt?: number | undefined
  cover?: string | undefined
  /** Says nothing about the picture or the dates, so there is nothing to choose. */
  blank: boolean
}

/** In the order a picture goes by: the user, data sites, web pages, the game screen. */
function sourceRows(a: Activity, now: number): SourceRow[] {
  const ago = (at: number) => relativeTime(at, now)
  const facts = a.sources ?? []
  const own = a.own
  const said = (r: Pick<SourceRow, 'startsAt' | 'endsAt' | 'cover'>) => r.startsAt !== undefined || r.endsAt !== undefined || r.cover !== undefined
  const row = (s: (typeof facts)[number]): SourceRow => ({
    id: s.id, name: s.name, note: `${s.web ? '网页' : '数据站'} · ${ago(s.at)}`,
    title: s.web ? 'agent 在网页上读到的；刷新数据站不会删掉它' : '数据站，每次刷新更新',
    startsAt: s.startsAt, endsAt: s.endsAt, shopEndsAt: s.shopEndsAt, cover: s.cover,
    blank: !said(s) && s.shopEndsAt === undefined,
  })
  return [
    {
      id: OWN_SOURCE, name: '我设的', note: own === undefined ? '' : ago(own.at),
      title: '你自己填的：刷新不会改掉', startsAt: own?.startsAt, endsAt: own?.endsAt, cover: own?.cover,
      blank: own === undefined || !said(own),
    },
    ...facts.filter(s => !s.web).map(row),
    ...facts.filter(s => s.web).map(row),
    ...(a.screen === undefined ? [] : [{
      id: SCREEN_SOURCE, name: '游戏画面', note: `agent 看过 · ${ago(a.screen.at)}`,
      title: 'agent 进游戏看到的剩余时间和截图', endsAt: a.screen.endsAt, cover: a.screen.image,
      blank: a.screen.endsAt === undefined && a.screen.image === undefined,
    }]),
  ]
}

/** What the event shows from this source right now. */
function usedFrom(a: Activity, id: string): string[] {
  const starts = a.shown?.startsAt === id
  const ends = a.shown?.endsAt === id
  return [
    ...(a.shown?.cover === id ? ['图片'] : []),
    ...(starts && ends ? ['时间'] : starts ? ['开始时间'] : ends ? ['结束时间'] : []),
  ]
}

function SourceThumb({ client, url }: { client: AdgClient; url: string | undefined }) {
  const art = useRemoteImage(client, url)
  return <span className={`source-thumb ${url === undefined ? 'none' : ''}`}>{art !== undefined ? <img src={art} alt="" decoding="async" /> : url === undefined ? '无图' : null}</span>
}

/**
 * What the panel says about one event: its picture, dates, each source with the
 * picture and dates it gives (click one to use it), and the checklist. Keyed by
 * the event, so a switch starts clean; every block keeps its place as sources
 * are switched.
 */
export function ActivityPanelBody({ client, activity: a, game, now, soonDays, onClose, onOpenGame, onChanged, openSession }: {
  client: AdgClient
  activity: Activity
  game: GameInfo | undefined
  now: number
  soonDays: number
  onClose: () => void
  /** Absent: already on the game's own page. */
  onOpenGame?: (() => void) | undefined
  onChanged: () => void
  openSession?: ((id: string) => void) | undefined
}) {
  const [viewing, setViewing] = useState<{ src: string; width: number; height: number; name: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The click shows at once; the list catches up a moment later.
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  useEffect(() => setPicked(undefined), [a.chosen])
  const chosen = picked !== undefined ? picked ?? undefined : a.chosen

  // The picture being replaced stays until the new one is here: no flash of nothing on a switch.
  const loaded = useRemoteImage(client, a.cover)
  const last = useRef<{ url: string; src: string } | undefined>(undefined)
  if (loaded !== undefined && a.cover !== undefined) last.current = { url: a.cover, src: loaded }
  const art = a.cover === undefined ? undefined : loaded ?? last.current?.src

  const tz = game?.timezone ?? 'Asia/Shanghai'
  const fmt = (t: number) => new Date(t).toLocaleString('zh-CN', { timeZone: tz, hour12: false, month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' })
  const rows = sourceRows(a, now)
  const anyShop = a.shopEndsAt !== undefined || rows.some(r => r.shopEndsAt !== undefined)
  const sourced = a.sources !== undefined || a.screen !== undefined

  const run = (work: Promise<unknown>, after?: () => void) => {
    setBusy(true)
    setError(null)
    work.then(() => { onChanged(); after?.() }, e => setError(errorText(e))).finally(() => setBusy(false))
  }
  const save = (patch: { todo?: string[]; done?: string[]; finished?: boolean }) => run(client.connection.call('games/activity/progress', { activityId: a.id, ...patch }))
  const tick = (item: string) => save({ todo: a.todo.filter(t => t !== item), done: [...a.done, item] })
  const untick = (item: string) => save({ todo: [...a.todo, item], done: a.done.filter(t => t !== item) })
  const add = () => {
    const text = draft.trim()
    if (text === '' || a.todo.includes(text) || a.done.includes(text)) return
    setDraft('')
    save({ todo: [...a.todo, text] })
  }
  const choose = (source: string | null) => {
    setPicked(source)
    setError(null)
    client.connection.call('games/activity/source', { activityId: a.id, source }).then(onChanged, e => { setPicked(undefined); setError(errorText(e)) })
  }
  const view = (src: string, name: string) => {
    const img = new Image()
    img.onload = () => setViewing({ src, width: img.naturalWidth, height: img.naturalHeight, name })
    img.src = src
  }
  const reset = () => {
    setBusy(true)
    setError(null)
    client.connection.call('games/activity/reset', { activityId: a.id })
      .then(r => { onChanged(); if (r.activity === undefined) onClose() }, e => setError(errorText(e)))
      .finally(() => setBusy(false))
  }

  if (editing && game !== undefined) {
    return (
      <div className="panel-scroll">
        <ActivityEditor client={client} game={game} activity={a} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
      </div>
    )
  }

  return (
    <>
      <div className="panel-scroll">
        <div className="panel-media">
          <button className="panel-media-open" disabled={art === undefined} title={art === undefined ? undefined : '看大图'} aria-label="看大图" onClick={() => { if (art !== undefined) view(art, `${a.name}.png`) }}>
            <ActivityMedia activity={a} art={art} now={now} soonDays={soonDays} />
          </button>
          <button className="panel-close" aria-label="关闭详情" title="关闭（Esc）" onClick={onClose}><Icon name="close" /></button>
        </div>

        <div className="panel-section panel-title">
          <h3>{a.name}</h3>
          <div className="panel-meta">
            <span className="panel-game"><span className="game-dot" />{game?.name ?? a.game}</span>
            {a.kind !== undefined && <span className="sched-kind">{a.kind}</span>}
            <span className="spacer" />
            <ProgressPill progress={progressOf(a)} />
          </div>
          <dl className={`panel-dates ${anyShop ? 'with-shop' : ''}`}>
            <div><dt>开始</dt><dd>{a.startsAt === undefined ? '未知' : fmt(a.startsAt)}</dd></div>
            <div><dt>结束</dt><dd>{a.endsAt === undefined ? '未知' : fmt(a.endsAt)}</dd></div>
            {anyShop && <div><dt>商店开到</dt><dd>{a.shopEndsAt === undefined ? '—' : fmt(a.shopEndsAt)}</dd></div>}
          </dl>
          <span className="muted small">{zoneLabel(tz, now)}，游戏服务器时间{a.screen?.remaining === undefined ? '' : `；游戏里显示「${a.screen.remaining}」`}</span>
        </div>

        <section className="panel-section" aria-label="信息来源">
          <div className="panel-section-head">
            <h4>信息来源</h4>
            <span className="spacer" />
            {chosen !== undefined && <button className="link-button small" onClick={() => choose(null)}>恢复默认</button>}
          </div>
          <div className="source-rows">
            {rows.map(r => {
              const uses = usedFrom(a, r.id)
              const own = r.id === OWN_SOURCE
              const on = chosen === r.id
              return (
                <button key={r.id} className={`source-row ${on ? 'on' : ''}`} aria-pressed={on} disabled={r.blank && !own} title={r.title}
                  onClick={() => { if (r.blank && own) setEditing(true); else choose(on ? null : r.id) }}>
                  <SourceThumb client={client} url={r.cover} />
                  <span className="source-row-main">
                    <span className="source-row-name"><b>{r.name}</b>{on && <Icon name="check" />}{r.note !== '' && <small>{r.note}</small>}</span>
                    {r.blank
                      ? <span className="source-row-dates muted">{own ? '还没填，点这里设置图片和时间' : '没有时间和图片'}</span>
                      : (
                        <span className="source-row-dates">
                          {r.startsAt === undefined && r.endsAt === undefined ? '没有时间' : `${r.startsAt === undefined ? '？' : fmt(r.startsAt)} – ${r.endsAt === undefined ? '？' : fmt(r.endsAt)}`}
                          {r.shopEndsAt !== undefined && <em>商店到 {fmt(r.shopEndsAt)}</em>}
                        </span>
                      )}
                  </span>
                  <span className="source-row-uses">{uses.map(u => <i key={u}>{u}</i>)}</span>
                </button>
              )
            })}
          </div>
          <p className="muted small panel-hint">默认图片按 我设的 › 数据站和网页 › 游戏截图 显示。点一个来源，图片和时间就用它的；它没有的还按默认。</p>
        </section>

        {a.description !== undefined && <div className="panel-section"><p className="ov-description">{a.description}</p></div>}

        <section className="panel-section" aria-label="要做的事">
          <div className="panel-section-head"><h4>要做的事</h4>{a.todo.length + a.done.length > 0 && <span className="count">{a.done.length}/{a.todo.length + a.done.length}</span>}</div>
          <div className="ov-checklist" role="list">
            {a.todo.map(t => <label key={`t${t}`} className="ov-check" role="listitem"><input type="checkbox" checked={false} disabled={busy} onChange={() => tick(t)} />{t}</label>)}
            {a.done.map(t => <label key={`d${t}`} className="ov-check done" role="listitem"><input type="checkbox" checked disabled={busy} onChange={() => untick(t)} />{t}</label>)}
            {a.todo.length + a.done.length === 0 && <p className="muted small">还没有要做的事。自己加几项（例如「活动商店换完」），或者在游戏页让 agent 进游戏读一次。</p>}
          </div>
          <div className="ov-add">
            <input className="text-input plain" value={draft} maxLength={80} placeholder="加一项，回车添加" disabled={busy}
              onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} />
            <button className="small-button" disabled={busy || draft.trim() === ''} onClick={add}><Icon name="plus" />添加</button>
          </div>
        </section>

        <div className="panel-section panel-links">
          {a.url !== undefined && <a className="link-button small" href={a.url} target="_blank" rel="noreferrer">活动页面</a>}
          {a.screen?.evidence === true && <button className="link-button small" onClick={() => void client.connection.call('games/evidence', { activityId: a.id }).then(r => view(`data:${r.mediaType};base64,${r.data}`, `${a.name}-截图.png`), e => setError(errorText(e)))}>看游戏截图</button>}
          {a.screen?.sessionId !== undefined && openSession !== undefined && <button className="link-button small" onClick={() => openSession(a.screen!.sessionId!)}>agent 的对话</button>}
          {onOpenGame !== undefined && <button className="link-button small" onClick={onOpenGame}>去{game?.name ?? '游戏'}</button>}
          <span className="spacer" />
          {a.own !== undefined && sourced && <button className="link-button small muted" title="去掉你改过的名字、时间、图片等，恢复成来源的" disabled={busy} onClick={reset}>清除我设的</button>}
          <button className="link-button small muted" title="读错了或不关心" disabled={busy} onClick={() => run(client.connection.call('games/activity/remove', { activityId: a.id }), onClose)}>从日历去掉</button>
        </div>
        {error !== null && <div className="panel-section"><div className="notice error left small"><Icon name="alert" /><span>{error}</span></div></div>}
      </div>

      <div className="panel-foot">
        <label className="check-label"><input type="checkbox" checked={a.finished !== undefined} disabled={busy} onChange={e => save({ finished: e.target.checked })} />这个活动我做完了</label>
        <span className="spacer" />
        {game !== undefined && <button className="small-button" disabled={busy} onClick={() => setEditing(true)}><Icon name="pencil" />编辑</button>}
      </div>
      {viewing !== null && <ImageViewer src={viewing.src} width={viewing.width} height={viewing.height} name={viewing.name} onClose={() => setViewing(null)} />}
    </>
  )
}
