import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MAX_SKILL_NAME, SKILL_NAME, type HubItem, type RequestResult, type ScriptInfo, type SkillInfo, type SkillOwner } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { confirm } from '../../components/Dialog.tsx'
import { Icon, type IconName } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { desktop } from '../../desktop.ts'
import { useNow, useStore } from '../../hooks.ts'
import { errorText, useScriptList } from '../scripts/data.ts'
import { findGame, placeLabel, placesOf, type GameRef } from '../../skillPlaces.ts'
import { SkillHubPanel } from './SkillHubPanel.tsx'
import './skills.css'

type Hub = RequestResult<'skillhub/list'>

/**
 * What 已有的技能 is split into. Script packs and game packs come from the 技能库
 * (the user may delete any); skills are ways of doing things, downloaded or the
 * user's own (agent-saved or written here), each under its game; the core ones
 * keep the app working and cannot be changed.
 */
type Category = 'script-pack' | 'game-pack' | 'skill' | 'core'
const CATEGORIES: readonly { id: Category; label: string; icon: IconName; hint: string }[] = [
  { id: 'script-pack', label: '脚本包', icon: 'package', hint: '脚本怎么装、有哪些任务、运行前改哪些设置；按游戏分开，用不上的可以删' },
  { id: 'game-pack', label: '游戏包', icon: 'gamepad', hint: '游戏页从哪里读活动、游戏里怎么看；不玩的可以删' },
  { id: 'skill', label: '技能', icon: 'sparkles', hint: '按游戏分开：带底色的是从技能库下载的，白底的是你或 agent 写的；只在处理对应的游戏和脚本时用' },
  { id: 'core', label: '核心技能', icon: 'shield', hint: '软件自带、维持基本功能的技能：受保护，不能改，随软件更新' },
]
const LABEL: Readonly<Record<Category, string>> = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label])) as Record<Category, string>
/** Sections whose rows are split by game. */
const BY_GAME: ReadonlySet<Category> = new Set(['script-pack', 'skill'])

/** One skill the agents have. */
interface Entry {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly category: Category
  readonly skill?: SkillInfo
  /** Downloaded from the 技能库. */
  readonly hub?: HubItem
  readonly owner?: SkillOwner
}

/** Made here: saved by the agent or written on this page, or a script pack the agent wrote. */
const mineOf = (e: Entry) => e.skill?.removable === true || e.skill?.ownPack === true

function categoryOf(skill: SkillInfo, hub: HubItem | undefined): Category {
  if (skill.kind === 'script-pack' || hub?.pack === 'script') return 'script-pack'
  if (skill.kind === 'game-pack' || hub?.pack === 'game') return 'game-pack'
  if (skill.source === 'bundled' && skill.removable !== true) return 'core'
  return 'skill'
}

/** Sections folded away in the list, kept for the next visit. */
const FOLDED_KEY = 'adg:skills:folded-kinds'
function readFolded(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[]) } catch { return new Set() }
}
function writeFolded(folded: ReadonlySet<string>): void {
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded])) } catch { /* private window: unfolded next time */ }
}
/** The list's game filter: every game, one game, or the general skills. */
const ALL = ''
const GENERAL = ':general'

/** A skill being made (`original` undefined) or changed; `hub`: a downloaded one (its name and owner stay). */
interface Draft { original?: string; hub?: boolean; name: string; description: string; content: string; scripts: string[]; games: string[] }

/**
 * 技能, in two tabs. 已有的技能: the script packs, game packs and skills the
 * agents have, by kind and then by game; anything downloaded can be updated,
 * gone back, changed or deleted, the user's own made, changed and deleted, the
 * core ones only read (技能隔离: a skill for a game or script is used only
 * while working on it). 技能库: what the repositories have, by game, script and
 * author, to download (SkillHubPanel.tsx).
 */
