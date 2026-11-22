import { useEffect, useMemo, useRef, useState, type CSSProperties } from 'react'
import type { AdgClient } from '@adg/client-core'
import { OWN_SOURCE, SCREEN_SOURCE, type Activity, type GameInfo, type GameNotice, type MirrorSearchItem, type Pipeline, type PipelineSummary, type RequestParams } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { desktop } from '../../desktop.ts'
import { useStore } from '../../hooks.ts'
import { pickPath } from '../../pickPath.ts'
import { errorText } from '../scripts/data.ts'
import { NoticeDialog } from './NoticeDialog.tsx'
import { IMAGE_TYPES, readImage } from './ActivityEditor.tsx'
import { useFirstImage, useRemoteImage } from './images.ts'
import { ProgressPill, progressOf } from './Overview.tsx'

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000
type Pool = NonNullable<GameInfo['pools']>[number]
/** Announcements shown before 「展开全部」. */
const NOTICES_SHOWN = 5
const NOTICE_KIND: Record<GameNotice['kind'], string> = { update: '版本更新', notice: '公告', news: '资讯' }

/** "11 天 2 时", "5 时 20 分". */
export function countdown(end: number, now: number): string {
  const ms = end - now
  if (ms <= 0) return '已结束'
  if (ms >= DAY) return `${Math.floor(ms / DAY)} 天 ${Math.floor((ms % DAY) / HOUR)} 时`
  return `${Math.floor(ms / HOUR)} 时 ${Math.floor((ms % HOUR) / MINUTE)} 分`
}

/** The time left as a big number and its unit, and the next smaller unit: 11 天 + 2 时, 5 时 + 20 分. */
function split(ms: number): { value: string; unit: string; rest: string } {
  if (ms <= 0) return { value: '0', unit: '时', rest: '' }
  if (ms >= DAY) return { value: String(Math.floor(ms / DAY)), unit: '天', rest: `${Math.floor((ms % DAY) / HOUR)} 时` }
  if (ms >= HOUR) return { value: String(Math.floor(ms / HOUR)), unit: '时', rest: `${Math.floor((ms % HOUR) / MINUTE)} 分` }
  return { value: String(Math.max(1, Math.floor(ms / MINUTE))), unit: '分', rest: '' }
}

/** "2026/11/05 04:00" in the game's zone. */
function stamp(at: number, timeZone: string): string {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone, hourCycle: 'h23', year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }).formatToParts(new Date(at)).map(x => [x.type, x.value]))
  return `${p['year']}/${p['month']}/${p['day']} ${p['hour']}:${p['minute']}`
}

/** "UTC+8" for the game's zone. */
export function zoneLabel(timeZone: string, at: number): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date(at)).find(x => x.type === 'timeZoneName')?.value ?? ''
  return name.replace('GMT', 'UTC') || timeZone
}

/**
 * One game: the version's art across the top, then what is in it now (banners,
 * every event as a picture card) with, in a column beside them, where the user
 * stands (progress, the agent's last look), the pipelines that play it on a
 * timetable, and where its data comes from.
 */
