/**
 * 技能库: skills for games and scripts, downloaded from the skills
 * repository when the user wants them. Suggested for the games followed and
 * the scripts in the library; a downloaded skill follows the repository, and
 * an update replaces it (the replaced version kept to go back to).
 */
import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { HubItem, HubRepo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

const KIND: Readonly<Record<HubItem['kind'], string>> = { game: '游戏', script: '脚本', general: '通用' }

export function SkillHubPanel({ client, focus, openSkill }: {
  client: AdgClient
  /** A skill to show first (a link from the game page). */
  focus?: string | undefined
  openSkill: (name: string) => void
}) {
  const now = useNow(60_000)
  const capabilities = useStore(client.capabilities)
  const [data, setData] = useState<{ items: HubItem[]; repos: HubRepo[]; errors: string[]; fetchedAt?: number | undefined } | null>(null)
  const [mine, setMine] = useState<{ games: Set<string>; scripts: Set<string> }>({ games: new Set(), scripts: new Set() })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [editingRepos, setEditingRepos] = useState(false)

  const load = async (refresh = false) => {
    setBusy(refresh ? 'refresh' : busy)
    try {
      setData(await client.connection.call('skillhub/list', refresh ? { refresh: true } : {}))
      setError(null)
    } catch (e) {
      setError(errorText(e))
    } finally {
      if (refresh) setBusy(null)
    }
  }
  useEffect(() => { void load() }, [client])
  useEffect(() => client.connection.on('skillhub/changed', () => void load()), [client])
  // What the user plays: followed games, scripts in the library (and what they were recognized as).
  useEffect(() => {
    let live = true
    void (async () => {
      const games = capabilities.has('games') ? (await client.connection.call('games/list', {}).catch(() => undefined))?.games.map(g => g.id) ?? [] : []
      const scripts = capabilities.has('scripts') ? (await client.connection.call('scripts/list', {}).catch(() => undefined))?.scripts.flatMap(s => [s.id, s.packId, s.known].filter((x): x is string => x !== undefined)) ?? [] : []
      if (live) setMine({ games: new Set(games), scripts: new Set(scripts) })
    })()
    return () => { live = false }
  }, [client, capabilities.has('games'), capabilities.has('scripts')])

  const act = async (name: string, fn: () => Promise<string | void>) => {
    setBusy(name)
    setError(null)
    setMessage(null)
    try {
      const note = await fn()
      if (typeof note === 'string') setMessage(note)
      await load()
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const suggested = (item: HubItem) => item.games.some(g => mine.games.has(g)) || item.scripts.some(s => mine.scripts.has(s))
  const groups = useMemo(() => {
    const items = [...(data?.items ?? [])].sort((a, b) => Number(b.name === focus) - Number(a.name === focus) || a.name.localeCompare(b.name))
    return [
      { label: '已下载', items: items.filter(i => i.installed !== undefined) },
      { label: '推荐给你', hint: '你关注的游戏、装了的脚本', items: items.filter(i => i.installed === undefined && suggested(i)) },
      { label: '其他', items: items.filter(i => i.installed === undefined && !suggested(i)) },
    ].filter(g => g.items.length > 0)
  }, [data, mine, focus])

  const update = (item: HubItem) => act(`update:${item.name}`, async () => {
    const r = await client.connection.call('skillhub/update', { name: item.name })
    return r.state === 'updated' ? `${item.name} 已更新` : '已是最新'
  })

  return (
    <div className="skill-hub">
      <section className="card skill-hub-head">
        <div className="card-head">
          <div>
            <h3>技能库</h3>
            <p className="muted small">
              游戏和脚本的技能放在 {data?.repos.map(r => r.repo).join('、') ?? 'MultiGameAssistant/skills'}，按需下载；下载的跟着技能库走，更新时整个换成新版本。要留下自己的做法，另存成自己的技能。软件自带的核心技能受保护，随软件更新。
            </p>
          </div>
          <div className="key-actions">
            <span className="muted small">{data?.fetchedAt === undefined ? '' : `${relativeTime(data.fetchedAt, now)}读取`}</span>
            <button className="small-button" disabled={busy !== null} onClick={() => void load(true)}><Icon name="refresh" />{busy === 'refresh' ? '读取中…' : '检查更新'}</button>
            <button className="ghost small-button" onClick={() => setEditingRepos(e => !e)}>仓库</button>
          </div>
        </div>
        {editingRepos && data !== null && <RepoEditor repos={data.repos} disabled={busy !== null} onSave={repos => act('repos', async () => {
          await client.connection.call('skillhub/repos/set', { repos })
          setEditingRepos(false)
          await client.connection.call('skillhub/list', { refresh: true })
          return '已保存，按新的仓库读取'
        })} />}
        {data?.errors.map(e => <div key={e} className="notice error left small"><Icon name="alert" /><span>读不到：{e}{data.items.length > 0 ? '（下面是之前读到的）' : ''}</span></div>)}
      </section>

      {message !== null && <div className="notice info">{message}</div>}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
      {data === null && error === null && <p className="muted">正在读取技能库…</p>}
      {data !== null && data.items.length === 0 && data.errors.length === 0 && <p className="muted">技能库里还没有技能。</p>}

      {groups.map(group => (
        <section key={group.label} className="card">
          <div className="sidebar-label">{group.label}<span className="skills-count">{group.items.length}</span>{'hint' in group && <span>· {group.hint}</span>}</div>
          <ul className="hub-list">
            {group.items.map(item => (
              <li key={`${item.repo}/${item.name}`} className={item.name === focus ? 'focused' : ''}>
                <div className="hub-main">
                  <div className="hub-title">
                    <strong>{item.title ?? item.name}</strong>
                    {item.title !== undefined && <code className="muted small">{item.name}</code>}
                    <span className="badge">{KIND[item.kind]}</span>
                    {versionLabel(item) !== undefined && <span className="muted small">{versionLabel(item)}</span>}
                    {item.installed?.update === true && item.incompatible === undefined && <span className="badge ok">有新版</span>}
                    {item.installed?.held === true && <span className="badge" title="回退过：技能库再有更新的版本才会提示">已回退</span>}
                  </div>
                  <span className="muted small">{item.description}</span>
                  {item.changes !== undefined && (item.installed === undefined || item.installed.update) && <span className="muted small hub-changes">{item.version === undefined ? '' : `${item.version}：`}{item.changes}</span>}
                  {item.incompatible !== undefined && <span className="muted small hub-incompatible">{item.installed === undefined ? '' : '新版'}{item.incompatible}</span>}
                  {item.blocked !== undefined && <span className="muted small">{item.blocked}，没有下载（以你已有的为准）</span>}
                </div>
                <div className="hub-actions">
                  {item.installed === undefined && item.blocked === undefined && item.incompatible === undefined && (
                    <button className="primary small-button" disabled={busy !== null} onClick={() => void act(`install:${item.name}`, async () => {
                      await client.connection.call('skillhub/install', { name: item.name, repo: item.repo })
                      return `已下载 ${item.name}，agent 现在就能用`
                    })}>{busy === `install:${item.name}` ? '下载中…' : '下载'}</button>
                  )}
                  {item.installed?.update === true && item.incompatible === undefined && (
                    <button className="primary small-button" disabled={busy !== null} onClick={() => void update(item)}>{busy === `update:${item.name}` ? '更新中…' : '更新'}</button>
                  )}
                  {item.installed?.held === true && item.incompatible === undefined && (
                    <button className="ghost small-button" title="回退过的那个新版本，再换回去" disabled={busy !== null} onClick={() => void update(item)}>{busy === `update:${item.name}` ? '更新中…' : '重新更新'}</button>
                  )}
                  {item.installed?.previous !== undefined && (
                    <button className="ghost small-button" title={`换回上一个版本${item.installed.previous.version === undefined ? '' : ` ${item.installed.previous.version}`}（${relativeTime(item.installed.previous.at, now)}下载的）`}
                      disabled={busy !== null} onClick={() => void act(`rollback:${item.name}`, async () => {
                        const back = await client.connection.call('skillhub/rollback', { name: item.name })
                        return `${item.name} 已回退${back.installed?.version === undefined ? '' : `到 ${back.installed.version}`}；技能库再有新版本时会再提示`
                      })}>{busy === `rollback:${item.name}` ? '回退中…' : '回退'}</button>
                  )}
                  {item.installed !== undefined && (
                    <>
                      <button className="ghost small-button" onClick={() => openSkill(item.name)}>查看</button>
                      <button className="ghost small-button" disabled={busy !== null} onClick={() => void act(`remove:${item.name}`, async () => {
                        await client.connection.call('skillhub/remove', { name: item.name })
                        return `已删除下载的 ${item.name}`
                      })}>删除</button>
                    </>
                  )}
                </div>
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
}

/** 「1.0.0」, or 「1.0.0 → 1.1.0」 when the repository has a newer one. */
function versionLabel(item: HubItem): string | undefined {
  const here = item.installed?.version
  if (item.installed === undefined) return item.version
  if (item.installed.update && item.version !== undefined && item.version !== here) return `${here ?? '旧版'} → ${item.version}`
  return here
}

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
      <div className="key-actions">
        <span className="muted small">别的仓库里的技能会让 agent 照着做，只加你信得过的。</span>
        <span className="spacer" />
        <button className="small-button" disabled={disabled} onClick={() => setText('MultiGameAssistant/skills')}>恢复默认</button>
        <button className="primary small-button" disabled={disabled || !valid} onClick={() => onSave(parsed)}>保存</button>
      </div>
    </div>
  )
}

