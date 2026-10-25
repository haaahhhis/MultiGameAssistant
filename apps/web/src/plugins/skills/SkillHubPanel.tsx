/**
 * 技能库: skills for games and scripts, downloaded from the skills
 * repository when the user wants them. Suggested for the games followed and
 * the scripts in the library; a downloaded skill the user changed is never
 * overwritten by an update without their word.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { HubItem, HubRepo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

const KIND: Readonly<Record<HubItem['kind'], string>> = { game: '游戏', script: '脚本', general: '通用' }

export function SkillHubPanel({ client, focus, openSession, openSkill }: {
  client: AdgClient
  /** A skill to show first (a link from the game page). */
  focus?: string | undefined
  openSession: (sessionId: string) => void
  openSkill: (name: string) => void
}) {
  const now = useNow(60_000)
  const capabilities = useStore(client.capabilities)
  const [data, setData] = useState<{ items: HubItem[]; repos: HubRepo[]; errors: string[]; fetchedAt?: number | undefined } | null>(null)
  const [mine, setMine] = useState<{ games: Set<string>; scripts: Set<string> }>({ games: new Set(), scripts: new Set() })
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [diff, setDiff] = useState<{ name: string; mine: string; theirs: string } | null>(null)
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

  const update = (item: HubItem, resolve?: 'keep' | 'replace' | 'merge') => act(`update:${item.name}`, async () => {
    const r = await client.connection.call('skillhub/update', { name: item.name, ...(resolve === undefined ? {} : { resolve }) })
    setDiff(null)
    if (r.state === 'merging' && r.sessionId !== undefined) {
      openSession(r.sessionId)
      return 'agent 正在合并，合并完会写回你的这份技能'
    }
    if (r.state === 'conflict') return '你改过这个技能：选「保留我的」「用新版」或「让 agent 合并」'
    if (r.state === 'kept') return '已保留你的版本，这个新版本不再提示'
    if (r.state === 'updated') return r.backup === undefined ? `${item.name} 已更新` : `${item.name} 已更新，你原来的那份备份在 ${r.backup}`
    return '已是最新'
  })

  return (
    <div className="skill-hub">
      <section className="card skill-hub-head">
        <div className="card-head">
          <div>
            <h3>技能库</h3>
            <p className="muted small">
              游戏和脚本的技能放在 {data?.repos.map(r => r.repo).join('、') ?? 'MultiGameAssistant/skills'}，按需下载；下载的可以改，更新时不会覆盖你的改动。软件自带的核心技能受保护，随软件更新。
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
                    {item.installed?.modified === true && <span className="badge" title="你改过这个技能；更新时不会覆盖">你改过</span>}
                    {item.installed?.update === true && <span className="badge ok">有新版</span>}
                  </div>
                  <span className="muted small">{item.description}</span>
                  {item.blocked !== undefined && <span className="muted small">{item.blocked}，没有下载（以你已有的为准）</span>}
                </div>
                <div className="hub-actions">
                  {item.installed === undefined && item.blocked === undefined && (
                    <button className="primary small-button" disabled={busy !== null} onClick={() => void act(`install:${item.name}`, async () => {
                      await client.connection.call('skillhub/install', { name: item.name, repo: item.repo })
                      return `已下载 ${item.name}，agent 现在就能用`
                    })}>{busy === `install:${item.name}` ? '下载中…' : '下载'}</button>
                  )}
                  {item.installed?.update === true && item.installed.modified !== true && (
                    <button className="primary small-button" disabled={busy !== null} onClick={() => void update(item)}>更新</button>
                  )}
                  {item.installed?.update === true && item.installed.modified === true && (
                    <>
                      <button className="small-button" disabled={busy !== null} onClick={() => void act(`diff:${item.name}`, async () => setDiff({ name: item.name, ...(await client.connection.call('skillhub/diff', { name: item.name })) }))}>看看哪里不同</button>
                      <button className="small-button" disabled={busy !== null} onClick={() => void update(item, 'keep')}>保留我的</button>
                      <button className="small-button" disabled={busy !== null} onClick={() => void update(item, 'replace')}>用新版</button>
                      <button className="primary small-button" disabled={busy !== null} onClick={() => void update(item, 'merge')}>让 agent 合并</button>
                    </>
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
                {diff?.name === item.name && <DiffView mine={diff.mine} theirs={diff.theirs} onClose={() => setDiff(null)} />}
              </li>
            ))}
          </ul>
        </section>
      ))}
    </div>
  )
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

/** The user's version against the repository's, line by line. */
function DiffView({ mine, theirs, onClose }: { mine: string; theirs: string; onClose: () => void }) {
  const lines = useMemo(() => lineDiff(mine.split(/\r?\n/), theirs.split(/\r?\n/)), [mine, theirs])
  return (
    <div className="hub-diff">
      <div className="key-actions">
        <span className="muted small"><span className="diff-del">− 只在你的版本里</span>　<span className="diff-add">+ 只在新版本里</span></span>
        <span className="spacer" />
        <button className="ghost small-button" onClick={onClose}>收起</button>
      </div>
      <pre>{lines.map((l, i) => <div key={i} className={l.kind === '-' ? 'diff-del' : l.kind === '+' ? 'diff-add' : 'muted'}>{l.kind} {l.text}</div>)}</pre>
    </div>
  )
}

/** A plain line diff (longest common subsequence); unchanged runs far from a change are folded. */
export function lineDiff(a: readonly string[], b: readonly string[]): { kind: ' ' | '-' | '+'; text: string }[] {
  const n = a.length
  const m = b.length
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0))
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i]![j] = a[i] === b[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!)
  const out: { kind: ' ' | '-' | '+'; text: string }[] = []
  let i = 0
  let j = 0
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { out.push({ kind: ' ', text: a[i]! }); i++; j++ }
    else if (j < m && (i === n || lcs[i]![j + 1]! >= lcs[i + 1]![j]!)) { out.push({ kind: '+', text: b[j]! }); j++ }
    else { out.push({ kind: '-', text: a[i]! }); i++ }
  }
  // Keep two lines of context around changes.
  const near = (k: number) => out.slice(Math.max(0, k - 2), k + 3).some(l => l.kind !== ' ')
  const folded: { kind: ' ' | '-' | '+'; text: string }[] = []
  for (let k = 0; k < out.length; k++) {
    if (out[k]!.kind !== ' ' || near(k)) folded.push(out[k]!)
    else if (folded.at(-1)?.text !== '…') folded.push({ kind: ' ', text: '…' })
  }
  return folded
}