export function GameView({ client, game, activities, notices, color, now, soonDays, busy, open, adding, onOpen, onAdd, onRefresh, onRead, onReadWeb, onDiscover, onRemove, onChanged, openSession, openScripts }: {
  client: AdgClient
  game: GameInfo
  activities: readonly Activity[]
  /** Its announcements: the long-term ones first, then the newest. */
  notices: readonly GameNotice[]
  color: string
  now: number
  soonDays: number
  busy: string | null
  /** The event whose details are open in the window. */
  open: string | null
  /** The window is adding a new event. */
  adding: boolean
  onOpen: (id: string) => void
  onAdd: () => void
  onRefresh: () => void
  onRead: () => void
  /** The agent reads the web: one source of the game pack, or all it cannot read itself. */
  onReadWeb: (source?: string) => void
  /** The agent finds where the game can be read and writes it into its game pack (one added by name has nothing yet). */
  onDiscover: () => void
  /** Take it off the game page (one added here is deleted). */
  onRemove: () => void
  onChanged: () => void
  openSession: (id: string) => void
  openScripts: () => void
}) {
  const [showFinished, setShowFinished] = useState(false)
  const [showAllNotices, setShowAllNotices] = useState(false)
  const [noticeId, setNoticeId] = useState<string | null>(null)
  const selectedNotice = notices.find(n => n.id === noticeId)
  const live = activities.filter(a => Math.max(a.endsAt ?? Infinity, a.shopEndsAt ?? 0) > now)
  const byEnd = (a: Activity, b: Activity) => (a.endsAt ?? Infinity) - (b.endsAt ?? Infinity)
  const running = live.filter(a => (a.startsAt ?? 0) <= now).sort(byEnd)
  const upcoming = live.filter(a => a.startsAt !== undefined && a.startsAt > now).sort((a, b) => a.startsAt! - b.startsAt!)
  const soon = running.filter(a => progressOf(a).state !== 'finished' && (a.endsAt ?? Infinity) - now < soonDays * DAY)
  const auto = game.sources.some(s => s.auto)
  // Ordered by what needs the user: ending undone first; then what they have started, then the rest; done ones last.
  const rank = { partial: 0, unknown: 1, finished: 2 } as const
  const ongoing = running.filter(a => !soon.includes(a) && progressOf(a).state !== 'finished')
    .sort((a, b) => rank[progressOf(a).state] - rank[progressOf(b).state] || byEnd(a, b))
  const finishedOnes = running.filter(a => progressOf(a).state === 'finished')
  const groups: { key: string; title: string; hint: string; rows: Activity[]; tone?: string }[] = [
    { key: 'soon', title: '需要关注', hint: `${soonDays} 天内结束，还没做完`, rows: soon, tone: 'warn' },
    { key: 'ongoing', title: '进行中', hint: '做了一部分的在前', rows: ongoing },
    { key: 'upcoming', title: '即将开始', hint: '按开始时间', rows: upcoming },
  ]
  const card = (a: Activity) => (
    <div key={a.id} className="schedule-item">
      <ScheduleCard client={client} activity={a} game={game} now={now} soonDays={soonDays} onClick={() => onOpen(a.id)} expanded={open === a.id} />
    </div>
  )

  const single = game.single === true
  const latestUpdate = notices.find(n => n.kind === 'update')
  const noticeSection = (notices.length > 0 || single) ? (
    <section className="game-section game-notices" aria-label="公告">
      <div className="game-section-head">
        <h3>{single ? '公告与更新' : '公告'}</h3>
        <span className="count">{notices.length}</span>
        <span className="spacer" />
        {single && <span className="muted small">{auto ? '每天自动读官方公告' : '让 agent 上网查'}</span>}
        <button className="icon-button" title="让 agent 上网查最新的公告和更新" aria-label="让 agent 查公告" disabled={busy !== null || game.webReading?.state === 'running'} onClick={() => onReadWeb()}>
          <Icon name="search" />
        </button>
        {auto && (
          <button className="icon-button" title="刷新数据站（不用模型）" disabled={busy !== null} onClick={onRefresh}>
            <Icon name="refresh" />
          </button>
        )}
      </div>
      {notices.length === 0 && <p className="muted small schedule-empty">还没有公告。点右上角让 agent 上网查；在 Steam 上的游戏，加上 Steam 来源后每天自动读它的官方公告。</p>}
      <ul className="notice-list">
        {(showAllNotices ? notices : notices.slice(0, NOTICES_SHOWN)).map(n => <NoticeRow key={n.id} client={client} notice={n} now={now} onOpen={() => setNoticeId(n.id)} />)}
      </ul>
      {selectedNotice && <NoticeDialog key={selectedNotice.id} client={client} notice={selectedNotice} kind={NOTICE_KIND[selectedNotice.kind]} color={color} onClose={() => setNoticeId(null)} />}
      {notices.length > NOTICES_SHOWN && (
        <button className="link-button small notice-more" onClick={() => setShowAllNotices(s => !s)}>{showAllNotices ? '收起' : `展开全部 ${notices.length} 条`}</button>
      )}
    </section>
  ) : null

  return (
    <div className="game-view" style={{ '--game': color } as CSSProperties}>
      {/* A screenshot is an event's background, not the version's art. */}
      <VersionHero client={client} game={game} now={now} update={latestUpdate}
        covers={[latestUpdate?.cover, ...running.map(a => a.cover).filter(c => c?.startsWith('shot:') !== true)]} onChanged={onChanged} />
      <div className="game-columns">
        <div className="game-main">
          {game.sources.length === 0 && (
            <section className="game-section game-unknown">
              <div className="game-unknown-text">
                <h3>还不知道去哪里看「{game.name}」的活动</h3>
                <p className="muted small">让 agent 去找它的 Wiki、官网公告等来源，写进这个游戏的游戏包；找到能自动读的，以后每天自动刷新。也可以在「数据来源」里自己添加网址，或点「活动日程」的「+」自己记。</p>
              </div>
              <button className="small-button primary" disabled={busy !== null || game.webReading?.state === 'running'} onClick={onDiscover}>
                <Icon name="search" />{game.webReading?.state === 'running' ? 'agent 正在找…' : '让 agent 去找'}
              </button>
            </section>
          )}
          {(game.pools?.length ?? 0) > 0 && (
            <section className="game-section pools-card">
              <div className="game-section-head"><h3>卡池</h3><span className="count">{game.pools!.length}</span></div>
              <div className="pool-list">{game.pools!.map(p => <PoolCard key={`${p.name}-${p.endsAt}`} client={client} pool={p} game={game} now={now} />)}</div>
            </section>
          )}
          {/* A single-player game leads with its announcements; others with their events. */}
          {single && noticeSection}
          {(!single || live.length > 0 || finishedOnes.length > 0) ? (
          <section className="game-section game-events" aria-label="活动日程">
            <div className="game-section-head">
              <h3>活动日程</h3>
              <span className="count">{live.length}</span>
              <span className="spacer" />
              <span className="muted small">{game.sources.find(s => s.auto)?.name ?? '数据站'}</span>
              <button className="icon-button" title="自己添加一个活动" aria-label="添加活动" aria-pressed={adding} onClick={onAdd}>
                <Icon name="plus" />
              </button>
              <button className="icon-button" title={auto ? '刷新数据站（不用模型）' : '这个游戏没有能自动读的数据站'} disabled={busy !== null || !auto} onClick={onRefresh}>
                <Icon name="refresh" />
              </button>
            </div>
            {live.length === 0 && <p className="muted small schedule-empty">{auto ? '还没有活动。点右上角刷新，或点「+」自己添加。' : '这个游戏没有能自动读的数据站：让 agent 进游戏读一次，或点「+」自己添加。'}</p>}
            {groups.filter(g => g.rows.length > 0).map(g => (
              <section key={g.key} className={`schedule-group ${g.tone ?? ''}`}>
                <div className="schedule-group-title"><span>{g.title}</span><span className="count">{g.rows.length}</span><span className="muted small">{g.hint}</span></div>
                <div className="schedule-grid">{g.rows.map(card)}</div>
              </section>
            ))}
            {finishedOnes.length > 0 && (
              <section className="schedule-group done">
                <button className="schedule-group-title toggle" aria-expanded={showFinished} onClick={() => setShowFinished(s => !s)}>
                  <span>已做完</span><span className="count">{finishedOnes.length}</span><span className="muted small">{showFinished ? '收起' : '展开'}</span>
                  <Icon name="chevron-down" className={`chevron-icon ${showFinished ? 'open' : ''}`} />
                </button>
                {showFinished && <div className="schedule-grid">{finishedOnes.map(card)}</div>}
              </section>
            )}
          </section>
          ) : (
            <p className="muted small single-no-events">
              单机游戏没有限时活动。有要记的事（限时折扣、联动）可以<button className="link-button small" onClick={onAdd}>自己加一个</button>。
            </p>
          )}
          {!single && noticeSection}
        </div>

        <aside className="game-side">
          <StatusCard game={game} single={single} running={running} soon={soon} now={now} busy={busy} onRead={onRead} onReadWeb={onReadWeb} onRemove={onRemove} openSession={openSession} />
          <section className="card game-runs-card">
            <GameSchedule client={client} game={game} now={now} openScripts={openScripts} />
          </section>
          <section className="card game-sources-card">
            <h3>数据来源</h3>
            <div className="game-sources">
              {game.sources.map(s => (
                <span key={s.id} className={`source-chip ${s.auto ? 'auto' : 'agent'}`}>
                  {/* Read by the plugin each day, or by the agent when asked: the name does that; the arrow opens the page. */}
                  {s.auto
                    ? <span className="source-name" title="每天自动读取（不用模型）"><span className="source-dot auto" />{s.name}</span>
                    : <button className="source-name" disabled={busy !== null || game.webReading?.state === 'running'} title="让 agent 读这个来源，把活动记进日历" onClick={() => onReadWeb(s.id)}><span className="source-dot" />{s.name}<span className="source-action">agent 读</span></button>}
                  {s.homepage !== undefined && <a className="source-open" href={s.homepage} target="_blank" rel="noreferrer" title="在浏览器里打开" aria-label={`打开${s.name}`}><Icon name="popout" /></a>}
                  {s.added === true && <button className="source-open" title="不再读这个网址" aria-label={`删除${s.name}`} onClick={() => void client.connection.call('games/source/remove', { game: game.id, source: s.id }).then(onChanged, () => {})}><Icon name="close" /></button>}
                </span>
              ))}
              <AddLink client={client} game={game} onAdded={onChanged} />
            </div>
            {game.refreshed !== undefined && <span className="muted small">{relativeTime(game.refreshed.at, now)}刷新</span>}
            {game.refreshed !== undefined && !game.refreshed.ok && <span className="tone-error small">上次没读到：{game.refreshed.detail}</span>}
          </section>
        </aside>
      </div>
    </div>
  )
}

