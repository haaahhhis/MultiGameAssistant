import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { Activity, GameInfo, Pipeline, PipelineSummary } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'
import { useRemoteImage } from './images.ts'
import { ActivityDetail, ProgressPill, progressOf } from './Overview.tsx'

const DAY = 86_400_000
const HOUR = 3_600_000
const MINUTE = 60_000
type Pool = NonNullable<GameInfo['pools']>[number]

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
function zoneLabel(timeZone: string, at: number): string {
  const name = new Intl.DateTimeFormat('en-US', { timeZone, timeZoneName: 'shortOffset' }).formatToParts(new Date(at)).find(x => x.type === 'timeZoneName')?.value ?? ''
  return name.replace('GMT', 'UTC') || timeZone
}

/**
 * One game: what is in it now (the version's art, banners, every event as a
 * card with its picture) side by side with where the user stands (progress
 * on each event, what is ending undone, the agent's last look in the game,
 * and the pipelines that play it on a timetable).
 */
export function GameView({ client, game, activities, color, now, soonDays, busy, onRefresh, onRead, onUnfollow, onChanged, openSession, openScripts }: {
  client: AdgClient
  game: GameInfo
  activities: readonly Activity[]
  color: string
  now: number
  soonDays: number
  busy: string | null
  onRefresh: () => void
  onRead: () => void
  onUnfollow: () => void
  onChanged: () => void
  openSession: (id: string) => void
  openScripts: () => void
}) {
  const [open, setOpen] = useState<string | null>(null)
  const [showFinished, setShowFinished] = useState(false)
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
    <div key={a.id} className={`schedule-item ${open === a.id ? 'open' : ''}`}>
      <ScheduleCard client={client} activity={a} game={game} now={now} soonDays={soonDays} onClick={() => setOpen(o => (o === a.id ? null : a.id))} expanded={open === a.id} />
      {open === a.id && <ActivityDetail client={client} activity={a} game={game} onChanged={onChanged} openSession={openSession} />}
    </div>
  )

  return (
    <div className="game-view" style={{ '--game': color } as CSSProperties}>
      <div className="game-main">
        <VersionHero client={client} game={game} now={now} />
        <StatusCard client={client} game={game} running={running} soon={soon} now={now} busy={busy} onRead={onRead} onUnfollow={onUnfollow} openSession={openSession} openScripts={openScripts} />
        {(game.pools?.length ?? 0) > 0 && (
          <section className="card pools-card">
            <h3>卡池</h3>
            <div className="pool-list">{game.pools!.map(p => <PoolCard key={`${p.name}-${p.endsAt}`} client={client} pool={p} game={game} now={now} />)}</div>
          </section>
        )}
        <div className="game-sources">
          {game.sources.map(s => (
            <span key={s.id} className="source-chip" title={s.auto ? '自动读取（不用模型）' : '由 agent 用网页工具读取'}>
              <span className={`source-dot ${s.auto ? 'auto' : ''}`} />
              {s.homepage === undefined ? s.name : <a href={s.homepage} target="_blank" rel="noreferrer">{s.name}</a>}
            </span>
          ))}
          {game.refreshed !== undefined && <span className="muted small">{relativeTime(game.refreshed.at, now)}刷新</span>}
          {game.refreshed !== undefined && !game.refreshed.ok && <span className="tone-error small">上次没读到：{game.refreshed.detail}</span>}
        </div>
      </div>

      <aside className="card game-schedule" aria-label="活动日程">
        <div className="schedule-head">
          <h3>活动日程</h3>
          <span className="spacer" />
          <span className="muted small">{game.sources.find(s => s.auto)?.name ?? '数据站'}</span>
          <button className="icon-button" title={auto ? '刷新数据站（不用模型）' : '这个游戏没有能自动读的数据站'} disabled={busy !== null || !auto} onClick={onRefresh}>
            <Icon name="refresh" />
          </button>
        </div>
        <div className="schedule-list">
          {live.length === 0 && <p className="muted small schedule-empty">{auto ? '还没有活动。点右上角刷新。' : '这个游戏没有能自动读的数据站，让 agent 进游戏读一次。'}</p>}
          {groups.filter(g => g.rows.length > 0).map(g => (
            <section key={g.key} className={`schedule-group ${g.tone ?? ''}`}>
              <div className="schedule-group-title"><span>{g.title}</span><span className="count">{g.rows.length}</span><span className="muted small">{g.hint}</span></div>
              {g.rows.map(card)}
            </section>
          ))}
          {finishedOnes.length > 0 && (
            <section className="schedule-group done">
              <button className="schedule-group-title toggle" aria-expanded={showFinished} onClick={() => setShowFinished(s => !s)}>
                <span>已做完</span><span className="count">{finishedOnes.length}</span><span className="muted small">{showFinished ? '收起' : '展开'}</span>
                <Icon name="chevron-down" className={`chevron-icon ${showFinished ? 'open' : ''}`} />
              </button>
              {showFinished && finishedOnes.map(card)}
            </section>
          )}
        </div>
      </aside>
    </div>
  )
}

