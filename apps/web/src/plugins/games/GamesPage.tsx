import { useCallback, useContext, useEffect, useState, type CSSProperties } from 'react'
import { createPortal } from 'react-dom'
import type { Activity, GameInfo, RequestResult } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { Icon } from '../../components/Icons.tsx'
import { RailItem } from '../../components/NavRail.tsx'
import { RailSlot } from '../../components/railSlot.ts'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'
import { ActivityEditor } from './ActivityEditor.tsx'
import { ActivityDialog, ActivityDialogBody } from './ActivityDialog.tsx'
import { GameAvatar } from './GameAvatar.tsx'
import { GameView, useGameColors } from './GameView.tsx'
import { CatalogPicker, Overview, PALETTE, progressOf } from './Overview.tsx'
import { PackOffer } from './PackOffer.tsx'
import { confirm } from '../../components/Dialog.tsx'
import './games.css'

type Listing = RequestResult<'games/list'>
/** What the window on a game's page shows: an event (as last saved, until the list has it), or a form for a new one. */
type Dialog = { kind: 'activity'; id: string; saved?: Activity } | { kind: 'add'; game: string }

const DAY = 86_400_000

/**
 * The game board. Tabs across the top: 全部活动 (every game's events on one
 * timeline), one tab per game (its version, banners and events from the data
 * sites, beside the user's progress and the pipelines that play it), and more
 * games to follow. The daily report is the 游戏 agent's 日报 tab (ReportPage.tsx).
 */
