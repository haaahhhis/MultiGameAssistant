/**
 * 技能库: what the skills repositories have, to pick from and download. Laid
 * out as the repository files them: by game, then the script that plays it,
 * then who published it, then the packs and skills themselves. A game's own
 * packs (its game pack, its game skills) sit under 「游戏本身」; skills for no
 * game under 通用. The repositories read are chosen here too (「仓库」).
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { HubItem, HubRepo, RequestResult, ScriptInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import type { GameRef } from '../../skillPlaces.ts'

type Hub = RequestResult<'skillhub/list'>
const OFFICIAL = 'MultiGameAssistant'
const KIND_LABEL = (i: HubItem) => i.pack === 'script' ? '脚本包' : i.pack === 'game' ? '游戏包' : '技能'

interface Branch<T> { readonly key: string; readonly name: string; readonly children: T }
type Tree = Branch<Branch<Branch<HubItem[]>[]>[]>[]

/** Games, scripts and authors, in the order people look for them: the games on the page and the scripts installed first. */
function buildTree(items: readonly HubItem[], games: readonly GameRef[], scripts: readonly ScriptInfo[]): Tree {
  const scriptPack = (id: string) => items.find(i => i.pack === 'script' && i.name === id)
  const gameOf = (i: HubItem): string | undefined => {
    if (i.pack === 'game') return i.game ?? i.games[0]
    if (i.games[0] !== undefined) return i.games[0]
    const script = i.pack === 'script' ? i.name : i.scripts[0]
    if (script === undefined) return undefined
    return scriptPack(script)?.games[0] ?? games.find(g => g.scripts.includes(script))?.id
  }
  const scriptOf = (i: HubItem): string | undefined => i.pack === 'script' ? i.name : i.pack === 'game' ? undefined : i.scripts[0]
  const gameName = (id: string) => games.find(g => g.id === id)?.name ?? items.find(i => i.pack === 'game' && i.game === id)?.title ?? id
  const scriptName = (id: string) => scriptPack(id)?.title ?? scripts.find(s => s.id === id || s.packId === id)?.name ?? id
  const gameRank = (id: string) => { const at = games.findIndex(g => g.id === id); return at < 0 ? games.length : at }
  const installedScript = (id: string) => scripts.some(s => s.id === id || s.packId === id)
  const itemRank = (i: HubItem) => i.pack === 'game' ? 0 : i.pack === 'script' ? 1 : 2

  const byGame = new Map<string, HubItem[]>()
  for (const item of items) {
    const key = gameOf(item) ?? ''
    byGame.set(key, [...byGame.get(key) ?? [], item])
  }
  const gameKeys = [...byGame.keys()].sort((a, b) => Number(a === '') - Number(b === '') || gameRank(a) - gameRank(b) || gameName(a).localeCompare(gameName(b)))
  return gameKeys.map(gameKey => {
    const byScript = new Map<string, HubItem[]>()
    for (const item of byGame.get(gameKey)!) {
      const key = scriptOf(item) ?? ''
      byScript.set(key, [...byScript.get(key) ?? [], item])
    }
    const scriptKeys = [...byScript.keys()].sort((a, b) => Number(b === '') - Number(a === '') || Number(installedScript(b)) - Number(installedScript(a)) || scriptName(a).localeCompare(scriptName(b)))
    return {
      key: gameKey,
      name: gameKey === '' ? '通用' : gameName(gameKey),
      children: scriptKeys.map(scriptKey => {
        const byAuthor = new Map<string, HubItem[]>()
        for (const item of byScript.get(scriptKey)!) {
          const author = item.author ?? item.repo.split('/')[0] ?? item.repo
          byAuthor.set(author, [...byAuthor.get(author) ?? [], item])
        }
        const authors = [...byAuthor.keys()].sort((a, b) => Number(b === OFFICIAL) - Number(a === OFFICIAL) || a.localeCompare(b))
        return {
          key: scriptKey,
          name: scriptKey === '' ? (gameKey === '' ? '不分脚本' : '游戏本身') : scriptName(scriptKey),
          children: authors.map(author => ({
            key: author,
            name: author,
            children: [...byAuthor.get(author)!].sort((a, b) => itemRank(a) - itemRank(b) || (a.title ?? a.name).localeCompare(b.title ?? b.name)),
          })),
        }
      }),
    }
  })
}

