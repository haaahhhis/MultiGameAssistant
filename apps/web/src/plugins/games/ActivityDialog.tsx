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
 * A window at the centre of the screen, over a dimmed page, for an event on a
 * game's page. It keeps one size and the board under it stays where it was.
 * Closes with Esc, its ✕, or a click beside it (not while a form is open in it:
 * that may hold unsaved words, and goes only by its own buttons or its own Esc).
 */
export function ActivityDialog({ color, label, onClose, children }: { color: string; label: string; onClose: () => void; children: ReactNode }) {
  const frame = useRef<HTMLDivElement>(null)
  const held = () => frame.current?.querySelector('form.activity-editor') !== null
  useEffect(() => {
    const opener = document.activeElement
    frame.current?.focus({ preventScroll: true })
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }) }
  }, [])
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      // The picture viewer floats over this window, with keys of its own.
      if (document.querySelector('.image-viewer') !== null) return
      if (e.key === 'Escape' && !held()) onClose()
      if (e.key !== 'Tab' || frame.current === null) return
      // Tab stays in the window: the page behind it is out of reach while it is open.
      const stops = [...frame.current.querySelectorAll<HTMLElement>('a[href], button:not(:disabled), input:not(:disabled):not([hidden]), textarea:not(:disabled)')]
      const first = stops[0]
      const last = stops[stops.length - 1]
      const at = document.activeElement
      if (first === undefined || last === undefined) return
      if (e.shiftKey && (at === first || at === frame.current)) { e.preventDefault(); last.focus() }
      else if (!e.shiftKey && at === last) { e.preventDefault(); first.focus() }
    }
    document.addEventListener('keydown', onKey)
    return () => document.removeEventListener('keydown', onKey)
  }, [onClose])
  return (
    <div className="activity-scrim" onPointerDown={e => { if (e.target === e.currentTarget && !held()) onClose() }}>
      <div ref={frame} className="activity-dialog" role="dialog" aria-modal="true" aria-label={label} tabIndex={-1} style={{ '--game': color } as CSSProperties}>
        {children}
      </div>
    </div>
  )
}

/** One place an event's facts come from, as the window lists it. */
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
 * What the window says about one event. On the left what it is: its picture,
 * dates and description. On the right what to do with it: each source with the
 * picture and dates it gives (click one to use it), and the checklist. Keyed by
 * the event; every block keeps its place as sources are switched.
 */