export function GamesPage({ client, openSession, openPage, arg }: PageProps) {
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [data, setData] = useState<Listing | null>(null)
  const [revision, setRevision] = useState(0)
  const [selected, setSelected] = useState<string>(arg ?? '')
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [catalogOpen, setCatalogOpen] = useState(false)
  const [dialog, setDialog] = useState<Dialog | null>(null)
  const closeDialog = useCallback(() => setDialog(null), [])
  const closeCatalog = useCallback(() => setCatalogOpen(false), [])

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
  const current = games.find(g => g.id === selected)
  // Nothing (or a game that is gone) selected: everything at a glance.
  const showOverview = current === undefined
  const select = (id: string) => { setSelected(id); setDialog(null); setMessage(null); setError(null) }

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
    return game === undefined ? `刷新完成：${results.filter(r => readable(r.game)).map(r => `${name(r.game)} ${[...(r.count > 0 || r.notices === undefined ? [`${r.count} 个活动`] : []), ...(r.notices === undefined ? [] : [`${r.notices} 条公告`])].join('、')}`).join('；')}` : undefined
  })

  /** A game on the page by its name, known or not (one nothing knows yet is made empty); then its page. */
  const create = (name: string) => act('create', async () => {
    const { game } = await client.connection.call('games/create', { name })
    setSelected(game)
  })
  /** Game packs came from the 技能库 (the page offered them): their games are shown, and one added by name for it with nothing yet goes. */
  const installed = (packGames: string[]) => {
    const was = current
    void act('installed', async () => {
      let shown: string | undefined
      for (const g of packGames) shown ??= (await client.connection.call('games/create', { name: g })).game
      if (shown === undefined) return
      if (was !== undefined && was.own === true && was.sources.length === 0 && was.id !== shown) await client.connection.call('games/remove', { game: was.id })
      setSelected(shown)
    })
  }
  const remove = async (game: GameInfo) => {
    if (game.own === true && !await confirm({
      title: `删除${game.name}？`,
      message: `会删掉${game.name}和它的活动记录（你自己记的也一起删）。脚本、脚本包和技能不受影响；以后可以在「更多游戏」里按名字再加回来。`,
      confirmLabel: '删除',
      danger: true,
    })) return
    await act(`remove:${game.id}`, async () => {
      await client.connection.call('games/remove', { game: game.id })
      setSelected('')
      return game.own === true ? `已删除${game.name}` : `${game.name}不再显示：在「更多游戏」里勾上或按名字添加就回来`
    })
  }

  const counts = (g: GameInfo) => {
    const mine = (data?.activities ?? []).filter(a => a.game === g.id && (a.startsAt ?? 0) <= now && Math.max(a.endsAt ?? Infinity, a.shopEndsAt ?? 0) > now)
    const soon = mine.filter(a => progressOf(a).state !== 'finished' && a.endsAt !== undefined && a.endsAt > now && a.endsAt - now < (data?.settings.report.soonDays ?? 3) * DAY).length
    const title = `${mine.length} 个进行中${g.refreshed === undefined ? '' : ` · ${relativeTime(g.refreshed.at, now)}刷新`}${g.followed === true ? ' · 关注的游戏' : ''}`
    return { mine, soon, title }
  }
  // With the app's rail there, the list of games is in it, under 游戏 and 助手 (NavRail.tsx).
  const slot = useContext(RailSlot)
  const railList = slot === null ? null : (
    <div className="rail-games" role="tablist" aria-label="游戏">
      <button role="tab" aria-selected={showOverview} className={`rail-item rail-game rail-overview ${showOverview ? 'active' : ''}`}
        title="全部活动：所有游戏的活动排在一条时间线上" onClick={() => select('')}>
        <span className="rail-avatar overview-avatar"><Icon name="timeline" /></span>
        <span className="rail-label">全部活动</span>
      </button>
      {games.map(g => {
        const { soon, title } = counts(g)
        return (
          <button key={g.id} role="tab" aria-selected={current?.id === g.id} className={`rail-item rail-game ${current?.id === g.id ? 'active' : ''}`}
            style={{ '--game': colors.get(g.id) } as CSSProperties} title={`${g.name}：${title}`} onClick={() => select(g.id)}>
            <GameAvatar client={client} game={g} />
            <span className="rail-label">{g.name}</span>
            {soon > 0 && <span className="rail-badge" title={`${soon} 个快结束还没做完`}>{soon}</span>}
          </button>
        )
      })}
      <RailItem icon="plus" label="更多游戏" title="选择游戏页上显示哪些游戏，或按名字添加" active={catalogOpen} onClick={() => setCatalogOpen(true)} />
    </div>
  )
  const heading = current?.name ?? '全部活动'

  const tab = (g: GameInfo) => {
    const { mine, soon } = counts(g)
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
      {/* The tabs say where you are, so they are the header: no second row repeating the same name. */}
      {slot !== null && railList !== null && createPortal(railList, slot)}
      <header className="page-header games-header">
        <div className="breadcrumb"><h1>{slot === null ? '游戏' : heading}</h1></div>
        {slot === null ? <nav className="game-tabs" role="tablist" aria-label="游戏">
          <button role="tab" aria-selected={showOverview} className={`game-tab ${showOverview ? 'active' : ''}`} onClick={() => select('')}><Icon name="timeline" />全部活动</button>
          <span className="game-tabs-divider" />
          {games.map(tab)}
          <button className={`game-tab add ${catalogOpen ? 'active' : ''}`} aria-haspopup="dialog" title="选择游戏页上显示哪些游戏，或按名字添加" onClick={() => setCatalogOpen(true)}><Icon name="plus" />更多游戏</button>
        </nav> : <span className="spacer" />}
        <div className="page-actions">
          <button className="small-button" disabled={busy !== null || games.length === 0} onClick={() => void refresh()}><Icon name="refresh" />{busy === 'refresh:' ? '刷新中…' : '刷新全部'}</button>
        </div>
      </header>
      <div className="games-body">
        {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
        {message !== null && <div className="notice info left small"><Icon name="info" /><span>{message}</span></div>}
        {data !== null && games.length === 0 && <div className="empty"><Icon name="gamepad" /><p>没有游戏。点「更多游戏」勾选几个，或按名字添加。</p></div>}
        {data !== null && showOverview && games.length > 0 && (
          <Overview client={client} games={games} activities={data.activities} now={now} soonDays={data.settings.report.soonDays}
            onOpenGame={select} onChanged={() => setRevision(r => r + 1)} />
        )}
        {data !== null && current !== undefined && (
          <GameView
            key={current.id} client={client} game={current} activities={data.activities.filter(a => a.game === current.id)}
            notices={(data.notices ?? []).filter(n => n.game === current.id)}
            color={colors.get(current.id) ?? PALETTE[0]!} now={now} soonDays={data.settings.report.soonDays} busy={busy}
            open={dialog?.kind === 'activity' ? dialog.id : null} adding={dialog?.kind === 'add'}
            onOpen={id => setDialog({ kind: 'activity', id })} onAdd={() => setDialog({ kind: 'add', game: current.id })}
            onRefresh={() => void refresh(current.id)}
            onRead={() => void act(`read:${current.id}`, async () => {
              const { sessionId } = await client.connection.call('games/read', { game: current.id })
              openSession(sessionId)
            })}
            onReadWeb={source => void act(`read-web:${current.id}`, async () => {
              const { sessionId } = await client.connection.call('games/read', { game: current.id, how: 'web', ...(source === undefined ? {} : { source }) })
              openSession(sessionId)
            })}
            onDiscover={() => void act(`discover:${current.id}`, async () => {
              // The agent works from here: the page shows it looking, and its conversation is a click away.
              await client.connection.call('games/discover', { game: current.id })
              return `agent 正在找${current.name}的活动来源，找到后这个页面会更新`
            })}
            onRemove={() => void remove(current)}
            onChanged={() => setRevision(r => r + 1)}
            openSession={openSession} openScripts={() => openPage('scripts')}
          />
        )}
      </div>
      {/* 更多游戏: a window over the board, not a card pushed in at its top. */}
      {catalogOpen && (
        <ActivityDialog color="var(--accent)" label="更多游戏" onClose={closeCatalog} className="catalog-dialog">
          <header className="dialog-head">
            <div className="dialog-title">
              <h3>更多游戏</h3>
              <div className="dialog-meta">勾上就显示在游戏页上，马上生效；列表里没有的，按名字添加</div>
            </div>
            <button className="dialog-close" aria-label="关闭" title="关闭（Esc）" onClick={closeCatalog}><Icon name="close" /></button>
          </header>
          <div className="dialog-form catalog-dialog-body">
            <CatalogPicker client={client} onChanged={() => setRevision(r => r + 1)} onCreate={name => { closeCatalog(); void create(name) }} />
          </div>
        </ActivityDialog>
      )}
      {/* Opening a game asks once about the 技能库's packs for it (none is downloaded by choosing games). */}
      {current !== undefined && !catalogOpen && (
        <PackOffer client={client} target={{ games: [{ id: current.id, name: current.name, aliases: current.aliases, ...(current.sra === undefined ? {} : { sra: current.sra }) }] }}
          label={`「${current.name}」`} onInstalled={installed} />
      )}
      {data !== null && dialog !== null && (() => {
        const changed = () => setRevision(r => r + 1)
        if (dialog.kind === 'add') {
          const game = games.find(g => g.id === dialog.game)
          if (game === undefined) return null
          return (
            <ActivityDialog color={colors.get(game.id) ?? PALETTE[0]!} label="添加活动" onClose={closeDialog}>
              <div className="dialog-form">
                <ActivityEditor client={client} game={game} onCancel={closeDialog} onDone={saved => { setDialog({ kind: 'activity', id: saved.id, saved }); changed() }} />
              </div>
            </ActivityDialog>
          )
        }
        const activity = data.activities.find(a => a.id === dialog.id) ?? dialog.saved
        if (activity === undefined) return null
        return (
          <ActivityDialog color={colors.get(activity.game) ?? PALETTE[0]!} label={`${activity.name}的详情`} onClose={closeDialog}>
            <ActivityDialogBody key={activity.id} client={client} activity={activity} game={games.find(g => g.id === activity.game)} now={now} soonDays={data.settings.report.soonDays}
              onClose={closeDialog} onChanged={changed} openSession={openSession} />
          </ActivityDialog>
        )
      })()}
    </section>
  )
}