export function SkillHubPanel({ client, hub, games, scripts, focus, busy, now, act, onRefresh, onOpen }: {
  client: AdgClient
  hub: Hub | null
  /** The games on the game page and the installed scripts: first, and their names. */
  games: readonly GameRef[]
  scripts: readonly ScriptInfo[]
  /** One to show first (a link from a script's page). */
  focus?: string | undefined
  busy: string | null
  now: number
  /** Run something with the page's busy state and messages. */
  act: (key: string, fn: () => Promise<string | void>) => Promise<void>
  onRefresh: () => Promise<unknown>
  /** Show a downloaded one in 已有的技能. */
  onOpen: (name: string) => void
}) {
  const [query, setQuery] = useState('')
  const [editingRepos, setEditingRepos] = useState(false)
  const [preview, setPreview] = useState<{ name: string; text: string | null } | null>(null)
  const needle = query.trim().toLowerCase()
  const items = useMemo(() => (hub?.items ?? []).filter(i => needle === '' || `${i.name} ${i.title ?? ''} ${i.description} ${i.author ?? ''}`.toLowerCase().includes(needle)), [hub, needle])
  const tree = useMemo(() => buildTree(items, games, scripts), [items, games, scripts])
  const focused = useRef<HTMLLIElement | null>(null)
  useEffect(() => { focused.current?.scrollIntoView({ block: 'center' }) }, [focus, hub !== null])

  const showPreview = (name: string) => {
    if (preview?.name === name) { setPreview(null); return }
    setPreview({ name, text: null })
    client.connection.call('skillhub/preview', { name }).then(
      r => setPreview(p => p?.name === name ? { name, text: r.content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '') } : p),
      () => setPreview(p => p?.name === name ? { name, text: '' } : p),
    )
  }
  const pending = (key: string, item: HubItem) => busy === `${key}:${item.name}`
  const row = (item: HubItem) => {
    const installed = item.installed
    const canGet = installed === undefined && item.blocked === undefined && item.incompatible === undefined
    return (
      <li key={`${item.repo}/${item.name}`} ref={item.name === focus ? focused : undefined} className={`hub-item ${item.name === focus ? 'focused' : ''} ${installed !== undefined ? 'installed' : ''}`}>
        <div className="hub-main">
          <div className="hub-title">
            <strong>{item.title ?? item.name}</strong>
            <span className={`hub-kind ${item.pack ?? 'skill'}`}>{KIND_LABEL(item)}</span>
            {item.title !== undefined && <code className="muted small">{item.name}</code>}
            {item.version !== undefined && <span className="muted small">{installed?.version !== undefined && installed.version !== item.version ? `${installed.version} → ${item.version}` : item.version}</span>}
            {(item.history?.length ?? 0) > 0 && <span className="muted small" title={item.history!.map(h => h.version).join('、')}>共 {item.history!.length + 1} 个版本</span>}
            {installed !== undefined && <span className="badge ok" title={`${relativeTime(installed.at, now)}下载`}>已下载</span>}
            {installed?.update === true && item.incompatible === undefined && <span className="badge warn">有新版</span>}
          </div>
          <span className="muted small">{item.description}</span>
          {item.blocked !== undefined && <span className="muted small">{item.blocked}，没有下载（以你已有的为准）</span>}
          {item.incompatible !== undefined && <span className="small hub-incompatible">{item.incompatible}</span>}
          {preview?.name === item.name && (
            <div className="hub-preview">{preview.text === null ? <p className="muted small">正在读取…</p> : preview.text.trim() === '' ? <p className="muted small">（没有内容）</p> : <Markdown text={preview.text} />}</div>
          )}
        </div>
        <div className="hub-actions">
          <button className="small-button" aria-expanded={preview?.name === item.name} onClick={() => showPreview(item.name)}>{preview?.name === item.name ? '收起' : '内容'}</button>
          {canGet && (
            <button className="small-button primary" disabled={busy !== null} onClick={() => void act(`install:${item.name}`, async () => {
              await client.connection.call('skillhub/install', { name: item.name, repo: item.repo })
              return `已下载 ${item.title ?? item.name}${item.pack === 'script' ? '：脚本页可以按它安装这个脚本了' : item.pack === 'game' ? '：游戏页可以显示它了' : '，agent 现在就能用'}`
            })}><Icon name="download" />{pending('install', item) ? '下载中…' : '下载'}</button>
          )}
          {installed?.update === true && item.incompatible === undefined && (
            <button className="small-button primary" disabled={busy !== null} onClick={() => void act(`update:${item.name}`, async () => {
              const r = await client.connection.call('skillhub/update', { name: item.name })
              return r.state === 'updated' ? `${item.title ?? item.name} 已更新` : '已是最新'
            })}>{pending('update', item) ? '更新中…' : '更新'}</button>
          )}
          {installed !== undefined && <button className="small-button" onClick={() => onOpen(item.name)}>查看</button>}
        </div>
      </li>
    )
  }

  return (
    <div className="skill-hub">
      <section className="card skill-hub-head">
        <div className="skill-hub-top">
          <div className="skill-hub-intro">
            <h3>技能库</h3>
            <p className="muted small">脚本包、游戏包和技能放在 {hub?.repos.map(r => r.repo).join('、') ?? `${OFFICIAL}/skills`}，按游戏、脚本、作者分好，需要哪个下载哪个；下载的跟着技能库走，更新时整个换成新版本。</p>
          </div>
          <div className="skill-hub-buttons">
            <span className="muted small">{hub?.fetchedAt === undefined ? '' : `${relativeTime(hub.fetchedAt, now)}读取`}</span>
            <button className="small-button" disabled={busy !== null} onClick={() => void act('refresh', async () => { await onRefresh() })}><Icon name="refresh" />{busy === 'refresh' ? '读取中…' : '检查更新'}</button>
            <button className={`small-button ${editingRepos ? 'active' : ''}`} aria-expanded={editingRepos} onClick={() => setEditingRepos(e => !e)}>仓库</button>
          </div>
        </div>
        {editingRepos && hub !== null && (
          <RepoEditor repos={hub.repos} disabled={busy !== null} onSave={repos => void act('repos', async () => {
            await client.connection.call('skillhub/repos/set', { repos })
            setEditingRepos(false)
            await onRefresh()
            return '已保存，按新的仓库读取'
          })} />
        )}
        <div className="skills-search hub-search">
          <Icon name="search" />
          <input className="text-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索游戏、脚本、作者或技能" aria-label="搜索技能库" />
        </div>
        {hub?.errors.map(e => <div key={e} className="notice error left small"><Icon name="alert" /><span>读不到：{e}{hub.items.length > 0 ? '（下面是之前读到的）' : ''}</span></div>)}
      </section>

      {hub === null && <p className="muted">正在读取技能库…</p>}
      {hub !== null && items.length === 0 && <p className="muted">{needle === '' ? '技能库里还没有东西。' : '没有匹配的。'}</p>}
      {tree.map(game => (
        <section key={game.key || ':general'} className="card hub-game">
          <div className="hub-game-head">
            <Icon name={game.key === '' ? 'layers' : 'gamepad'} />
            <h3>{game.name}</h3>
            {games.some(g => g.id === game.key) && <span className="badge" title="游戏页上有这个游戏">在玩</span>}
          </div>
          {game.children.map(script => (
            <div key={script.key || ':none'} className="hub-script">
              <div className="hub-script-head"><Icon name={script.key === '' ? 'gamepad' : 'package'} />{script.name}</div>
              {script.children.map(author => (
                <div key={author.key} className="hub-author">
                  <div className="hub-author-head">
                    <span>作者 {author.name}</span>
                    {author.name === OFFICIAL && <span className="badge ok">官方</span>}
                  </div>
                  <ul className="hub-list">{author.children.map(row)}</ul>
                </div>
              ))}
            </div>
          ))}
        </section>
      ))}
    </div>
  )
}

