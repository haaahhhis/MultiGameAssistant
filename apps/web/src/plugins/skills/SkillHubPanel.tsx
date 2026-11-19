/**
 * 技能库: what the skills repositories have, laid out like 已有的技能 — a
 * directory on the left (game → script → author → the packs and skills, as
 * the repository files them; a game's own under 「游戏本身」, ones for no game
 * under 通用) and the one picked on the right: what it is, its versions,
 * download or update, and its instructions. The repositories read are chosen
 * on the right too (「仓库」 in the page header).
 */
import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { HubItem, HubRepo, RequestResult, ScriptInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { Select } from '../../components/Select.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import type { GameRef } from '../../skillPlaces.ts'

export type Hub = RequestResult<'skillhub/list'>
export const OFFICIAL = 'MultiGameAssistant'
export const kindLabel = (i: HubItem) => i.pack === 'script' ? '脚本包' : i.pack === 'game' ? '游戏包' : '技能'
const authorOf = (i: HubItem) => i.author ?? i.repo.split('/')[0] ?? i.repo

interface Branch<T> { readonly key: string; readonly name: string; readonly children: T }
/** game → script → author → items. */
export type HubTree = Branch<Branch<Branch<HubItem[]>[]>[]>[]

/** Games, scripts and authors, in the order people look for them: the games on the page and the scripts installed first. */
export function buildTree(items: readonly HubItem[], games: readonly GameRef[], scripts: readonly ScriptInfo[]): HubTree {
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
  const group = <T,>(list: readonly T[], key: (t: T) => string) => {
    const out = new Map<string, T[]>()
    for (const t of list) out.set(key(t), [...out.get(key(t)) ?? [], t])
    return out
  }

  const byGame = group(items, i => gameOf(i) ?? '')
  return [...byGame.keys()]
    .sort((a, b) => Number(a === '') - Number(b === '') || gameRank(a) - gameRank(b) || gameName(a).localeCompare(gameName(b)))
    .map(gameKey => {
      const byScript = group(byGame.get(gameKey)!, i => scriptOf(i) ?? '')
      return {
        key: gameKey,
        name: gameKey === '' ? '通用' : gameName(gameKey),
        children: [...byScript.keys()]
          .sort((a, b) => Number(b === '') - Number(a === '') || Number(installedScript(b)) - Number(installedScript(a)) || scriptName(a).localeCompare(scriptName(b)))
          .map(scriptKey => {
            const byAuthor = group(byScript.get(scriptKey)!, authorOf)
            return {
              key: scriptKey,
              name: scriptKey === '' ? (gameKey === '' ? '不分脚本' : '游戏本身') : scriptName(scriptKey),
              children: [...byAuthor.keys()]
                .sort((a, b) => Number(b === OFFICIAL) - Number(a === OFFICIAL) || a.localeCompare(b))
                .map(author => ({
                  key: author,
                  name: author,
                  children: [...byAuthor.get(author)!].sort((a, b) => itemRank(a) - itemRank(b) || (a.title ?? a.name).localeCompare(b.title ?? b.name)),
                })),
            }
          }),
      }
    })
}

/** The directory on the left: games fold, then each script with its authors and their packs. */
export function HubList({ tree, selected, searching, folded, onFold, onPick }: {
  tree: HubTree
  selected: string | undefined
  /** Searching shows every match, folded or not. */
  searching: boolean
  folded: ReadonlySet<string>
  onFold: (key: string) => void
  onPick: (name: string) => void
}) {
  return (
    <>
      {tree.map(game => {
        const key = `hub:${game.key || ':general'}`
        const open = searching || !folded.has(key)
        const count = game.children.reduce((n, s) => n + s.children.reduce((m, a) => m + a.children.length, 0), 0)
        return (
          <div key={key} className={`skills-group ${open ? '' : 'folded'}`}>
            <div className="skills-section-head">
              <button className="skills-fold" aria-expanded={open} onClick={() => onFold(key)}>
                <Icon name="chevron-down" className="skills-chevron" />
                <Icon name={game.key === '' ? 'layers' : 'gamepad'} className="skills-section-icon" />
                <span className="skills-group-name">{game.name}</span>
                <span className="skills-count">{count}</span>
              </button>
            </div>
            {open && game.children.map(script => (
              <div key={script.key || ':own'} className="skills-sub hub-sub">
                <div className="hub-script-label"><Icon name={script.key === '' ? 'gamepad' : 'package'} />{script.name}</div>
                {script.children.map(author => (
                  <div key={author.key} className="hub-author-block">
                    <div className="hub-author-label">{author.name}{author.name === OFFICIAL && <span className="hub-official">官方</span>}</div>
                    {author.children.map(item => (
                      <button key={`${item.repo}/${item.name}`} className={`script-row skill-row ${item.installed !== undefined ? 'from-hub' : ''} ${selected === item.name ? 'active' : ''}`}
                        title={item.installed !== undefined ? '已下载' : undefined} onClick={() => onPick(item.name)}>
                        <span className="script-row-main">
                          <span className="script-row-name">{item.title ?? item.name}</span>
                          <span className="muted small skills-row-desc">{item.description}</span>
                        </span>
                        <span className={`skill-row-tag ${item.pack === undefined ? 'subtle' : ''}`}>{kindLabel(item)}</span>
                        {item.installed?.update === true && item.incompatible === undefined && <span className="skill-dot" title="有新版" />}
                        {item.installed !== undefined && item.installed.update !== true && <span className="skill-row-mark" title="已下载"><Icon name="check" /></span>}
                      </button>
                    ))}
                  </div>
                ))}
              </div>
            ))}
          </div>
        )
      })}
    </>
  )
}

/** The one picked: what it is, its versions, download or update, its instructions. */
export function HubDetail({ client, item, where, busy, now, act, onOpen }: {
  client: AdgClient
  item: HubItem
  /** The game and script it is filed under, in words. */
  where: string
  busy: string | null
  now: number
  act: (key: string, fn: () => Promise<string | void>) => Promise<void>
  /** Show a downloaded one in 已有的技能. */
  onOpen: (name: string) => void
}) {
  const [content, setContent] = useState<string | null>(null)
  const installed = item.installed
  const versions = [
    ...(item.version === undefined ? [] : [{ version: item.version, changes: item.changes, latest: true }]),
    ...(item.history ?? []).map(h => ({ ...h, latest: false })),
  ]
  const [pick, setPick] = useState(installed?.version ?? item.version ?? '')
  const picked = versions.find(v => v.version === pick)
  const canGet = item.blocked === undefined && item.incompatible === undefined
  const pending = (key: string) => busy === `${key}:${item.name}`
  useEffect(() => {
    let live = true
    setContent(null)
    client.connection.call('skillhub/preview', { name: item.name }).then(
      r => { if (live) setContent(r.content.replace(/^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?/, '')) },
      () => { if (live) setContent('') },
    )
    return () => { live = false }
  }, [client, item.name, item.hash])

  const install = () => void act(`install:${item.name}`, async () => {
    await client.connection.call('skillhub/install', { name: item.name, repo: item.repo })
    return `已下载 ${item.title ?? item.name}${item.pack === 'script' ? '：脚本页可以按它安装这个脚本了' : item.pack === 'game' ? '：游戏页可以显示它了' : '，agent 现在就能用'}`
  })
  const update = () => void act(`update:${item.name}`, async () => {
    const r = await client.connection.call('skillhub/update', { name: item.name })
    return r.state === 'updated' ? `${item.title ?? item.name} 已更新` : '已是最新'
  })
  const takeVersion = () => void act(`version:${item.name}`, async () => {
    await client.connection.call('skillhub/version', { name: item.name, version: pick })
    return `${item.title ?? item.name} ${installed === undefined ? '下载了' : '换成了'} ${pick}${picked?.latest === true ? '（最新）' : ''}`
  })

  return (
    <article className="card skill-card">
      <header className="skill-top">
        <div className="skill-title">
          <div className="skill-kicker"><Icon name={item.pack === 'game' ? 'gamepad' : item.pack === 'script' ? 'package' : 'sparkles'} />{kindLabel(item)} · 作者 {authorOf(item)}{authorOf(item) === OFFICIAL ? '（官方）' : ''}</div>
          <h2>{item.title ?? item.name}</h2>
          <div className="skill-meta">
            {item.title !== undefined && <code className="skill-name">{item.name}</code>}
            {where !== '' && <span className="badge"><Icon name={item.pack === 'script' || item.scripts.length > 0 ? 'package' : 'gamepad'} />{where}</span>}
            {item.version !== undefined && <span className="badge">{item.version}</span>}
            {versions.length > 1 && <span className="badge" title={versions.map(v => v.version).join('、')}>共 {versions.length} 个版本</span>}
            {installed !== undefined && <span className="badge ok" title={`${relativeTime(installed.at, now)}下载`}>已下载{installed.version === undefined || installed.version === item.version ? '' : ` ${installed.version}`}</span>}
            {installed?.update === true && item.incompatible === undefined && <span className="badge warn">有新版</span>}
          </div>
        </div>
        <div className="skill-buttons">
          {installed === undefined && canGet && (
            <button className="small-button primary" disabled={busy !== null} onClick={install}><Icon name="download" />{pending('install') ? '下载中…' : '下载'}</button>
          )}
          {installed?.update === true && item.incompatible === undefined && (
            <button className="small-button primary" disabled={busy !== null} onClick={update}>{pending('update') ? '更新中…' : '更新'}</button>
          )}
          {installed !== undefined && <button className="small-button" onClick={() => onOpen(item.name)}>在已有的技能里查看</button>}
        </div>
      </header>
      <p className="skill-desc">{item.description}</p>
      <div className="skill-notes">
        {item.changes !== undefined && (installed === undefined || installed.update) && <p className="small hub-changes">{item.version === undefined ? '' : `${item.version}：`}{item.changes}</p>}
        {item.incompatible !== undefined && <p className="small hub-incompatible">{item.incompatible}</p>}
        {item.blocked !== undefined && <p className="muted small">{item.blocked}，没有下载（以你已有的为准）</p>}
      </div>
      {versions.length > 1 && canGet && (
        <div className="skill-versions">
          <span className="field-label">版本（技能库留着的每一版都能{installed === undefined ? '下载' : '换'}）</span>
          <div className="skill-versions-row">
            <Select className="skill-version-select" value={pick} onChange={setPick} disabled={busy !== null} aria-label="版本"
              options={versions.map(v => ({ value: v.version, label: `${v.version}${v.latest ? '（最新）' : ''}${v.version === installed?.version ? '（正在用）' : ''}`, ...(v.changes === undefined ? {} : { hint: v.changes }) }))} />
            <button className="small-button" disabled={busy !== null || pick === installed?.version} onClick={takeVersion}>
              {pending('version') ? '下载中…' : installed === undefined ? '下载这个版本' : '换成这个版本'}
            </button>
          </div>
        </div>
      )}
      <section className="skill-body" aria-label="内容">
        <div className="skill-body-label">技能库里的内容</div>
        {content === null ? <p className="muted">正在读取…</p> : content.trim() === '' ? <p className="muted">（没有内容）</p> : <Markdown text={content} />}
      </section>
      <code className="muted small skill-path">{item.repo}/{item.path}</code>
    </article>
  )
}

/** Which repositories the 技能库 reads, in order (the first with a name wins). */
export function RepoEditor({ repos, disabled, onSave, onCancel }: { repos: readonly HubRepo[]; disabled: boolean; onSave: (repos: HubRepo[]) => void; onCancel: () => void }) {
  const [text, setText] = useState(repos.map(r => (r.branch === 'main' ? r.repo : `${r.repo}@${r.branch}`)).join('\n'))
  const parsed = useMemo(() => text.split(/\r?\n/).map(l => l.trim()).filter(Boolean).map(line => {
    const [repo, branch] = line.replace(/^https:\/\/github\.com\//, '').replace(/\.git$/, '').split('@')
    return { repo: repo ?? '', branch: branch ?? 'main' }
  }), [text])
  const valid = parsed.length > 0 && parsed.every(r => /^[\w.-]+\/[\w.-]+$/.test(r.repo) && /^[\w./-]+$/.test(r.branch))
  return (
    <article className="card skill-card">
      <div className="skill-title"><h2>技能仓库</h2></div>
      <p className="muted small">脚本包、游戏包和技能从这些 GitHub 仓库下载（整个仓库打包下载，不用装 git，走「设置 → 脚本安装」的下载镜像），一天最多读一次。只有默认仓库 {OFFICIAL}/skills 的脚本包当作官方的；别的仓库里的会让 agent 照着做，只加你信得过的。</p>
      <label className="field">
        <span className="field-label">一行一个 owner/repo，可以写 @分支；前面的同名的优先</span>
        <textarea className="text-input plain skill-content-input" rows={4} value={text} onChange={e => setText(e.target.value)} spellCheck={false} />
      </label>
      <div className="skill-actions">
        <button className="link-button small" disabled={disabled} onClick={() => setText(`${OFFICIAL}/skills`)}>恢复默认</button>
        <span className="spacer" />
        <button className="small-button" disabled={disabled} onClick={onCancel}>取消</button>
        <button className="small-button primary" disabled={disabled || !valid} onClick={() => onSave(parsed)}>保存</button>
      </div>
    </article>
  )
}
