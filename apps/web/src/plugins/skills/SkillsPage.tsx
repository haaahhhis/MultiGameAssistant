import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { MAX_SKILL_NAME, SKILL_NAME, type HubItem, type HubRepo, type RequestResult, type ScriptInfo, type SkillInfo, type SkillOwner } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { confirm } from '../../components/Dialog.tsx'
import { Icon, type IconName } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { desktop } from '../../desktop.ts'
import { useNow, useStore } from '../../hooks.ts'
import { errorText, useScriptList } from '../scripts/data.ts'
import { findGame, placeLabel, placesOf, type GameRef } from '../../skillPlaces.ts'
import './skills.css'

type Hub = RequestResult<'skillhub/list'>

/**
 * What the list is split into. Script packs and game packs are what the app
 * starts with, from the 技能库 (the user may delete any); skills are ways of
 * doing things; the user's own can be changed freely; the core ones keep the
 * app working and cannot be changed.
 */
type Category = 'script-pack' | 'game-pack' | 'skill' | 'mine' | 'core' | 'available'
const CATEGORIES: readonly { id: Category; label: string; icon: IconName; hint: string }[] = [
  { id: 'script-pack', label: '脚本包', icon: 'package', hint: '脚本怎么装、有哪些任务、运行前改哪些设置；从技能库下载，用不上的可以删' },
  { id: 'game-pack', label: '游戏包', icon: 'gamepad', hint: '游戏页从哪里读活动、游戏里怎么看；从技能库下载，不玩的可以删' },
  { id: 'skill', label: '技能', icon: 'sparkles', hint: '从技能库下载的做法，只在处理对应的游戏和脚本时用' },
  { id: 'mine', label: '我的技能', icon: 'pencil', hint: 'agent 做成一件事后存的，和你自己写的' },
  { id: 'core', label: '核心技能', icon: 'shield', hint: '软件自带、维持基本功能的技能：受保护，不能改，随软件更新' },
  { id: 'available', label: '技能库里还有', icon: 'download', hint: '下载后 agent 马上就能用' },
]
const LABEL: Readonly<Record<Category, string>> = Object.fromEntries(CATEGORIES.map(c => [c.id, c.label])) as Record<Category, string>

/** One thing in the list: a skill the agents have, or one the 技能库 has that is not downloaded. */
interface Entry {
  readonly name: string
  readonly title: string
  readonly description: string
  readonly category: Category
  readonly skill?: SkillInfo
  readonly hub?: HubItem
  readonly owner?: SkillOwner
  /** For a game the user plays or a script they have (one not downloaded yet). */
  readonly suggested?: boolean
}

function categoryOf(skill: SkillInfo, hub: HubItem | undefined): Category {
  if (skill.kind === 'script-pack' || hub?.pack === 'script') return 'script-pack'
  if (skill.kind === 'game-pack' || hub?.pack === 'game') return 'game-pack'
  if (skill.removable === true) return 'mine'
  if (skill.source === 'bundled') return 'core'
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
 * 技能: the script packs, game packs and skills the agents have, by kind, and
 * what else the 技能库 has. Anything downloaded can be updated, gone back,
 * changed or deleted; the user's own skills made, changed and deleted; the
 * core ones only read. The filter shows one game's (技能隔离: a skill for a
 * game or script is used only while working on it).
 */