/** Which repositories the 技能库 reads, in order (the first with a name wins). */
function RepoEditor({ repos, disabled, onSave }: { repos: readonly HubRepo[]; disabled: boolean; onSave: (repos: HubRepo[]) => void }) {
  const [text, setText] = useState(repos.map(r => (r.branch === 'main' ? r.repo : `${r.repo}@${r.branch}`)).join('\n'))
  const parsed = text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const [repo, branch] = line.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').split('@')
    return { repo: repo ?? '', branch: branch ?? 'main' }
  })
  const valid = parsed.length > 0 && parsed.every(r => /^[\w.-]+\/[\w.-]+$/.test(r.repo) && /^[\w./-]+$/.test(r.branch))
  return (
    <div className="hub-repos">
      <label className="field-label" htmlFor="hub-repos">技能仓库（一行一个 owner/repo，可以写 @分支；前面的同名技能优先）</label>
      <textarea id="hub-repos" className="text-input plain" rows={3} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
      <div className="skill-actions">
        <span className="muted small">整个仓库打包下载，不用装 git，走「设置 → 脚本安装」的下载镜像。只有默认仓库的脚本包当作官方的；别的仓库里的会让 agent 照着做，只加你信得过的。</span>
        <span className="spacer" />
        <button className="small-button" disabled={disabled} onClick={() => setText(`${OFFICIAL}/skills`)}>恢复默认</button>
        <button className="small-button primary" disabled={disabled || !valid} onClick={() => onSave(parsed)}>保存</button>
      </div>
    </div>
  )
}