export function ActivityDialogBody({ client, activity: listed, game, now, soonDays, onClose, onChanged, openSession }: {
  client: AdgClient
  activity: Activity
  game: GameInfo | undefined
  now: number
  soonDays: number
  onClose: () => void
  onChanged: () => void
  openSession?: ((id: string) => void) | undefined
}) {
  const [viewing, setViewing] = useState<{ src: string; width: number; height: number; name: string } | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // A switch shows at once: the click, then the event as the host returns it; the whole list catches up about a second later.
  const [switched, setSwitched] = useState<Activity | undefined>(undefined)
  useEffect(() => setSwitched(undefined), [listed])
  const a = switched ?? listed
  const [picked, setPicked] = useState<string | null | undefined>(undefined)
  useEffect(() => setPicked(undefined), [a.chosen])
  const chosen = picked !== undefined ? picked ?? undefined : a.chosen

  // The picture being replaced stays until the new one is here: no flash of nothing on a switch.
  const loaded = useRemoteImage(client, a.cover)
  const last = useRef<string | undefined>(undefined)
  if (loaded !== undefined) last.current = loaded
  const art = a.cover === undefined ? undefined : loaded ?? last.current

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
    client.connection.call('games/activity/source', { activityId: a.id, source }).then(r => { setSwitched(r); onChanged() }, e => { setPicked(undefined); setError(errorText(e)) })
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
      <div className="dialog-form">
        <ActivityEditor client={client} game={game} activity={a} onDone={() => { setEditing(false); onChanged() }} onCancel={() => setEditing(false)} />
      </div>
    )
  }

  return (
    <>
      <header className="dialog-head">
        <div className="dialog-title">
          <h3 title={a.name}>{a.name}</h3>
          <div className="dialog-meta">
            <span className="dialog-game"><span className="game-dot" />{game?.name ?? a.game}</span>
            {a.kind !== undefined && <span className="sched-kind">{a.kind}</span>}
          </div>
        </div>
        <ProgressPill progress={progressOf(a)} />
        <button className="dialog-close" aria-label="关闭详情" title="关闭（Esc）" onClick={onClose}><Icon name="close" /></button>
      </header>

      <div className="dialog-cols">
        <div className="dialog-col side">
          <button className="dialog-media" disabled={art === undefined} title={art === undefined ? undefined : '看大图'} aria-label="看大图" onClick={() => { if (art !== undefined) view(art, `${a.name}.png`) }}>
            <ActivityMedia activity={a} art={art} now={now} soonDays={soonDays} />
          </button>
          <div className="dialog-facts">
            <dl className="dialog-dates">
              <div><dt>开始</dt><dd>{a.startsAt === undefined ? '未知' : fmt(a.startsAt)}</dd></div>
              <div><dt>结束</dt><dd>{a.endsAt === undefined ? '未知' : fmt(a.endsAt)}</dd></div>
              {anyShop && <div className="wide"><dt>商店开到</dt><dd>{a.shopEndsAt === undefined ? '—' : fmt(a.shopEndsAt)}</dd></div>}
            </dl>
            <span className="muted small">{zoneLabel(tz, now)}，游戏服务器时间{a.screen?.remaining === undefined ? '' : `；游戏里显示「${a.screen.remaining}」`}</span>
            {a.description !== undefined && <p className="ov-description">{a.description}</p>}
          </div>
        </div>

        <div className="dialog-col main">
          <section className="dialog-section" aria-label="信息来源">
            <div className="dialog-section-head">
              <h4>信息来源</h4>
              <span className="spacer" />
              {chosen !== undefined && <button className="link-button small" onClick={() => choose(null)}>恢复默认</button>}
            </div>
            <div className="source-rows">
              {rows.map(r => {
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
                            <span>{r.startsAt === undefined && r.endsAt === undefined ? '没有时间' : `${r.startsAt === undefined ? '？' : fmt(r.startsAt)} – ${r.endsAt === undefined ? '？' : fmt(r.endsAt)}`}</span>
                            {r.shopEndsAt !== undefined && <em>商店到 {fmt(r.shopEndsAt)}</em>}
                          </span>
                        )}
                    </span>
                    <span className="source-row-uses">{usedFrom(a, r.id).map(u => <i key={u}>{u}</i>)}</span>
                  </button>
                )
              })}
            </div>
            <p className="muted small dialog-hint">默认图片按 我设的 › 数据站和网页 › 游戏截图 显示。点一个来源，图片和时间就用它的；它没有的还按默认。</p>
          </section>

          <section className="dialog-section" aria-label="要做的事">
            <div className="dialog-section-head"><h4>要做的事</h4>{a.todo.length + a.done.length > 0 && <span className="count">{a.done.length}/{a.todo.length + a.done.length}</span>}</div>
            <div className="ov-checklist" role="list">
              {a.todo.map(t => <label key={`t${t}`} className="ov-check" role="listitem"><input type="checkbox" checked={false} disabled={busy} onChange={() => tick(t)} />{t}</label>)}
              {a.done.map(t => <label key={`d${t}`} className="ov-check done" role="listitem"><input type="checkbox" checked disabled={busy} onChange={() => untick(t)} />{t}</label>)}
              {a.todo.length + a.done.length === 0 && <p className="muted small">还没有要做的事。自己加几项（例如「活动商店换完」），或者让 agent 进游戏读一次。</p>}
            </div>
            <div className="ov-add">
              <input className="text-input plain" value={draft} maxLength={80} placeholder="加一项，回车添加" disabled={busy}
                onChange={e => setDraft(e.target.value)} onKeyDown={e => { if (e.key === 'Enter') add() }} />
              <button className="small-button" disabled={busy || draft.trim() === ''} onClick={add}><Icon name="plus" />添加</button>
            </div>
          </section>

          <div className="dialog-section dialog-links">
            {a.url !== undefined && <a className="link-button small" href={a.url} target="_blank" rel="noreferrer">活动页面</a>}
            {a.screen?.evidence === true && <button className="link-button small" onClick={() => void client.connection.call('games/evidence', { activityId: a.id }).then(r => view(`data:${r.mediaType};base64,${r.data}`, `${a.name}-截图.png`), e => setError(errorText(e)))}>看游戏截图</button>}
            {a.screen?.sessionId !== undefined && openSession !== undefined && <button className="link-button small" onClick={() => openSession(a.screen!.sessionId!)}>agent 的对话</button>}
            <span className="spacer" />
            {a.own !== undefined && sourced && <button className="link-button small muted" title="去掉你改过的名字、时间、图片等，恢复成来源的" disabled={busy} onClick={reset}>清除我设的</button>}
            <button className="link-button small muted" title="读错了或不关心" disabled={busy} onClick={() => run(client.connection.call('games/activity/remove', { activityId: a.id }), onClose)}>从日历去掉</button>
          </div>
          {error !== null && <div className="dialog-section"><div className="notice error left small"><Icon name="alert" /><span>{error}</span></div></div>}
        </div>
      </div>

      <footer className="dialog-foot">
        <label className="check-label"><input type="checkbox" checked={a.finished !== undefined} disabled={busy} onChange={e => save({ finished: e.target.checked })} />这个活动我做完了</label>
        <span className="spacer" />
        {game !== undefined && <button className="small-button" disabled={busy} onClick={() => setEditing(true)}><Icon name="pencil" />编辑</button>}
      </footer>
      {viewing !== null && <ImageViewer src={viewing.src} width={viewing.width} height={viewing.height} name={viewing.name} onClose={() => setViewing(null)} />}
    </>
  )
}
