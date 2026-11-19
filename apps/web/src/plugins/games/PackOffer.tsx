import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { GameInfo, HubItem } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'
import { ActivityDialog } from './ActivityDialog.tsx'

/** Packs the user said no to: not offered again (the 技能 page still has them). */
const DECLINED_KEY = 'adg:pack-offer:declined'
/** Offered this run and closed without an answer: not again until the app is opened again. */
const asked = new Set<string>()
const KIND: Record<string, string> = { game: '游戏包', script: '脚本包', skill: '技能' }

type GameRef = Pick<GameInfo, 'id' | 'name' | 'aliases' | 'sra'>

/** What an offer is for: the game whose page is open, or the games and scripts a conversation works on. */
export interface OfferFor {
  readonly games: readonly GameRef[]
  readonly scripts?: readonly string[]
}

function declined(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(DECLINED_KEY) ?? '[]') as string[]) } catch { return new Set() }
}
function decline(names: readonly string[]): void {
  if (names.length === 0) return
  try { localStorage.setItem(DECLINED_KEY, JSON.stringify([...new Set([...declined(), ...names])])) } catch { /* private window: asked again next time */ }
}

const norm = (value: string) => value.trim().toLowerCase()

/**
 * What the 技能库 has for these games and scripts: the game pack of each game
 * (by its id, the SRA public API's ids it reads, or its name), and the script
 * packs and skills for those games or scripts.
 */
export function packsFor(items: readonly HubItem[], target: OfferFor): HubItem[] {
  const keys = new Set<string>()
  const sras = new Set<string>()
  for (const g of target.games) {
    for (const k of [g.id, g.name, ...g.aliases]) keys.add(norm(k))
    for (const s of g.sra ?? []) sras.add(s)
    // A game followed from the API alone is sra-<its id> (game-intel's followedId).
    if (g.id.startsWith('sra-')) sras.add(g.id.slice(4))
  }
  const gamePacks = items.filter(i => i.pack === 'game' && (
    (i.game !== undefined && keys.has(norm(i.game))) || i.sra?.some(s => sras.has(s)) === true || (i.title !== undefined && keys.has(norm(i.title)))))
  for (const p of gamePacks) if (p.game !== undefined) keys.add(norm(p.game))
  const scripts = new Set((target.scripts ?? []).map(norm))
  return items.filter(i => gamePacks.includes(i) || i.games.some(g => keys.has(norm(g))) || i.scripts.some(s => scripts.has(norm(s))) || (i.pack === 'script' && scripts.has(norm(i.name))))
}

/**
 * Asks once whether to install what the 技能库 has for a game (its game pack,
 * the script packs that play it, its skills) that is not here yet. Nothing is
 * downloaded unless the user says so; what they untick or turn down is not
 * offered again. Renders nothing when there is nothing to offer.
 */