export function SkillsPage({ client, arg }: PageProps) {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const now = useNow(60_000)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [hub, setHub] = useState<Hub | null>(null)
  const [query, setQuery] = useState('')
  const [game, setGame] = useState(ALL)
  // #/p/skills/<name>, #/p/skills/hub (the 技能库) or hub:<name> (one in it, from a script's page).
  const [tab, setTab] = useState<'mine' | 'hub'>(arg?.startsWith('hub') === true ? 'hub' : 'mine')
  const [focus, setFocus] = useState<string | undefined>(arg?.startsWith('hub:') === true ? arg.slice(4) : undefined)
  const [selected, setSelected] = useState<string>(arg === undefined || arg.startsWith('hub') ? '' : arg)
  const [content, setContent] = useState<{ name: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [hubRevision, setHubRevision] = useState(0)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [moving, setMoving] = useState(false)
  const [folded, setFolded] = useState(readFolded)
  const fold = (key: string) => setFolded(f => {
    const next = new Set(f)
    if (!next.delete(key)) next.add(key)
    writeFolded(next)
    return next
  })
  const scripts = useScriptList(client).data?.scripts ?? []
  const [games, setGames] = useState<readonly GameRef[]>([])
  const hasHub = capabilities.has('skillhub')

  useEffect(() => {
    if (arg === undefined) return
    if (arg.startsWith('hub')) { setTab('hub'); setFocus(arg.startsWith('hub:') ? arg.slice(4) : undefined) } else { setTab('mine'); setSelected(arg) }
    setDraft(null)
  }, [arg])
  useEffect(() => client.connection.on('skills/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => client.connection.on('skillhub/changed', () => setHubRevision(r => r + 1)), [client])
  // The games, for the filter and to say what each skill is for.
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('games')) return
    let live = true
    client.connection.call('games/list', {}).then(r => { if (live) setGames(r.games) }, () => {})
    return () => { live = false }
  }, [client, status.state, capabilities, hubRevision])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('skills/list', {}).then(r => { if (live) setSkills(r.skills) }, e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, revision])
  const loadHub = async (refresh = false) => {
    const r = await client.connection.call('skillhub/list', refresh ? { refresh: true } : {})
    setHub(r)
    return r
  }
  useEffect(() => {
    if (status.state !== 'open' || !hasHub) return
    let live = true
    client.connection.call('skillhub/list', {}).then(r => { if (live) setHub(r) }, e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, hasHub, hubRevision])

  const entries = useMemo(() => {
    const items = hub?.items ?? []
    return (skills ?? []).map((skill): Entry => {
      const item = skill.source === 'hub' ? items.find(i => i.name === skill.name && i.installed !== undefined) : undefined
      return {
        name: skill.name, title: item?.title ?? skill.name, description: skill.description, category: categoryOf(skill, item), skill,
        ...(item === undefined ? {} : { hub: item }), ...(skill.owner === undefined ? {} : { owner: skill.owner }),
      }
    })
  }, [skills, hub])

  const placesOfEntry = (e: Entry) => placesOf(e.owner, scripts, games)
  /** Where it belongs, in words: 明日方舟 · MAA; empty for a general one. */
  const where = (e: Entry) => [...new Set(placesOfEntry(e).map(placeLabel))].join('、')
  /** The game it is filed under: the game of its script or its own; else the 技能库's word for it; none: general. */
  const gameOfEntry = (e: Entry): { id: string; name: string } | undefined => {
    const placed = placesOfEntry(e).find(p => p.game !== undefined)?.game
    if (placed !== undefined) return placed
    const id = e.hub?.game ?? e.hub?.games[0] ?? e.owner?.games?.[0]
    if (id === undefined) return undefined
    const known = findGame(id, games)
    return known !== undefined ? { id: known.id, name: known.name } : { id, name: (hub?.items ?? []).find(i => i.pack === 'game' && i.game === id)?.title ?? id }
  }
  /** A section's rows by game: the games on the game page first, general last. */
  const byGame = (rows: readonly Entry[]) => {
    const groups = new Map<string, { id: string; name: string; items: Entry[] }>()
    for (const e of rows) {
      const g = gameOfEntry(e) ?? { id: GENERAL, name: '通用' }
      const group = groups.get(g.id) ?? { ...g, items: [] }
      group.items.push(e)
      groups.set(g.id, group)
    }
    const rank = (id: string) => { const at = games.findIndex(g => g.id === id); return at < 0 ? games.length : at }
    return [...groups.values()].sort((a, b) => Number(a.id === GENERAL) - Number(b.id === GENERAL) || rank(a.id) - rank(b.id) || a.name.localeCompare(b.name))
  }
  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => entries.filter(e => {
    if (needle !== '' && !`${e.name} ${e.title} ${e.description} ${e.skill?.whenToUse ?? ''}`.toLowerCase().includes(needle)) return false
    if (game === ALL) return true
    const places = placesOfEntry(e)
    if (game === GENERAL) return places.length === 0
    return places.some(p => p.game?.id === game) || e.hub?.game === game
  }), [entries, needle, game, scripts, games])
  const sections = useMemo(() => CATEGORIES.map(c => ({
    ...c,
    items: shown.filter(e => e.category === c.id).sort((a, b) => a.title.localeCompare(b.title)),
  })).filter(s => s.items.length > 0 || (s.id === 'skill' && needle === '' && game === ALL)), [shown, needle, game])
  // The rows as they are listed (by game inside some sections), for the first one to show.
  const grouped = sections.map(s => ({ ...s, groups: BY_GAME.has(s.id) ? byGame(s.items) : undefined }))
  const ordered = grouped.flatMap(s => s.groups?.flatMap(g => g.items) ?? s.items)
  const current = shown.find(e => e.name === selected) ?? ordered[0]

  // Its instructions, as the agents have them.
  useEffect(() => {
    setMoving(false)
    setCopied(false)
    if (current === undefined) { setContent(null); return }
    let live = true
    const name = current.name
    client.connection.call('skills/get', { name }).then(r => r.content).then(text => { if (live) setContent({ name, text }) }, e => { if (live) { setContent({ name, text: '' }); setError(errorText(e)) } })
    return () => { live = false }
  }, [client, current?.name, revision, hubRevision])

  const act = async (key: string, fn: () => Promise<string | void>) => {
    setBusy(key)
    setError(null)
    setMessage(null)
    try {
      const said = await fn()
      if (typeof said === 'string') setMessage(said)
      setRevision(r => r + 1)
      setHubRevision(r => r + 1)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const choose = (name: string) => { setDraft(null); setMessage(null); setError(null); setSelected(name) }
  const switchTab = (next: 'mine' | 'hub') => { setTab(next); setDraft(null); setMessage(null); setError(null) }

  const remove = (e: Entry) => act(`remove:${e.name}`, async () => {
    const what = e.skill?.ownPack === true
      ? { title: `删除脚本包「${e.title}」？`, message: '这是 agent 为脚本写的脚本包：它的安装方式、任务和做法都会删掉，不能恢复（需要时让 agent 重新分析这个脚本）。用它的脚本保留，只是没有这些任务了。' }
      : e.category === 'script-pack'
      ? { title: `删除脚本包「${e.title}」？`, message: '脚本页不再有它的安装方式和任务说明，agent 也不再用它的做法；已经装好的脚本不会删。以后可以在「技能库」里再下载。' }
      : e.category === 'game-pack'
        ? { title: `删除游戏包「${e.title}」？`, message: '游戏页不再按它读这个游戏的活动（SRA 公共 API 有这个游戏的话，可以在「游戏 → 更多游戏」里勾上）。以后可以在「技能库」里再下载。' }
        : e.hub !== undefined
          ? { title: `删除技能「${e.title}」？`, message: '它的文件夹会一起删掉，agent 以后就用不到它了。以后可以在「技能库」里再下载。' }
          : { title: `删除技能「${e.name}」？`, message: '它的文件夹会一起删掉，agent 以后就用不到它了。' }
    if (!await confirm({ ...what, confirmLabel: '删除', danger: true })) return
    if (e.hub !== undefined) await client.connection.call('skillhub/remove', { name: e.name })
    else if (e.skill?.ownPack === true && e.skill.pack !== undefined) await client.connection.call('scripts/packs/remove', { id: e.skill.pack })
    else await client.connection.call('skills/remove', { name: e.name })
    setSelected('')
    return `已删除 ${e.title}`
  })
  const update = (e: Entry) => act(`update:${e.name}`, async () => {
    const r = await client.connection.call('skillhub/update', { name: e.name })
    return r.state === 'updated' ? `${e.title} 已更新` : '已是最新'
  })
  const switchVersion = (e: Entry, version: string) => act(`version:${e.name}`, async () => {
    const item = await client.connection.call('skillhub/version', { name: e.name, version })
    return `${e.title} 换成了 ${item.installed?.version ?? version}${version === e.hub?.version ? '（最新）' : '：技能库再有更新的版本时会再提示'}`
  })
  const rollback = (e: Entry) => act(`rollback:${e.name}`, async () => {
    const back = await client.connection.call('skillhub/rollback', { name: e.name })
    return `${e.title} 已回退${back.installed?.version === undefined ? '' : `到 ${back.installed.version}`}；技能库再有新版本时会再提示`
  })
  const blank = (): Draft => ({ name: '', description: '', content: '', scripts: [], games: game !== ALL && game !== GENERAL ? [game] : [] })

  const marks = (e: Entry) => (
    <>
      {e.hub?.installed?.update === true && e.hub.incompatible === undefined && <span className="skill-dot" title="技能库有新版" />}
      {e.category === 'core' && <span className="skill-row-mark" title="核心技能：受保护，不能改"><Icon name="shield" /></span>}
    </>
  )
  const row = (e: Entry) => (
    <button key={e.name} className={`script-row skill-row ${e.hub !== undefined ? 'from-hub' : mineOf(e) ? 'own' : ''} ${draft === null && current?.name === e.name ? 'active' : ''}`}
      title={e.hub !== undefined ? `从技能库下载的（作者 ${e.hub.author ?? e.hub.repo}）` : mineOf(e) ? '你或 agent 写的' : undefined} onClick={() => choose(e.name)}>
      <span className="script-row-main">
        <span className="script-row-name">{e.title}</span>
        <span className="muted small skills-row-desc">{where(e) || e.description}</span>
      </span>
      {marks(e)}
    </button>
  )
  const updates = (hub?.items ?? []).filter(i => i.installed?.update === true && i.incompatible === undefined).length

  return (
    <section className="main scripts-page skills-page">
      <header className="page-header">
        <div className="breadcrumb"><h1>技能</h1></div>
        {hasHub && (
          <div className="tabs" role="tablist" aria-label="技能">
            <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'active' : ''} onClick={() => switchTab('mine')}>已有的技能</button>
            <button role="tab" aria-selected={tab === 'hub'} className={tab === 'hub' ? 'active' : ''} onClick={() => switchTab('hub')}>
              技能库{updates > 0 && <span className="skills-tab-badge" title={`${updates} 个有新版`}>{updates}</span>}
            </button>
          </div>
        )}
        <div className="page-actions">
          {tab === 'mine' && (
            <button className="small-button primary" disabled={status.state !== 'open'} onClick={() => setDraft(blank())}>
              <Icon name="plus" />新建技能
            </button>
          )}
        </div>
      </header>
      {tab === 'hub' && hasHub ? (
        <div className="skill-hub-body">
          {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
          {message !== null && <div className="notice info left small"><Icon name="check" /><span>{message}</span></div>}
          <SkillHubPanel client={client} hub={hub} games={games} scripts={scripts} focus={focus} busy={busy} now={now} act={act}
            onRefresh={() => loadHub(true)} onOpen={name => { switchTab('mine'); setSelected(name) }} />
        </div>
      ) : (
      <div className="scripts-body">
        <aside className="scripts-list" aria-label="技能列表">
          <div className="skills-tools">
            <div className="skills-search">
              <Icon name="search" />
              <input className="text-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索脚本包、游戏包和技能" aria-label="搜索" />
            </div>
            {games.length > 0 && (
              <select className="text-input skills-filter" value={game} aria-label="只看一个游戏的" onChange={e => setGame(e.target.value)}>
                <option value={ALL}>所有游戏</option>
                {games.map(g => <option key={g.id} value={g.id}>{g.name}</option>)}
                <option value={GENERAL}>通用（不分游戏）</option>
              </select>
            )}
          </div>
          {(skills === null || (hasHub && hub === null)) && error === null && <p className="muted small pad">正在读取…</p>}
          {skills !== null && needle !== '' && <p className="muted small skills-found">{shown.length === 0 ? '没有匹配的。' : `找到 ${shown.length} 个`}</p>}
          {grouped.map(section => {
            // Searching or filtering shows every match, folded or not.
            const searching = needle !== '' || game !== ALL
            const open = searching || !folded.has(section.id)
            return (
              <div key={section.id} className={`skills-group ${open ? '' : 'folded'}`}>
                <div className="skills-section-head" title={section.hint}>
                  <button className="skills-fold" aria-expanded={open} onClick={() => fold(section.id)}>
                    <Icon name="chevron-down" className="skills-chevron" />
                    <Icon name={section.icon} className="skills-section-icon" />
                    <span className="skills-group-name">{section.label}</span>
                    <span className="skills-count">{section.items.length}</span>
                  </button>
                  {section.id === 'skill' && (
                    <button className="icon-button skills-add" title="新建一个技能" aria-label="新建技能" disabled={status.state !== 'open'} onClick={() => setDraft(blank())}>
                      <Icon name="plus" />
                    </button>
                  )}
                </div>
                {open && section.items.length === 0 && <p className="muted small skills-empty">{section.id === 'skill' ? 'agent 做成一件事后会提议存成技能；也可以自己写一个，或在「技能库」里下载。' : '没有'}</p>}
                {open && section.groups === undefined && section.items.map(row)}
                {open && section.groups?.map(g => {
                  const key = `${section.id}/${g.id}`
                  const subOpen = searching || !folded.has(key)
                  return (
                    <div key={key} className={`skills-sub ${subOpen ? '' : 'folded'}`}>
                      <button className="skills-sub-head" aria-expanded={subOpen} onClick={() => fold(key)}>
                        <Icon name="chevron-down" className="skills-chevron" />
                        <span className="skills-group-name">{g.name}</span>
                        <span className="skills-count">{g.items.length}</span>
                      </button>
                      {subOpen && g.items.map(row)}
                    </div>
                  )
                })}
              </div>
            )
          })}
        </aside>
        <div className="scripts-detail">
          <div className="script-detail">
            {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
            {message !== null && <div className="notice info left small"><Icon name="check" /><span>{message}</span></div>}
            {draft !== null ? (
              <SkillForm client={client} draft={draft} scripts={scripts} games={games} onCancel={() => setDraft(null)}
                onSaved={name => { setDraft(null); setSelected(name); setError(null); setMessage(draft.original === undefined ? '已保存，agent 现在就能用' : '已保存'); setRevision(r => r + 1) }} />
            ) : current === undefined ? (
              skills !== null && (
                <div className="skills-blank">
                  <Icon name="sparkles" />
                  <strong>{needle === '' && game === ALL ? '还没有技能' : '没有匹配的'}</strong>
                  <span className="muted small">agent 做成一件事后会提议存成技能；也可以自己写一个。</span>
                  <button className="small-button primary" disabled={status.state !== 'open'} onClick={() => setDraft(blank())}><Icon name="plus" />新建技能</button>
                </div>
              )
            ) : (
              <SkillDetail
                key={current.name} entry={current} where={where(current)} content={content?.name === current.name ? content.text : undefined}
                busy={busy} copied={copied} moving={moving} now={now}
                onCopy={() => { void navigator.clipboard?.writeText(`/${current.name} `).then(() => setCopied(true), () => {}) }}
                onUpdate={() => void update(current)} onVersion={version => void switchVersion(current, version)} onRollback={() => void rollback(current)} onRemove={() => void remove(current)}
                onEdit={() => setDraft({
                  original: current.name, ...(current.hub === undefined ? {} : { hub: true }), name: current.name, description: current.description,
                  content: content?.name === current.name ? content.text.trim() : '', scripts: [...(current.owner?.scripts ?? [])], games: [...(current.owner?.games ?? [])],
                })}
                onMove={() => setMoving(m => !m)}
                move={moving && current.skill !== undefined ? (
                  <MoveSkill client={client} skill={current.skill} content={content?.name === current.name ? content.text : undefined}
                    scripts={scripts} games={games} onCancel={() => setMoving(false)}
                    onMoved={() => { setMoving(false); setError(null); setRevision(r => r + 1); setHubRevision(r => r + 1) }} />
                ) : null}
              />
            )}
          </div>
        </div>
      </div>
      )}
    </section>
  )
}

/** One entry in full: what it is, where it is used, its version, what can be done with it, and its instructions. */
function SkillDetail({ entry, where, content, busy, copied, moving, now, onCopy, onUpdate, onVersion, onRollback, onRemove, onEdit, onMove, move }: {
  entry: Entry
  where: string
  /** Its instructions; undefined while they load. */
  content: string | undefined
  busy: string | null
  copied: boolean
  moving: boolean
  now: number
  onCopy: () => void
  onUpdate: () => void
  /** Take one of the versions the 技能库 keeps. */
  onVersion: (version: string) => void
  onRollback: () => void
  onRemove: () => void
  onEdit: () => void
  onMove: () => void
  move: ReactNode
}) {
  const { skill, hub } = entry
  const installed = hub?.installed
  const editable = skill?.removable === true || installed !== undefined
  const version = hub === undefined ? undefined : versionLabel(hub)
  const icon = CATEGORIES.find(c => c.id === entry.category)!.icon
  const pending = (key: string) => busy === `${key}:${entry.name}`
  // The 技能库's current version and the earlier ones it keeps (git tags), newest first.
  const versions = hub === undefined ? [] : [
    ...(hub.version === undefined ? [] : [{ version: hub.version, changes: hub.changes, latest: true }]),
    ...(hub.history ?? []).map(h => ({ ...h, latest: false })),
  ]
  const [pick, setPick] = useState(installed?.version ?? hub?.version ?? '')
  const picked = versions.find(v => v.version === pick)
  return (
    <article className="card skill-card">
      <header className="skill-top">
        <div className="skill-title">
          <div className="skill-kicker"><Icon name={icon} />{LABEL[entry.category]}{hub !== undefined ? ` · 从技能库下载的 · 作者 ${hub.author ?? hub.repo}` : mineOf(entry) ? ' · 你或 agent 写的' : ''}</div>
          <h2>{entry.title}</h2>
          <div className="skill-meta">
            {entry.title !== entry.name && <code className="skill-name">{entry.name}</code>}
            {where === ''
              ? <span className="badge" title="所有对话都看得到、用得了"><Icon name="layers" />通用</span>
              : <span className="badge warn" title="技能隔离：只有在处理这些游戏或脚本的对话里，agent 才看得到、用得了它"><Icon name={entry.owner?.scripts?.length ? 'package' : 'gamepad'} />只给 {where} 用</span>}
            {skill?.modelInvocable === true && <span className="badge ok" title="agent 遇到相关的事会自己读它">agent 自动使用</span>}
            {version !== undefined && <span className="badge" title={installed?.at === undefined ? undefined : `${relativeTime(installed.at, now)}下载`}>{version}</span>}
            {installed?.update === true && hub?.incompatible === undefined && <span className="badge ok">有新版</span>}
            {installed?.held === true && <span className="badge" title="回退过：技能库再有更新的版本才会提示">已回退</span>}
            {entry.category === 'core' && <span className="badge"><Icon name="shield" />受保护</span>}
          </div>
        </div>
        <div className="skill-buttons">
          {installed?.update === true && hub?.incompatible === undefined && (
            <button className="small-button primary" disabled={busy !== null} onClick={onUpdate}>{pending('update') ? '更新中…' : '更新'}</button>
          )}
          {installed?.held === true && hub?.incompatible === undefined && (
            <button className="small-button" title="回退过的那个新版本，再换回去" disabled={busy !== null} onClick={onUpdate}>{pending('update') ? '更新中…' : '重新更新'}</button>
          )}
          {installed?.previous !== undefined && (
            <button className="small-button" title={`换回上一个版本${installed.previous.version === undefined ? '' : ` ${installed.previous.version}`}（${relativeTime(installed.previous.at, now)}下载的）`} disabled={busy !== null} onClick={onRollback}>
              {pending('rollback') ? '回退中…' : '回退'}
            </button>
          )}
          {skill?.userInvocable === true && (
            <button className="small-button" onClick={onCopy} title="复制后粘贴到对话框，后面写要它做的事">
              <Icon name={copied ? 'check' : 'copy'} />{copied ? '已复制' : `/${entry.name}`}
            </button>
          )}
          {editable && <button className="small-button" disabled={content === undefined} onClick={onEdit}><Icon name="pencil" />编辑</button>}
          {editable && (
            <button className="small-button" aria-expanded={moving} onClick={onMove} title="放错了游戏或脚本时，换到对的那个"><Icon name="gamepad" />更换游戏和脚本</button>
          )}
          {(editable || skill?.ownPack === true) && <button className="small-button danger-outline" disabled={busy !== null} onClick={onRemove}>{pending('remove') ? '删除中…' : '删除'}</button>}
          {skill?.path !== undefined && desktop()?.openPath !== undefined && (
            <button className="icon-button skill-folder" title={`打开所在文件夹：${skill.path}`} aria-label="打开所在文件夹"
              onClick={() => void desktop()?.openPath?.(skill.path!.replace(/[\\/][^\\/]+$/, ''))}>
              <Icon name="layers" />
            </button>
          )}
        </div>
      </header>
      {move}
      <p className="skill-desc">{entry.description}</p>
      {skill?.whenToUse !== undefined && <p className="muted small">什么时候用：{skill.whenToUse}</p>}
      <div className="skill-notes">
        {entry.category === 'script-pack' && <p className="muted small">脚本包：脚本页按它安装和运行这个脚本（有哪些任务、运行前改哪些设置），agent 按这里的做法处理它。删掉后已经装好的脚本保留，只是没有这些任务了。</p>}
        {entry.category === 'game-pack' && <p className="muted small">游戏包：游戏页按它读这个游戏的活动，agent 按这里的做法看游戏画面。不玩这个游戏可以删掉，或在「游戏 → 更多游戏」里取消勾选。</p>}
        {entry.category === 'core' && <p className="muted small">核心技能维持软件的基本功能，受保护，不能改和删，随软件更新。</p>}
        {installed !== undefined && <p className="muted small">从技能库下载的：可以改，但技能库更新它时会整个换成新版本，这里改的不保留（被换掉的那版可以回退）。要一直留着的做法，另存成自己的技能。</p>}
        {hub?.changes !== undefined && installed?.update === true && <p className="small hub-changes">{hub.version === undefined ? '' : `${hub.version}：`}{hub.changes}</p>}
        {hub?.incompatible !== undefined && <p className="small hub-incompatible">新版{hub.incompatible}</p>}
      </div>
      {installed !== undefined && versions.length > 1 && (
        <div className="skill-versions">
          <label className="field-label" htmlFor="skill-version">版本（技能库留着的每一版都能换，往前往后都行）</label>
          <div className="skill-versions-row">
            <select id="skill-version" className="text-input skill-version-select" value={pick} disabled={busy !== null} onChange={e => setPick(e.target.value)}>
              {versions.map(v => <option key={v.version} value={v.version}>{v.version}{v.latest ? '（最新）' : ''}{v.version === installed.version ? '（正在用）' : ''}</option>)}
            </select>
            <button className="small-button" disabled={busy !== null || pick === installed.version} onClick={() => onVersion(pick)}>{pending('version') ? '切换中…' : '换成这个版本'}</button>
          </div>
          {picked?.changes !== undefined && <span className="muted small">{picked.version}：{picked.changes}</span>}
          {picked !== undefined && !picked.latest && pick !== installed.version && <span className="muted small">换到旧版后不再提示更新，直到技能库有更新的版本；随时可以换回最新。</span>}
        </div>
      )}
      <section className="skill-body" aria-label="内容">
        <div className="skill-body-label">内容</div>
        {content === undefined ? <p className="muted">正在读取…</p> : content.trim() === '' ? <p className="muted">（没有内容）</p> : <Markdown text={content} />}
      </section>
      {skill?.path !== undefined && <code className="muted small skill-path" title={skill.path}>{skill.path}</code>}
    </article>
  )
}

/** 「1.0.0」, or 「1.0.0 → 1.1.0」 when the repository has a newer one. */
function versionLabel(item: HubItem): string | undefined {
  const here = item.installed?.version
  if (item.installed === undefined) return item.version
  if (item.installed.update && item.version !== undefined && item.version !== here) return `${here ?? '旧版'} → ${item.version}`
  return here
}

/** Make a skill, or change one of the user's or a downloaded one (its name, and a downloaded one's owner, stay). */
function SkillForm({ client, draft, scripts, games, onCancel, onSaved }: {
  client: PageProps['client']
  draft: Draft
  scripts: readonly ScriptInfo[]
  games: readonly GameRef[]
  onCancel: () => void
  onSaved: (name: string) => void
}) {
  const [form, setForm] = useState(draft)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => { setForm(draft); setError(null) }, [draft])
  const editing = draft.original !== undefined
  const nameOk = SKILL_NAME.test(form.name) && form.name.length <= MAX_SKILL_NAME
  const ready = nameOk && form.description.trim().length >= 10 && form.content.trim().length >= 20

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      if (draft.hub === true) {
        await client.connection.call('skillhub/save', { name: form.name, description: form.description.trim(), content: form.content.trim() })
      } else {
        await client.connection.call('skills/save', {
          name: form.name, description: form.description.trim(), content: form.content.trim(),
          ...(form.scripts.length === 0 ? {} : { scripts: form.scripts }),
          ...(form.games.length === 0 ? {} : { games: form.games }),
          ...(editing ? { replace: true } : {}),
        })
      }
      onSaved(form.name)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="card skill-card skill-form">
      <div className="skill-title"><h2>{editing ? `编辑 ${draft.original}` : '新建技能'}</h2></div>
      {draft.hub === true && <p className="muted small">这是从技能库下载的：技能库更新它时会整个换成新版本，这里改的不保留（被换掉的那版可以回退）。</p>}
      <label className="field">
        <span className="field-label">名字（在对话里用 /名字 调用它）</span>
        <input className="text-input" value={form.name} disabled={editing} maxLength={MAX_SKILL_NAME} autoFocus={!editing}
          onChange={e => setForm(f => ({ ...f, name: e.target.value.trim().toLowerCase() }))} placeholder="例：maa-daily-check" />
        {form.name !== '' && !nameOk && <span className="error small">只能用小写英文字母、数字和短横线，例如 maa-daily-check</span>}
      </label>
      {draft.hub !== true && <OwnerFields scripts={scripts} games={games} value={form} onChange={owner => setForm(f => ({ ...f, ...owner }))} />}
      <label className="field">
        <span className="field-label">说明：做什么、什么时候用（agent 靠它决定什么时候用，10–400 字）</span>
        <textarea className="text-input" rows={2} maxLength={400} value={form.description} onChange={e => setForm(f => ({ ...f, description: e.target.value }))}
          placeholder="例：MAA 日常跑完后检查理智和基建是否都处理了；用户问「MAA 跑完了吗」时用。" />
      </label>
      <label className="field">
        <span className="field-label">内容（Markdown）：适用场景、一步一步的做法、怎样算成功、注意事项</span>
        <textarea className="text-input skill-content-input" rows={16} maxLength={20_000} value={form.content} onChange={e => setForm(f => ({ ...f, content: e.target.value }))} />
      </label>
      {error !== null && <p className="error small">{error}</p>}
      <div className="skill-actions">
        <span className="spacer" />
        <button className="small-button" disabled={busy} onClick={onCancel}>取消</button>
        <button className="small-button primary" disabled={busy || !ready} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </article>
  )
}