export function SkillsPage({ client, arg }: PageProps) {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const now = useNow(60_000)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [hub, setHub] = useState<Hub | null>(null)
  const [query, setQuery] = useState('')
  const [game, setGame] = useState(ALL)
  // #/p/skills/<name>, #/p/skills/hub (what the 技能库 has) or hub:<name> (from a script's page).
  const [selected, setSelected] = useState<string>(arg?.startsWith('hub:') === true ? arg.slice(4) : arg === 'hub' ? '' : (arg ?? ''))
  const [wantAvailable, setWantAvailable] = useState(arg === 'hub')
  const [content, setContent] = useState<{ name: string; text: string } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [busy, setBusy] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [hubRevision, setHubRevision] = useState(0)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const [moving, setMoving] = useState(false)
  const [editingRepos, setEditingRepos] = useState(false)
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
    if (arg === 'hub') { setWantAvailable(true); setSelected('') } else setSelected(arg.startsWith('hub:') ? arg.slice(4) : arg)
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

  // What the user plays and has: the 技能库's ones for them come first.
  const mine = useMemo(() => ({
    games: new Set(games.map(g => g.id)),
    scripts: new Set(scripts.flatMap(s => [s.id, s.packId, s.known].filter((x): x is string => x !== undefined))),
  }), [games, scripts])

  const entries = useMemo(() => {
    const out: Entry[] = []
    const items = hub?.items ?? []
    for (const skill of skills ?? []) {
      const item = skill.source === 'hub' ? items.find(i => i.name === skill.name && i.installed !== undefined) : undefined
      out.push({
        name: skill.name, title: item?.title ?? skill.name, description: skill.description, category: categoryOf(skill, item), skill,
        ...(item === undefined ? {} : { hub: item }), ...(skill.owner === undefined ? {} : { owner: skill.owner }),
      })
    }
    for (const item of items) {
      if (item.installed !== undefined || out.some(e => e.name === item.name)) continue
      const owner = { ...(item.games.length === 0 ? {} : { games: item.games }), ...(item.scripts.length === 0 ? {} : { scripts: item.scripts }) }
      out.push({
        name: item.name, title: item.title ?? item.name, description: item.description, category: 'available', hub: item, owner,
        suggested: item.games.some(g => mine.games.has(g)) || item.scripts.some(s => mine.scripts.has(s)),
      })
    }
    return out
  }, [skills, hub, mine])

  const placesOfEntry = (e: Entry) => placesOf(e.owner, scripts, games)
  /** Where it belongs, in words: 明日方舟 · MAA; empty for a general one. */
  const where = (e: Entry) => [...new Set(placesOfEntry(e).map(placeLabel))].join('、')
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
    items: shown.filter(e => e.category === c.id).sort((a, b) => Number(b.suggested === true) - Number(a.suggested === true) || a.title.localeCompare(b.title)),
  })).filter(s => s.items.length > 0 || (s.id === 'mine' && needle === '' && game === ALL)), [shown, needle, game])
  const ordered = sections.flatMap(s => s.items)
  const current = shown.find(e => e.name === selected) ?? (wantAvailable ? ordered.find(e => e.category === 'available') : undefined) ?? ordered[0]

  // Its instructions: the agents' copy, or the repository's for one not downloaded yet.
  useEffect(() => {
    setMoving(false)
    setCopied(false)
    if (current === undefined) { setContent(null); return }
    let live = true
    const name = current.name
    const read = current.category === 'available'
      ? client.connection.call('skillhub/preview', { name }).then(r => r.content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, ''))
      : client.connection.call('skills/get', { name }).then(r => r.content)
    read.then(text => { if (live) setContent({ name, text }) }, e => { if (live) { setContent({ name, text: '' }); setError(errorText(e)) } })
    return () => { live = false }
  }, [client, current?.name, current?.category, revision, hubRevision])

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
  const choose = (name: string) => { setDraft(null); setEditingRepos(false); setMessage(null); setError(null); setSelected(name); setWantAvailable(false) }

  const remove = (e: Entry) => act(`remove:${e.name}`, async () => {
    const what = e.category === 'script-pack'
      ? { title: `删除脚本包「${e.title}」？`, message: '脚本页不再有它的安装方式和任务说明，agent 也不再用它的做法；已经装好的脚本不会删。以后可以在「技能库里还有」里再下载。' }
      : e.category === 'game-pack'
        ? { title: `删除游戏包「${e.title}」？`, message: '游戏页不再显示这个游戏和它的活动。以后可以在「游戏 → 更多游戏」勾上，或在「技能库里还有」里再下载。' }
        : e.hub !== undefined
          ? { title: `删除技能「${e.title}」？`, message: '它的文件夹会一起删掉，agent 以后就用不到它了。以后可以在「技能库里还有」里再下载。' }
          : { title: `删除技能「${e.name}」？`, message: '它的文件夹会一起删掉，agent 以后就用不到它了。' }
    if (!await confirm({ ...what, confirmLabel: '删除', danger: true })) return
    if (e.hub !== undefined) await client.connection.call('skillhub/remove', { name: e.name })
    else await client.connection.call('skills/remove', { name: e.name })
    setSelected('')
    return `已删除 ${e.title}`
  })
  const install = (e: Entry) => act(`install:${e.name}`, async () => {
    await client.connection.call('skillhub/install', { name: e.name, repo: e.hub!.repo })
    return `已下载 ${e.title}${e.hub?.pack === 'script' ? '：脚本页可以按它安装这个脚本了' : e.hub?.pack === 'game' ? '：游戏页上有它了' : '，agent 现在就能用'}`
  })
  const update = (e: Entry) => act(`update:${e.name}`, async () => {
    const r = await client.connection.call('skillhub/update', { name: e.name })
    return r.state === 'updated' ? `${e.title} 已更新` : '已是最新'
  })
  const rollback = (e: Entry) => act(`rollback:${e.name}`, async () => {
    const back = await client.connection.call('skillhub/rollback', { name: e.name })
    return `${e.title} 已回退${back.installed?.version === undefined ? '' : `到 ${back.installed.version}`}；技能库再有新版本时会再提示`
  })
  const blank = (): Draft => ({ name: '', description: '', content: '', scripts: [], games: game !== ALL && game !== GENERAL ? [game] : [] })

  const defaults = hub?.defaults
  const marks = (e: Entry) => (
    <>
      {e.hub?.installed?.update === true && e.hub.incompatible === undefined && <span className="skill-dot" title="技能库有新版" />}
      {e.suggested === true && <span className="skill-row-tag" title="你关注的游戏、装了的脚本用得上">推荐</span>}
      {e.category === 'available' && e.hub?.pack !== undefined && <span className="skill-row-tag subtle">{e.hub.pack === 'script' ? '脚本包' : '游戏包'}</span>}
      {e.category === 'core' && <span className="skill-row-mark" title="核心技能：受保护，不能改"><Icon name="shield" /></span>}
    </>
  )

  return (
    <section className="main scripts-page skills-page">
      <header className="page-header">
        <div className="breadcrumb"><h1>技能</h1></div>
        <div className="page-actions">
          {hasHub && <span className="muted small skills-fetched">{hub?.fetchedAt === undefined ? '' : `技能库 ${relativeTime(hub.fetchedAt, now)}读取`}</span>}
          {hasHub && (
            <button className="small-button" disabled={busy !== null} title="现在读一次技能库，看有没有新版本" onClick={() => void act('refresh', async () => { await loadHub(true) })}>
              <Icon name="refresh" />{busy === 'refresh' ? '读取中…' : '检查更新'}
            </button>
          )}
          {hasHub && <button className={`small-button ${editingRepos ? 'active' : ''}`} aria-expanded={editingRepos} onClick={() => { setEditingRepos(o => !o); setDraft(null) }}>技能仓库</button>}
          <button className="small-button primary" disabled={status.state !== 'open'} onClick={() => { setEditingRepos(false); setDraft(blank()) }}>
            <Icon name="plus" />新建技能
          </button>
        </div>
      </header>
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
          {defaults !== undefined && (
            <div className={`notice ${defaults.error === undefined ? 'info' : 'error'} left small skills-defaults`}>
              <Icon name={defaults.error === undefined ? 'download' : 'alert'} />
              <span>
                {defaults.error === undefined ? `正在从技能库下载软件自带的：${defaults.pending.join('、')}` : `软件自带的脚本包和游戏包还没下载下来（${defaults.error}），会自动再试`}
                {' '}<button className="link-button small" disabled={busy !== null} onClick={() => void act('defaults', async () => {
                  const { names } = await client.connection.call('skillhub/defaults', {})
                  return names.length === 0 ? '没有要下载的' : `已下载 ${names.join('、')}`
                })}>{busy === 'defaults' ? '下载中…' : '现在下载'}</button>
              </span>
            </div>
          )}
          {(skills === null || (hasHub && hub === null)) && error === null && <p className="muted small pad">正在读取…</p>}
          {skills !== null && needle !== '' && <p className="muted small skills-found">{shown.length === 0 ? '没有匹配的。' : `找到 ${shown.length} 个`}</p>}
          {sections.map(section => {
            // Searching or filtering shows every match, folded or not.
            const open = needle !== '' || game !== ALL || !folded.has(section.id)
            return (
              <div key={section.id} className={`skills-group ${open ? '' : 'folded'}`}>
                <div className="skills-section-head" title={section.hint}>
                  <button className="skills-fold" aria-expanded={open} onClick={() => fold(section.id)}>
                    <Icon name="chevron-down" className="skills-chevron" />
                    <Icon name={section.icon} className="skills-section-icon" />
                    <span className="skills-group-name">{section.label}</span>
                    <span className="skills-count">{section.items.length}</span>
                  </button>
                  {section.id === 'mine' && (
                    <button className="icon-button skills-add" title="新建一个技能" aria-label="新建技能" disabled={status.state !== 'open'} onClick={() => { setEditingRepos(false); setDraft(blank()) }}>
                      <Icon name="plus" />
                    </button>
                  )}
                </div>
                {open && section.items.length === 0 && <p className="muted small skills-empty">{section.id === 'mine' ? 'agent 做成一件事后会提议存成技能；也可以自己写一个。' : '没有'}</p>}
                {open && section.items.map(e => (
                  <button key={e.name} className={`script-row skill-row ${draft === null && !editingRepos && current?.name === e.name ? 'active' : ''}`} onClick={() => choose(e.name)}>
                    <span className="script-row-main">
                      <span className="script-row-name">{e.title}</span>
                      <span className="muted small skills-row-desc">{where(e) || e.description}</span>
                    </span>
                    {marks(e)}
                  </button>
                ))}
              </div>
            )
          })}
        </aside>
        <div className="scripts-detail">
          <div className="script-detail">
            {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
            {message !== null && <div className="notice info left small"><Icon name="check" /><span>{message}</span></div>}
            {hub?.errors.map(e => <div key={e} className="notice error left small"><Icon name="alert" /><span>技能库读不到：{e}{hub.items.length > 0 ? '（列出的是之前读到的）' : ''}</span></div>)}
            {editingRepos && hub !== null ? (
              <RepoEditor repos={hub.repos} disabled={busy !== null} onCancel={() => setEditingRepos(false)} onSave={repos => void act('repos', async () => {
                await client.connection.call('skillhub/repos/set', { repos })
                setEditingRepos(false)
                await loadHub(true)
                return '已保存，按新的仓库读取'
              })} />
            ) : draft !== null ? (
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
                onInstall={() => void install(current)} onUpdate={() => void update(current)} onRollback={() => void rollback(current)} onRemove={() => void remove(current)}
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
    </section>
  )
}

/** One entry in full: what it is, where it is used, its version, what can be done with it, and its instructions. */
function SkillDetail({ entry, where, content, busy, copied, moving, now, onCopy, onInstall, onUpdate, onRollback, onRemove, onEdit, onMove, move }: {
  entry: Entry
  where: string
  /** Its instructions; undefined while they load. */
  content: string | undefined
  busy: string | null
  copied: boolean
  moving: boolean
  now: number
  onCopy: () => void
  onInstall: () => void
  onUpdate: () => void
  onRollback: () => void
  onRemove: () => void
  onEdit: () => void
  onMove: () => void
  move: ReactNode
}) {
  const { skill, hub } = entry
  const installed = hub?.installed
  const available = entry.category === 'available'
  const editable = skill?.removable === true || installed !== undefined
  const version = hub === undefined ? undefined : versionLabel(hub)
  const icon = CATEGORIES.find(c => c.id === entry.category)!.icon
  const kind = available ? (hub?.pack === 'script' ? '脚本包' : hub?.pack === 'game' ? '游戏包' : '技能') : LABEL[entry.category]
  const pending = (key: string) => busy === `${key}:${entry.name}`
  return (
    <article className="card skill-card">
      <header className="skill-top">
        <div className="skill-title">
          <div className="skill-kicker"><Icon name={icon} />{kind}{available ? ' · 技能库里有，还没下载' : hub !== undefined ? ' · 从技能库下载的' : ''}</div>
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
          {available && hub !== undefined && hub.blocked === undefined && hub.incompatible === undefined && (
            <button className="small-button primary" disabled={busy !== null} onClick={onInstall}><Icon name="download" />{pending('install') ? '下载中…' : '下载'}</button>
          )}
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
          {editable && <button className="small-button danger-outline" disabled={busy !== null} onClick={onRemove}>{pending('remove') ? '删除中…' : '删除'}</button>}
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
        {hub?.changes !== undefined && (available || installed?.update === true) && <p className="small hub-changes">{hub.version === undefined ? '' : `${hub.version}：`}{hub.changes}</p>}
        {hub?.incompatible !== undefined && <p className="small hub-incompatible">{installed === undefined ? '' : '新版'}{hub.incompatible}</p>}
        {available && hub?.blocked !== undefined && <p className="muted small">{hub.blocked}，没有下载（以你已有的为准）</p>}
      </div>
      <section className="skill-body" aria-label="内容">
        <div className="skill-body-label">{available ? '技能库里的内容' : '内容'}</div>
        {content === undefined ? <p className="muted">正在读取…</p> : content.trim() === '' ? <p className="muted">（没有内容）</p> : <Markdown text={content} />}
      </section>
      {skill?.path !== undefined && <code className="muted small skill-path" title={skill.path}>{skill.path}</code>}
      {available && hub !== undefined && <code className="muted small skill-path">{hub.repo}/{hub.path}</code>}
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

/** Which repositories the 技能库 reads, in order (the first with a name wins). */
function RepoEditor({ repos, disabled, onSave, onCancel }: { repos: readonly HubRepo[]; disabled: boolean; onSave: (repos: HubRepo[]) => void; onCancel: () => void }) {
  const [text, setText] = useState(repos.map(r => (r.branch === 'main' ? r.repo : `${r.repo}@${r.branch}`)).join('\n'))
  const parsed = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const [repo, branch] = line.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').split('@')
    return { repo: repo ?? '', branch: branch ?? 'main' }
  })
  const valid = parsed.length > 0 && parsed.every(r => /^[\w.-]+\/[\w.-]+$/.test(r.repo) && /^[\w./-]+$/.test(r.branch))
  return (
    <article className="card skill-card">
      <div className="skill-title"><h2>技能仓库</h2></div>
      <p className="muted small">脚本包、游戏包和技能从这些 GitHub 仓库下载（整个仓库打包下载，不用装 git，走「设置 → 脚本安装」的下载镜像），一天最多读一次。只有默认仓库 MultiGameAssistant/skills 的脚本包当作官方的；别的仓库里的会让 agent 照着做，只加你信得过的。</p>
      <label className="field">
        <span className="field-label">一行一个 owner/repo，可以写 @分支；前面的同名的优先</span>
        <textarea className="text-input plain skill-content-input" rows={4} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
      </label>
      <div className="skill-actions">
        <button className="link-button small" disabled={disabled} onClick={() => setText('MultiGameAssistant/skills')}>恢复默认</button>
        <span className="spacer" />
        <button className="small-button" disabled={disabled} onClick={onCancel}>取消</button>
        <button className="small-button primary" disabled={disabled || !valid} onClick={() => onSave(parsed)}>保存</button>
      </div>
    </article>
  )
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