export function PackOffer({ client, target, label, onInstalled }: {
  client: AdgClient
  target: OfferFor
  /** Who it is for, in the title: 「明日方舟」. */
  label: string
  /** Game packs were installed: the games they are for. */
  onInstalled?: (games: string[]) => void
}) {
  const capabilities = useStore(client.capabilities)
  const status = useStore(client.connection.status)
  const [offer, setOffer] = useState<HubItem[]>([])
  const [ticked, setTicked] = useState<ReadonlySet<string>>(new Set())
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const key = JSON.stringify(target)
  const hub = capabilities.has('skillhub') && status.state === 'open'
  useEffect(() => {
    setOffer([])
    if (!hub || target.games.length + (target.scripts?.length ?? 0) === 0) return
    let live = true
    client.connection.call('skillhub/list', {}).then(r => {
      if (!live) return
      const no = declined()
      const items = packsFor(r.items, target).filter(i => i.installed === undefined && i.blocked === undefined && i.incompatible === undefined && !no.has(i.name) && !asked.has(i.name))
      // Game packs first, then script packs, then skills.
      const order = (i: HubItem) => i.pack === 'game' ? 0 : i.pack === 'script' ? 1 : 2
      items.sort((a, b) => order(a) - order(b))
      setOffer(items)
      setTicked(new Set(items.filter(i => i.default === true || i.pack === 'game').map(i => i.name)))
      setError(null)
    }, () => { /* no 技能库 now (offline): nothing to offer */ })
    return () => { live = false }
    // `key` stands for the target.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, hub, key])

  if (offer.length === 0) return null
  const later = () => { for (const i of offer) asked.add(i.name); setOffer([]) }
  const no = () => { decline(offer.map(i => i.name)); later() }
  const install = async () => {
    setError(null)
    const chosen = offer.filter(i => ticked.has(i.name))
    const games: string[] = []
    for (const item of chosen) {
      setBusy(item.name)
      try {
        await client.connection.call('skillhub/install', { name: item.name, repo: item.repo })
      } catch (e) {
        setError(`「${item.title ?? item.name}」没装上：${errorText(e)}`)
        setBusy(null)
        if (games.length > 0) onInstalled?.(games)
        return
      }
      if (item.pack === 'game' && item.game !== undefined) games.push(item.game)
      setOffer(o => o.filter(x => x.name !== item.name))
    }
    // The ones left unticked: not asked again.
    decline(offer.filter(i => !ticked.has(i.name)).map(i => i.name))
    for (const i of offer) asked.add(i.name)
    setBusy(null)
    setOffer([])
    if (games.length > 0) onInstalled?.(games)
  }
  const toggle = (name: string, on: boolean) => setTicked(t => {
    const next = new Set(t)
    if (on) next.add(name)
    else next.delete(name)
    return next
  })
  const count = offer.filter(i => ticked.has(i.name)).length
  return (
    <ActivityDialog color="var(--accent)" label={`安装${label}的包`} onClose={busy === null ? later : () => {}} className="pack-offer-dialog">
      <header className="dialog-head">
        <div className="dialog-title">
          <h3>要安装{label}的包吗？</h3>
          <div className="dialog-meta">技能库里有这些，还没装。装上后游戏页、脚本和 agent 都能用；以后可以在「技能」页删掉。</div>
        </div>
        <button className="dialog-close" aria-label="以后再说" title="以后再说（Esc）" disabled={busy !== null} onClick={later}><Icon name="close" /></button>
      </header>
      <div className="dialog-form pack-offer-body">
        <ul className="pack-offer-list">
          {offer.map(i => (
            <li key={i.name}>
              <label className="pack-offer-item">
                <input type="checkbox" checked={ticked.has(i.name)} disabled={busy !== null} onChange={e => toggle(i.name, e.target.checked)} />
                <span className="pack-offer-text">
                  <span className="pack-offer-name">{i.title ?? i.name}<span className="pack-offer-kind">{KIND[i.pack ?? 'skill']}</span>{busy === i.name && <span className="muted small">正在下载…</span>}</span>
                  <span className="muted small">{i.description}</span>
                </span>
              </label>
            </li>
          ))}
        </ul>
        {error !== null && <div className="notice error left small"><Icon name="alert" /><span>{error}</span></div>}
      </div>
      <footer className="dialog-foot">
        <span className="muted small">不装也能用：活动照常显示。</span>
        <span className="spacer" />
        <button className="small-button" disabled={busy !== null} onClick={no}>不用了</button>
        <button className="small-button primary" disabled={busy !== null || count === 0} onClick={() => void install()}>{busy !== null ? '正在安装…' : `安装 ${count} 个`}</button>
      </footer>
    </ActivityDialog>
  )
}

/** In a conversation: offers the packs of the games and scripts it works on (its skill focus), as the agent turns to them. */
export function SessionPackOffer({ client, sessionId }: { client: AdgClient; sessionId: string }) {
  const capabilities = useStore(client.capabilities)
  const [focus, setFocus] = useState<{ scripts: readonly string[]; games: readonly string[] }>({ scripts: [], games: [] })
  const [games, setGames] = useState<readonly GameInfo[]>([])
  const skills = capabilities.has('skills')
  useEffect(() => {
    setFocus({ scripts: [], games: [] })
    if (!skills) return
    let live = true
    client.connection.call('skills/focus', { sessionId }).then(f => { if (live) setFocus(f) }, () => {})
    const off = client.connection.on('skills/focused', p => { if (p.sessionId === sessionId) setFocus({ scripts: p.scripts, games: p.games }) })
    return () => { live = false; off() }
  }, [client, sessionId, skills])
  const wantsGames = focus.games.length > 0 && capabilities.has('games')
  useEffect(() => {
    if (!wantsGames) return
    let live = true
    client.connection.call('games/list', {}).then(r => { if (live) setGames(r.games) }, () => {})
    return () => { live = false }
  }, [client, wantsGames, focus])
  const target = useMemo<OfferFor>(() => ({
    games: focus.games.map(g => games.find(x => x.id === g || norm(x.name) === norm(g) || x.aliases.some(a => norm(a) === norm(g))) ?? { id: g, name: g, aliases: [] }),
    scripts: focus.scripts,
  }), [focus, games])
  const label = [...target.games.map(g => `「${g.name}」`), ...(target.scripts ?? []).map(s => `「${s}」`)].join('')
  return <PackOffer client={client} target={target} label={label} />
}