/** What a skill belongs to: games and scripts, as checklists. */
interface Owner { scripts: string[]; games: string[] }

/** The game and script checklists of the form and of 更换游戏和脚本; none ticked: a general skill. */
function OwnerFields({ scripts, games, value, onChange }: {
  scripts: readonly ScriptInfo[]
  games: readonly GameRef[]
  value: Owner
  onChange: (owner: Owner) => void
}) {
  // An owner the lists do not have (removed, or a pack id) stays listed while editing, so unticking it can be undone.
  const [first] = useState(value)
  const unknown = [...new Set([...first.scripts, ...value.scripts])].filter(id => !scripts.some(s => s.id === id))
  const unknownGames = [...new Set([...first.games, ...value.games])].filter(key => findGame(key, games) === undefined)
  const isGame = (key: string, id: string) => key === id || findGame(key, games)?.id === id
  const toggle = (id: string) => onChange({ ...value, scripts: value.scripts.includes(id) ? value.scripts.filter(s => s !== id) : [...value.scripts, id] })
  const toggleGame = (id: string) => onChange({ ...value, games: value.games.some(key => isGame(key, id)) ? value.games.filter(key => !isGame(key, id)) : [...value.games, id] })
  return (
    <>
      {(games.length > 0 || unknownGames.length > 0) && (
        <fieldset className="field skill-owners">
          <legend className="field-label">给哪个游戏用（和游戏本身有关、换个脚本也用得上的：游戏里的操作、界面、活动、机制）</legend>
          <div className="skill-owner-list">
            {games.map(game => (
              <label key={game.id} className="check-label">
                <input type="checkbox" checked={value.games.some(key => isGame(key, game.id))} onChange={() => toggleGame(game.id)} />{game.name}
              </label>
            ))}
            {unknownGames.map(key => (
              <label key={key} className="check-label" title="游戏页上没有这个游戏">
                <input type="checkbox" checked={value.games.includes(key)} onChange={() => toggleGame(key)} />{key}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <fieldset className="field skill-owners">
        <legend className="field-label">给哪个脚本用（只在用这个脚本时才用得上的做法：它的配置、报错、日志）</legend>
        {scripts.length === 0 && unknown.length === 0 && <span className="muted small">还没有装脚本。</span>}
        <div className="skill-owner-list">
          {scripts.map(script => (
            <label key={script.id} className="check-label">
              <input type="checkbox" checked={value.scripts.includes(script.id)} onChange={() => toggle(script.id)} />{script.name}
            </label>
          ))}
          {unknown.map(id => (
            <label key={id} className="check-label" title="这个脚本不在脚本库里（删掉了，或是脚本包 id）">
              <input type="checkbox" checked={value.scripts.includes(id)} onChange={() => toggle(id)} />{id}
            </label>
          ))}
        </div>
      </fieldset>
      <p className="muted small">游戏和脚本都不选就是通用技能，所有对话都能用。</p>
    </>
  )
}

/**
 * 更换游戏和脚本: put a skill picked for the wrong game or script under the
 * right one. A skill saved here is written again with its new owner; one from
 * the 技能库 keeps the choice beside it (kept across updates), and can go back
 * to the repository's.
 */
function MoveSkill({ client, skill, content, scripts, games, onCancel, onMoved }: {
  client: PageProps['client']
  skill: SkillInfo
  /** Its instructions, needed to write a saved skill again; undefined while they load. */
  content: string | undefined
  scripts: readonly ScriptInfo[]
  games: readonly GameRef[]
  onCancel: () => void
  onMoved: () => void
}) {
  const [owner, setOwner] = useState<Owner>({ scripts: [...(skill.owner?.scripts ?? [])], games: [...(skill.owner?.games ?? [])] })
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const hub = skill.source === 'hub'
  const run = async (next: Owner | null) => {
    setBusy(true)
    setError(null)
    try {
      if (hub) await client.connection.call('skillhub/owner', { name: skill.name, owner: next })
      else {
        if (content === undefined || next === null) return
        await client.connection.call('skills/save', {
          name: skill.name, description: skill.description, content, replace: true,
          ...(next.scripts.length === 0 ? {} : { scripts: next.scripts }),
          ...(next.games.length === 0 ? {} : { games: next.games }),
        })
      }
      onMoved()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="skill-move" role="group" aria-label="更换游戏和脚本">
      <OwnerFields scripts={scripts} games={games} value={owner} onChange={setOwner} />
      {hub && <p className="muted small">这是从技能库下载的：你选的会一直保留，技能库更新它也不变。</p>}
      {error !== null && <p className="error small">{error}</p>}
      <div className="skill-actions">
        {hub && <button className="link-button small" disabled={busy} onClick={() => void run(null)}>恢复成技能库里的</button>}
        <span className="spacer" />
        <button className="small-button" disabled={busy} onClick={onCancel}>取消</button>
        <button className="small-button primary" disabled={busy || (!hub && content === undefined)} onClick={() => void run(owner)}>{busy ? '保存中…' : '保存'}</button>
      </div>
    </div>
  )
}