/**
 * The version: its key art with the name set in serif at the foot of the
 * picture, and under it a strip with the version's span as a track — how far
 * through it is, and the time left at its end.
 */
function VersionHero({ client, game, now }: { client: AdgClient; game: GameInfo; now: number }) {
  const v = game.version
  const art = useRemoteImage(client, v?.cover)
  const span = v?.startsAt !== undefined && v.endsAt !== undefined ? v.endsAt - v.startsAt : undefined
  const through = span === undefined || span <= 0 ? undefined : Math.min(1, Math.max(0, (now - v!.startsAt!) / span))
  const day = (at: number) => new Date(at).toLocaleDateString('zh-CN', { timeZone: game.timezone, month: 'numeric', day: 'numeric' })
  return (
    <section className="version-card">
      <div className={`version-hero ${art === undefined ? 'no-art' : ''}`}>
        {art !== undefined && <img className="version-art" src={art} alt="" />}
        <div className="version-shade" />
        <div className="version-caption">
          <span className="version-kicker">{game.name}{v === undefined ? '' : <> · <b>{v.name}</b> 版本</>}</span>
          <h2>{v?.title ?? game.name}</h2>
        </div>
      </div>
      <div className="version-strip">
        {v === undefined && <span className="muted small">{game.sources.some(s => s.auto) ? '还没有版本信息：点「活动日程」右上角刷新' : '这个游戏的数据站不提供版本信息'}</span>}
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

/** Where the user stands in this game, and what runs it by itself. */
function StatusCard({ client, game, running, soon, now, busy, onRead, onUnfollow, openSession, openScripts }: {
  client: AdgClient
  game: GameInfo
  running: readonly Activity[]
  soon: readonly Activity[]
  now: number
  busy: string | null
  onRead: () => void
  onUnfollow: () => void
  openSession: (id: string) => void
  openScripts: () => void
}) {
  const states = running.map(progressOf)
  const finished = states.filter(p => p.state === 'finished').length
  const partial = states.filter(p => p.state === 'partial').length
  const unknown = states.filter(p => p.state === 'unknown').length
  const reading = game.reading
  return (
    <section className="card status-card">
      <div className="card-head">
        <div><h3>我的状态</h3><p className="muted small">进度来自你在活动卡片里勾的，和 agent 进游戏读到的。</p></div>
        <div className="game-actions">
          {game.followed === true
            ? <button className="small-button" disabled={busy !== null} title="不再显示这个游戏" onClick={onUnfollow}>取消关注</button>
            : <button className="small-button primary" disabled={busy !== null || reading?.state === 'running'} title="agent 会看游戏画面，进活动页读取剩余时间和没做完的事；只看不花东西" onClick={onRead}><Icon name="gamepad" />{reading?.state === 'running' ? 'agent 正在读…' : '让 agent 进游戏读取'}</button>}
        </div>
      </div>
      <div className="status-stats">
        <div className="stat"><strong>{running.length}</strong><span>进行中</span></div>
        <div className={`stat ${soon.length > 0 ? 'warn' : ''}`}><strong>{soon.length}</strong><span>快结束未做完</span></div>
        <div className="stat ok"><strong>{finished}</strong><span>已做完</span></div>
        <div className="stat"><strong>{partial}</strong><span>做了一部分</span></div>
        <div className="stat muted"><strong>{unknown}</strong><span>没记录</span></div>
      </div>
      {soon.length > 0 && (
        <ul className="soon-list">
          {soon.slice(0, 4).map(a => <li key={a.id}><span className="tone-warn">{countdown(a.endsAt!, now)}</span><span>{a.name}</span>{a.todo.length > 0 && <span className="muted small">还没做：{a.todo.slice(0, 3).join('、')}</span>}</li>)}
        </ul>
      )}
      {reading !== undefined && (
        <div className={`reading ${reading.state}`}>
          <span className={`badge ${reading.state === 'done' ? 'ok' : reading.state === 'failed' ? 'warn' : ''}`}>{reading.state === 'running' ? '读取中' : reading.state === 'done' ? '上次进游戏' : '没读完'}</span>
          <span className="reading-text">{relativeTime(reading.at, now)}{reading.summary === undefined ? '' : `：${reading.summary}`}</span>
          {reading.sessionId !== undefined && <button className="link-button" onClick={() => openSession(reading.sessionId!)}>查看对话</button>}
        </div>
      )}
      <GameSchedule client={client} game={game} now={now} openScripts={openScripts} />
    </section>
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
      <div className="field-title">日程</div>
      {game.scripts.length === 0 && <p className="muted small">这个游戏没有脚本，只看活动。</p>}
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

/** An event as a card on its picture: state, kind, name, time left, and how far along the user is. */
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
  const started = (a.startsAt ?? 0) <= now
  const shopOnly = started && a.endsAt !== undefined && a.endsAt <= now
  const end = shopOnly ? a.shopEndsAt : a.endsAt
  const soon = started && end !== undefined && end - now < soonDays * DAY && p.state !== 'finished'
  const span = a.startsAt !== undefined && end !== undefined ? end - a.startsAt : undefined
  const elapsed = span === undefined || span <= 0 || !started ? undefined : Math.min(1, Math.max(0, (now - a.startsAt!) / span))
  const tag = p.state === 'finished' ? ['done', '已做完'] : !started ? ['upcoming', '即将开始'] : shopOnly ? ['shop', '商店开放'] : ['live', '进行中']
  const zone = zoneLabel(game.timezone, now)
  const target = !started ? a.startsAt : end
  const big = target === undefined ? { value: '', unit: '', rest: '' } : split(target - now)
  return (
    <button className={`sched-card ${art === undefined ? 'no-art' : ''} ${soon ? 'soon' : ''}`} onClick={onClick} aria-expanded={expanded}>
      {art !== undefined && <img className="sched-art" src={art} alt="" />}
      <span className="sched-shade" />
      <span className="sched-count" aria-label={target === undefined ? '时间未知' : `${!started ? '距开始' : '剩余'}${countdown(target, now)}`}>
        {target === undefined ? <b>?</b> : <><b>{big.value}</b><small>{big.unit}</small>{big.rest !== '' && <em>{big.rest}</em>}</>}
        <i>{!started ? '后开始' : shopOnly ? '商店' : '剩余'}</i>
      </span>
      <span className="sched-body">
        <span className="sched-top">
          <span className={`sched-tag ${tag[0]}`}>{tag[1]}</span>
          {a.kind !== undefined && <span className="sched-kind">{a.kind}</span>}
          <span className="spacer" />
          <ProgressPill progress={p} />
        </span>
        <span className="sched-name">{a.name}</span>
        <span className="sched-when">
          {!started && a.startsAt !== undefined
            ? `${stamp(a.startsAt, game.timezone)} 开始 · ${zone}`
            : end !== undefined
              ? `${stamp(end, game.timezone)} ${shopOnly ? '商店关闭' : '结束'} · ${zone}`
              : `结束时间未知${a.screen?.remaining === undefined ? '' : `，游戏里显示「${a.screen.remaining}」`}`}
        </span>
      </span>
      {elapsed !== undefined && <span className="sched-elapsed" style={{ width: `${elapsed * 100}%` }} />}
    </button>
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