/**
 * The version: its key art as a banner across the page, the name set in serif
 * at the foot of the picture, and under it the version's span as a track — how
 * far through it is, and the time left at its end.
 */
function VersionHero({ client, game, now, update, covers, onChanged }: { client: AdgClient; game: GameInfo; now: number; update: GameNotice | undefined; covers: readonly (string | undefined)[]; onChanged: () => void }) {
  const v = game.version
  // The picture the user chose; else the version's art when it loads; else the pack's own picture; else an event's cover.
  const art = useFirstImage(client, [game.banner, v?.cover, game.art, ...covers])
  const span = v?.startsAt !== undefined && v.endsAt !== undefined ? v.endsAt - v.startsAt : undefined
  const through = span === undefined || span <= 0 ? undefined : Math.min(1, Math.max(0, (now - v!.startsAt!) / span))
  const day = (at: number) => new Date(at).toLocaleDateString('zh-CN', { timeZone: game.timezone, month: 'numeric', day: 'numeric' })
  return (
    <section className={`version-hero ${art === undefined ? 'no-art' : ''} ${game.banner !== undefined ? 'custom' : ''}`}>
      {art !== undefined && <img key={game.banner ?? 'default'} className="version-art" src={art} alt="" />}
      <div className="version-shade" />
      <BannerPicker client={client} game={game} onChanged={onChanged} />
      <div className="version-caption">
        <span className="version-kicker">{game.name}{v !== undefined ? <> · <b>{v.name}</b> 版本</> : update?.version !== undefined ? <> · 最新 <b>{update.version}</b></> : ''}</span>
        <h2>{v?.title ?? game.name}</h2>
      </div>
      <div className="version-strip">
        {v === undefined && update !== undefined && (
          <span className="small version-none version-update" title={update.title}>
            最新更新：{update.title}{update.publishedAt === undefined ? '' : ` · ${relativeTime(update.publishedAt, now)}`}
          </span>
        )}
        {v === undefined && update === undefined && (
          <span className="small version-none">
            {game.single === true
              ? (game.sources.some(s => s.auto) ? '还没有更新公告：点「公告与更新」右上角刷新' : '还没有更新公告：点「公告与更新」右上角让 agent 查')
              : game.sources.length === 0 ? '还没有数据来源' : game.sources.some(s => s.auto) ? '还没有版本信息：点「活动日程」右上角刷新' : '这个游戏的数据站不提供版本信息'}
          </span>
        )}
        {v !== undefined && through !== undefined && (
          <>
            <span className="version-end">{day(v.startsAt!)}</span>
            <div className="version-track" role="meter" aria-label="版本进度" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(through * 100)}>
              <span className="version-fill" style={{ width: `${through * 100}%` }} />
              <span className="version-now" style={{ left: `${through * 100}%` }} />
            </div>
            <span className="version-end">{day(v.endsAt!)}</span>
          </>
        )}
        {v?.endsAt !== undefined && (
          <span className="version-remaining">{v.endsAt > now ? <>还剩 <strong>{countdown(v.endsAt, now)}</strong></> : '本版本已结束'}</span>
        )}
      </div>
    </section>
  )
}

/**
 * 「换背景」 in the banner's corner: a picture of the user's own for this game's
 * banner (the desktop app's file dialog, else the page's), kept by the host;
 * 「恢复默认」 shows the version's art again.
 */
function BannerPicker({ client, game, onChanged }: { client: AdgClient; game: GameInfo; onChanged: () => void }) {
  const fileRef = useRef<HTMLInputElement>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const set = async (choice: () => Promise<Omit<RequestParams<'games/banner/set'>, 'game'> | null>) => {
    setError(null)
    try {
      const params = await choice()
      if (params === null) return
      setBusy(true)
      await client.connection.call('games/banner/set', { game: game.id, ...params })
      onChanged()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  const choose = () => {
    if (desktop() === undefined) { fileRef.current?.click(); return }
    void set(async () => {
      const path = await pickPath(client, { kind: 'file', title: '选择横幅背景图片', filterName: '图片', extensions: ['png', 'jpg', 'jpeg', 'gif', 'webp', 'avif'] })
      return path === null ? null : { path }
    })
  }
  return (
    <div className={`version-tools ${error !== null ? 'has-error' : ''}`}>
      {error !== null && <span className="version-tools-error" role="alert" title={error}>{error}</span>}
      {game.banner !== undefined && (
        <button className="version-tool" disabled={busy} title="不用自己的图片，换回版本的图" onClick={() => void set(async () => ({}))}>恢复默认</button>
      )}
      <button className="version-tool" disabled={busy} title="选一张本地图片作为这个游戏横幅的背景" onClick={choose}>
        <Icon name="image" />{busy ? '保存中…' : '换背景'}
      </button>
      <input ref={fileRef} type="file" accept={IMAGE_TYPES.join(',')} hidden
        onChange={e => { const file = e.target.files?.[0]; e.target.value = ''; if (file !== undefined) void set(async () => ({ image: (await readImage(file)).image })) }} />
    </div>
  )
}

/** Where the user stands in this game, and what runs it by itself. */
/** 「添加网址」: a page about the game (news, a wiki page, a post) the agent reads now and on 「agent 读」 later. */
function AddLink({ client, game, onAdded }: { client: AdgClient; game: GameInfo; onAdded: () => void }) {
  const [open, setOpen] = useState(false)
  const [url, setUrl] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  if (!open) return <button className="source-add" onClick={() => setOpen(true)} title="添加一个关于这个游戏的网页，agent 会去读它"><Icon name="plus" />添加网址</button>
  const add = async () => {
    const value = url.trim()
    if (value === '') return
    setBusy(true)
    setError(null)
    try {
      await client.connection.call('games/source/add', { game: game.id, url: /^https?:\/\//.test(value) ? value : `https://${value}` })
      setUrl('')
      setOpen(false)
      onAdded()
    } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }
  return (
    <form className="source-form" onSubmit={e => { e.preventDefault(); void add() }}>
      <input className="text-input plain" autoFocus type="text" inputMode="url" placeholder="https://… 官网公告、Wiki 页面、帖子" value={url} disabled={busy}
        onChange={e => setUrl(e.target.value)} onKeyDown={e => { if (e.key === 'Escape') setOpen(false) }} />
      <button className="small-button primary" type="submit" disabled={busy || url.trim() === ''}>{busy ? '添加中…' : '添加并读取'}</button>
      <button className="small-button" type="button" onClick={() => { setOpen(false); setError(null) }}>取消</button>
      {error !== null && <span className="tone-error small">{error}</span>}
    </form>
  )
}

function StatusCard({ game, single, running, soon, now, busy, onRead, onReadWeb, onRemove, openSession }: {
  game: GameInfo
  /** A single-player game: no events to be through, nothing to read in the game. */
  single: boolean
  running: readonly Activity[]
  soon: readonly Activity[]
  now: number
  busy: string | null
  onRead: () => void
  onReadWeb: (source?: string) => void
  onRemove: () => void
  openSession: (id: string) => void
}) {
  const states = running.map(progressOf)
  const finished = states.filter(p => p.state === 'finished').length
  const partial = states.filter(p => p.state === 'partial').length
  const unknown = states.filter(p => p.state === 'unknown').length
  const reading = game.reading
  return (
    <section className="card status-card">
      <h3>{single ? '这个游戏' : '我的状态'}</h3>
      {single && running.length === 0 ? (
        <p className="muted small">单机游戏：这里先放它的官方公告和版本更新，agent 也能读到它们（game_activities）。</p>
      ) : (<>
      <div className="status-figures">
        <div className="status-figure"><strong>{running.length}</strong><span>进行中</span></div>
        <div className={`status-figure ${soon.length > 0 ? 'warn' : ''}`}><strong>{soon.length}</strong><span>快结束未做完</span></div>
      </div>
      {running.length > 0 && (
        <div className="status-bar" role="img" aria-label={`已做完 ${finished} 个，做了一部分 ${partial} 个，没记录 ${unknown} 个`}>
          {finished > 0 && <span className="done" style={{ flexGrow: finished }} />}
          {partial > 0 && <span className="partial" style={{ flexGrow: partial }} />}
          {unknown > 0 && <span className="unknown" style={{ flexGrow: unknown }} />}
        </div>
      )}
      <ul className="status-legend">
        <li><i className="done" />已做完<b>{finished}</b></li>
        <li><i className="partial" />做了一部分<b>{partial}</b></li>
        <li><i className="unknown" />没记录<b>{unknown}</b></li>
      </ul>
      <p className="muted small">进度来自你在活动卡片里勾的，和 agent 进游戏读到的。</p>
      </>)}
      <div className="game-actions">
        {game.followed !== true && !single && <button className="small-button primary" disabled={busy !== null || reading?.state === 'running'} title="agent 会看游戏画面，进活动页读取剩余时间和没做完的事；只看不花东西" onClick={onRead}><Icon name="gamepad" />{reading?.state === 'running' ? 'agent 正在读…' : '让 agent 进游戏读取'}</button>}
        <button className="small-button" disabled={busy !== null || game.webReading?.state === 'running'} title={single ? 'agent 读官方的更新日志、Steam 新闻和公告，记下版本更新和长期公告' : 'agent 读官网公告、Wiki 等插件不能自己读的来源，把活动记进日历'} onClick={() => onReadWeb()}>
          <Icon name="search" />{game.webReading?.state === 'running' ? 'agent 正在查…' : single ? '让 agent 查最新公告' : '让 agent 上网查活动'}
        </button>
        <button className="small-button" disabled={busy !== null}
          title={game.own === true ? '删掉这个游戏和它的活动（你或 agent 加的）' : game.followed === true ? '不再关注，游戏页上不再显示' : '游戏页上不再显示；它的游戏包和脚本包不删'}
          onClick={onRemove}>{game.own === true ? '删除这个游戏' : '不再显示'}</button>
      </div>
      {reading !== undefined && <ReadingLine what="进游戏" reading={reading} now={now} openSession={openSession} />}
      {game.webReading !== undefined && <ReadingLine what="上网查" reading={game.webReading} now={now} openSession={openSession} />}
    </section>
  )
}

/** What the agent did last (in the game, or on the web): when, how it went, its summary, and its conversation. */
function ReadingLine({ what, reading, now, openSession }: { what: string; reading: NonNullable<GameInfo['reading']>; now: number; openSession: (id: string) => void }) {
  // The summary is the agent's last words, markdown and all: plain text here.
  const summary = reading.summary?.replace(/[*_`#>]+/g, '').replace(/\s+/g, ' ').trim()
  return (
    <div className={`reading ${reading.state}`}>
      <div className="reading-head">
        <span className={`badge ${reading.state === 'done' ? 'ok' : reading.state === 'failed' ? 'warn' : ''}`}>{reading.state === 'running' ? `正在${what}` : reading.state === 'done' ? `上次${what}` : `${what}没完成`}</span>
        <span className="muted small">{relativeTime(reading.at, now)}</span>
        <span className="spacer" />
        {reading.sessionId !== undefined && <button className="link-button small reading-open" onClick={() => openSession(reading.sessionId!)}>查看对话<Icon name="chevron" /></button>}
      </div>
      {summary !== undefined && summary !== '' && <p className="reading-summary" title={summary}>{summary}</p>}
    </div>
  )
}

/** Mirror酱 tools that play this game (matched like scripts), each a link to installing it from Mirror酱. */
function MirrorTools({ client, game }: { client: AdgClient; game: GameInfo }) {
  const capabilities = useStore(client.capabilities)
  const [items, setItems] = useState<MirrorSearchItem[] | null>(null)
  useEffect(() => {
    if (!capabilities.has('scripts')) return
    let live = true
    client.connection.call('games/mirrorchyan', { game: game.id }).then(r => { if (live) setItems(r.items) }, () => { if (live) setItems([]) })
    return () => { live = false }
  }, [client, game.id, capabilities.has('scripts')])
  if (items === null || items.length === 0) return null
  return (
    <div className="mirror-tools">
      <div className="muted small">Mirror酱 上有这些玩它的工具：</div>
      <ul>
        {items.slice(0, 5).map(item => (
          <li key={item.rid}>
            <a href={`#/p/scripts/${encodeURIComponent(`mirror:${item.rid}`)}`}>{item.name}</a>
            <span className="chip subtle">{item.rid}</span>
            {item.description !== '' && <span className="muted small">{item.description}</span>}
          </li>
        ))}
      </ul>
    </div>
  )
}

/** The pipelines that play this game's scripts: when they run next, how the last run went. */
function GameSchedule({ client, game, now, openScripts }: { client: AdgClient; game: GameInfo; now: number; openScripts: () => void }) {
  const capabilities = useStore(client.capabilities)
  const status = useStore(client.connection.status)
  const [pipelines, setPipelines] = useState<{ summary: PipelineSummary; pipeline: Pipeline }[] | null>(null)
  const [upcoming, setUpcoming] = useState<{ pipelineId: string; at: number }[]>([])
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hasPipelines = capabilities.has('pipelines')
  useEffect(() => client.connection.on('pipelines/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => client.connection.on('pipelines/run', run => { if (run.state !== 'running') setRevision(r => r + 1) }), [client])
  useEffect(() => {
    if (status.state !== 'open' || !hasPipelines || game.scripts.length === 0) { setPipelines([]); return }
    let live = true
    void (async () => {
      const { items } = await client.connection.call('pipelines/list', {})
      const full = await Promise.all(items.filter(s => !s.draft).map(async summary => ({ summary, pipeline: await client.connection.call('pipelines/get', { id: summary.id }) })))
      const mine = full.filter(({ pipeline }) => pipeline.nodes.some(n => n.kind === 'script-task' && game.scripts.includes(n.scriptId)))
      const schedule = capabilities.has('schedule') ? await client.connection.call('schedule/status', {}).catch(() => undefined) : undefined
      if (live) { setPipelines(mine); setUpcoming(schedule?.upcoming ?? []) }
    })().catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, hasPipelines, game.id, game.scripts.join(','), revision])

  const runNow = async (id: string) => {
    setBusy(id)
    setError(null)
    try { await client.connection.call('pipelines/run', { id }); setRevision(r => r + 1) } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }
  const STATE: Record<string, [string, string]> = { running: ['', '运行中'], succeeded: ['ok', '成功'], failed: ['warn', '有失败'], cancelled: ['', '已取消'] }

  return (
    <div className="game-schedule-runs">
      <h3>自动日程</h3>
      {game.scripts.length === 0 && <p className="muted small">还没有玩它的脚本。在<button className="link-button" onClick={openScripts}>脚本页</button>安装或导入后，名字或仓库里提到这个游戏的脚本会自动对上。</p>}
      {game.scripts.length === 0 && <MirrorTools client={client} game={game} />}
      {game.scripts.length > 0 && (
        <p className="muted small">
          玩它的脚本：{game.scripts.map((s, i) => <span key={s}>{i > 0 ? '、' : ''}<button className="link-button" onClick={openScripts}>{s}</button></span>)}
        </p>
      )}
      {pipelines !== null && game.scripts.length > 0 && pipelines.length === 0 && (
        <p className="muted small">还没有自动跑这个游戏的流水线。在 <a href="#/p/pipelines">编排</a> 里建一条并设上定时，日常就会每天自己跑。</p>
      )}
      {pipelines !== null && pipelines.length > 0 && (
        <ul className="run-list">
          {pipelines.map(({ summary }) => {
            const next = upcoming.filter(u => u.pipelineId === summary.id).map(u => u.at).sort((a, b) => a - b)[0]
            const last = summary.lastRun
            return (
              <li key={summary.id}>
                <a className="run-name" href={`#/p/pipelines/${encodeURIComponent(summary.id)}`}>{summary.name}</a>
                <span className="muted small">
                  {next !== undefined ? `下次 ${new Date(next).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })}` : summary.schedule.enabled ? '定时已开' : '没有定时'}
                </span>
                {last !== undefined && <span className={`badge ${STATE[last.state]?.[0] ?? ''}`} title={new Date(last.startedAt).toLocaleString('zh-CN', { hour12: false })}>{STATE[last.state]?.[1] ?? last.state} · {relativeTime(last.endedAt ?? last.startedAt, now)}</span>}
                <span className="spacer" />
                <button className="small-button" disabled={busy !== null || last?.state === 'running'} onClick={() => void runNow(summary.id)}>{last?.state === 'running' ? '运行中…' : busy === summary.id ? '启动中…' : '运行'}</button>
              </li>
            )
          })}
        </ul>
      )}
      {error !== null && <div className="notice error left small"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}

/** Where an event stands in time: what its countdown counts to, and whether it is ending soon. */
function timing(a: Activity, now: number, soonDays: number) {
  const started = (a.startsAt ?? 0) <= now
  const shopOnly = started && a.endsAt !== undefined && a.endsAt <= now
  const end = shopOnly ? a.shopEndsAt : a.endsAt
  const soon = started && end !== undefined && end - now < soonDays * DAY && progressOf(a).state !== 'finished'
  return { started, shopOnly, end, soon, target: !started ? a.startsAt : end }
}

/** An event's picture, with its state and time left on it: on its card, and at the top of its details. */
export function ActivityMedia({ activity: a, art, now, soonDays }: { activity: Activity; art: string | undefined; now: number; soonDays: number }) {
  const { started, shopOnly, end, soon, target } = timing(a, now, soonDays)
  const span = a.startsAt !== undefined && end !== undefined ? end - a.startsAt : undefined
  const elapsed = span === undefined || span <= 0 || !started ? undefined : Math.min(1, Math.max(0, (now - a.startsAt!) / span))
  const tag = progressOf(a).state === 'finished' ? ['done', '已做完'] : !started ? ['upcoming', '即将开始'] : shopOnly ? ['shop', '商店开放'] : ['live', '进行中']
  const big = target === undefined ? { value: '', unit: '', rest: '' } : split(target - now)
  const shot = a.cover?.startsWith('shot:') === true
  return (
    <span className={`sched-media ${soon ? 'soon' : ''}`}>
      {art !== undefined && <img key={a.cover} className={`sched-art ${shot ? 'shot' : ''}`} src={art} alt="" title={shot ? '没有别的活动图，用的是 agent 读这个活动时的游戏截图' : undefined} />}
      <span className="sched-shade" />
      <span className={`sched-tag ${tag[0]}`}>{tag[1]}</span>
      <span className="sched-count" aria-label={target === undefined ? '时间未知' : `${!started ? '距开始' : '剩余'}${countdown(target, now)}`}>
        {target === undefined ? <b>?</b> : <><b>{big.value}</b><small>{big.unit}</small>{big.rest !== '' && <em>{big.rest}</em>}</>}
        <i>{!started ? '后开始' : shopOnly ? '商店' : '剩余'}</i>
      </span>
      {elapsed !== undefined && <span className="sched-elapsed" style={{ width: `${elapsed * 100}%` }} />}
    </span>
  )
}

/** An event as a card: its picture with its state and time left on it, under that its name, date, kind, and how far along the user is. */
function ScheduleCard({ client, activity: a, game, now, soonDays, onClick, expanded }: {
  client: AdgClient
  activity: Activity
  game: GameInfo
  now: number
  soonDays: number
  onClick: () => void
  expanded: boolean
}) {
  const art = useRemoteImage(client, a.cover)
  const p = progressOf(a)
  const { started, shopOnly, end, soon } = timing(a, now, soonDays)
  const zone = zoneLabel(game.timezone, now)
  const chosenName = a.chosen === undefined ? undefined : a.chosen === OWN_SOURCE ? '我设的' : a.chosen === SCREEN_SOURCE ? '游戏画面' : a.sources?.find(s => s.id === a.chosen)?.name
  return (
    <button className={`sched-card ${art === undefined ? 'no-art' : ''} ${soon ? 'soon' : ''}`} onClick={onClick} aria-expanded={expanded}>
      <ActivityMedia activity={a} art={art} now={now} soonDays={soonDays} />
      <span className="sched-body">
        <span className="sched-name" title={a.name}>{a.name}</span>
        <span className="sched-when">
          {!started && a.startsAt !== undefined
            ? `${stamp(a.startsAt, game.timezone)} 开始 · ${zone}`
            : end !== undefined
              ? `${stamp(end, game.timezone)} ${shopOnly ? '商店关闭' : '结束'} · ${zone}`
              : `结束时间未知${a.screen?.remaining === undefined ? '' : `，游戏里显示「${a.screen.remaining}」`}`}
        </span>
        {a.todo.length > 0 && p.state !== 'finished' && <span className="sched-todo" title={a.todo.join('、')}>还没做：{a.todo.slice(0, 3).join('、')}</span>}
        <span className="sched-foot">
          <span className="sched-kinds">
            {a.kind !== undefined && <span className="sched-kind">{a.kind}</span>}
            {chosenName !== undefined && <span className="sched-kind" title={`你选了用「${chosenName}」的图片和时间`}>用 {chosenName}</span>}
            {a.own !== undefined && <span className="sched-kind" title={a.sources === undefined && a.screen === undefined ? '你自己添加的活动' : '你改过这个活动'}>{a.sources === undefined && a.screen === undefined ? '我添加的' : '我改过'}</span>}
            {a.sources?.some(s => s.web) === true && <span className="sched-kind" title={`来源：${a.sources.map(s => s.name).join('、')}`}>{a.sources.every(s => s.web) ? '网页读到' : '数据站 + 网页'}</span>}
          </span>
          <ProgressPill progress={p} />
        </span>
      </span>
    </button>
  )
}

/** Open the article from anywhere in its summary row. */
function NoticeRow({ client, notice: n, now, onOpen }: { client: AdgClient; notice: GameNotice; now: number; onOpen: () => void }) {
  const art = useRemoteImage(client, n.cover)
  const fresh = n.publishedAt !== undefined && now - n.publishedAt >= 0 && now - n.publishedAt < 3 * DAY
  return (
    <li className={`notice-row ${n.lasting === true ? 'lasting' : ''}`}>
      <button className="notice-open" aria-label={n.title} aria-haspopup="dialog" onClick={onOpen}>
        {art !== undefined && <img className="notice-art" src={art} alt="" loading="lazy" />}
        <span className="notice-body">
          <span className="notice-meta">
            <span className={`notice-kind ${n.kind}`}>{NOTICE_KIND[n.kind]}</span>
            {n.lasting === true && <span className="notice-kind lasting" title="长期有效的公告，一直排在前面">长期</span>}
            {n.version !== undefined && <span className="notice-version">{n.version}</span>}
            {fresh && <span className="badge ok">新</span>}
            <span className="spacer" />
            {n.publishedAt !== undefined && <span className="muted small" title={new Date(n.publishedAt).toLocaleString('zh-CN', { hour12: false })}>{new Date(n.publishedAt).toLocaleDateString('zh-CN')}</span>}
          </span>
          <span className="notice-title">{n.title}</span>
          {n.summary !== undefined && <span className="notice-summary">{n.summary}</span>}
          <span className="muted small notice-source">{n.source.name}</span>
        </span>
      </button>
    </li>
  )
}

/** A banner: its picture, kind, name, who is on rate-up, and how long it stays. */
function PoolCard({ client, pool, game, now }: { client: AdgClient; pool: Pool; game: GameInfo; now: number }) {
  const art = useRemoteImage(client, pool.cover)
  const started = (pool.startsAt ?? 0) <= now
  return (
    <article className="pool-card">
      <div className="pool-art">{art === undefined ? <Icon name="sparkles" /> : <img src={art} alt="" />}</div>
      <div className="pool-main">
        {pool.type !== undefined && <span className="muted small">{pool.type}</span>}
        <strong>{pool.name}</strong>
        {pool.up.length > 0 && <span className="small">UP：{pool.up.join('、')}</span>}
        <span className="small">{started ? '剩余' : '距开始'} <strong className="pool-left">{countdown(started ? pool.endsAt : pool.startsAt!, now)}</strong></span>
        <span className="muted small">{stamp(pool.endsAt, game.timezone)} 结束 ({zoneLabel(game.timezone, now)})</span>
      </div>
    </article>
  )
}

/** Stable colours per game, the same as on the overview. */
export function useGameColors(games: readonly GameInfo[], palette: readonly string[]): Map<string, string> {
  return useMemo(() => new Map(games.map((g, i) => [g.id, palette[i % palette.length]!])), [games, palette])
}
