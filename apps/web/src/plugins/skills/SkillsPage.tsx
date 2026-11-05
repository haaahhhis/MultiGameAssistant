import { useEffect, useMemo, useState } from 'react'
import { MAX_SKILL_NAME, SKILL_NAME, type RequestResult, type ScriptInfo, type SkillInfo } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { desktop } from '../../desktop.ts'
import { useStore } from '../../hooks.ts'
import { errorText, useScriptList } from '../scripts/data.ts'
import { findGame, gameOfScript, placesOf, type GameRef } from '../../skillPlaces.ts'
import { SkillHubPanel } from './SkillHubPanel.tsx'
import './skills.css'

type Skill = RequestResult<'skills/get'>

/** Where a skill comes from, shown as a badge. */
const SOURCES: readonly { label: string; match: (source: string) => boolean }[] = [
  { label: '本应用自带 · 受保护', match: s => s === 'bundled' },
  { label: '从技能库下载的', match: s => s === 'hub' },
  { label: '脚本包和游戏包', match: s => s === 'custom' },
  { label: '你的技能文件夹', match: s => s.startsWith('user-') },
  { label: '工作文件夹里的', match: s => s.startsWith('project-') },
]

function sourceOf(skill: SkillInfo): string {
  if (skill.removable === true) return '在这里存的'
  return SOURCES.find(g => g.match(skill.source))?.label ?? '其他'
}

/** Skills of one script, inside its game's section; `script` to add one to it. */
interface Sub { key: string; label: string; script: string; items: SkillInfo[] }
/**
 * One section of the list: a game (its own skills, then its scripts'), a script
 * that plays no known game, or the general skills. `game` / `script` to add one to it.
 */
interface Section { key: string; label: string; game?: string; script?: string; items: SkillInfo[]; subs: Sub[] }
const GENERAL = '通用'

/** A skill being made (`original` undefined) or changed. */
interface Draft { original?: string; name: string; description: string; content: string; scripts: string[]; games: string[] }

/**
 * The agent's skills, under the script each belongs to (技能隔离; general ones
 * last): what each is for, whether the agent uses it by itself or it is called
 * with /name, and its instructions. Skills kept in this app's skills folder can
 * be made, changed and deleted here.
 */
export function SkillsPage({ client, arg, openSession }: PageProps) {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  // #/p/skills/hub (or hub:<name>, from the game page) opens the skills repository.
  const [tab, setTab] = useState<'mine' | 'hub'>(arg?.startsWith('hub') === true ? 'hub' : 'mine')
  const focus = arg?.startsWith('hub:') === true ? arg.slice('hub:'.length) : undefined
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>(arg ?? '')
  const [detail, setDetail] = useState<Skill | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [copied, setCopied] = useState(false)
  const [draft, setDraft] = useState<Draft | null>(null)
  const scripts = useScriptList(client).data?.scripts ?? []
  const [games, setGames] = useState<readonly GameRef[]>([])

  useEffect(() => {
    if (arg === undefined) return
    if (arg.startsWith('hub')) setTab('hub')
    else { setTab('mine'); setSelected(arg) }
  }, [arg])
  useEffect(() => client.connection.on('skills/changed', () => setRevision(r => r + 1)), [client])
  // The games, to put each skill under the game it (or its script) belongs to.
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('games')) return
    let live = true
    client.connection.call('games/list', {}).then(r => { if (live) setGames(r.games) }, () => {})
    return () => { live = false }
  }, [client, status.state, capabilities])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('skills/list', {}).then(r => { if (live) { setSkills(r.skills); setError(null) } }, e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, revision, tab])

  const scriptOf = (id: string): ScriptInfo | undefined => scripts.find(s => s.id === id || s.packId === id)
  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => (skills ?? []).filter(s => needle === '' || `${s.name} ${s.description} ${s.whenToUse ?? ''}`.toLowerCase().includes(needle)), [skills, needle])
  const sections = useMemo(() => {
    const byKey = new Map<string, Section>()
    const section = (key: string, label: string, add: { game?: string; script?: string }) => {
      const found = byKey.get(key) ?? { key, label, items: [], subs: [], ...add }
      byKey.set(key, found)
      return found
    }
    const gameSection = (game: { id: string; name: string }) => section(`game:${game.id}`, game.name, { game: game.id })
    const sub = (owner: Section, script: { id: string; name: string }) => {
      const found = owner.subs.find(s => s.script === script.id) ?? { key: `${owner.key}/${script.id}`, label: script.name, script: script.id, items: [] }
      if (!owner.subs.includes(found)) owner.subs.push(found)
      return found
    }
    const add = (list: SkillInfo[], skill: SkillInfo) => { if (!list.includes(skill)) list.push(skill) }
    // Every installed script has its place (in its game), so a skill can be added to it while it has none.
    if (needle === '') {
      for (const script of scripts) {
        const game = gameOfScript(script, games)
        if (game === undefined) section(`script:${script.id}`, script.name, { script: script.id })
        else sub(gameSection(game), script)
      }
    }
    for (const skill of shown) {
      const places = placesOf(skill.owner, scripts, games)
      if (places.length === 0) add(section('general', GENERAL, {}).items, skill)
      for (const place of places) {
        if (place.game !== undefined && place.script !== undefined) add(sub(gameSection(place.game), place.script).items, skill)
        else if (place.game !== undefined) add(gameSection(place.game).items, skill)
        else if (place.script !== undefined) add(section(`script:${place.script.id}`, place.script.name, { script: place.script.id }).items, skill)
      }
    }
    const byName = (a: SkillInfo, b: SkillInfo) => a.name.localeCompare(b.name)
    const order = (s: Section) => (s.key.startsWith('game:') ? 0 : s.key.startsWith('script:') ? 1 : 2)
    return [...byKey.values()]
      .map(s => ({ ...s, items: s.items.sort(byName), subs: s.subs.map(x => ({ ...x, items: x.items.sort(byName) })).sort((a, b) => a.label.localeCompare(b.label)) }))
      .sort((a, b) => order(a) - order(b) || a.label.localeCompare(b.label))
  }, [shown, scripts, games, needle])
  const firstSkill = sections.flatMap(s => [...s.items, ...s.subs.flatMap(x => x.items)])[0]
  const current = shown.find(s => s.name === selected) ?? firstSkill

  useEffect(() => {
    if (current === undefined) { setDetail(null); return }
    let live = true
    setCopied(false)
    client.connection.call('skills/get', { name: current.name }).then(r => { if (live) setDetail(r) }, e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, current?.name, revision])

  const copyCommand = (name: string) => {
    void navigator.clipboard?.writeText(`/${name} `).then(() => setCopied(true), () => {})
  }
  const remove = async (skill: SkillInfo) => {
    if (!confirm(`删除技能「${skill.name}」？它的文件夹会一起删掉，agent 以后就用不到它了。`)) return
    try {
      await client.connection.call('skills/remove', { name: skill.name })
      setSelected('')
      setRevision(r => r + 1)
    } catch (e) {
      setError(errorText(e))
    }
  }
  const owners = (skill: SkillInfo) => [...(skill.owner?.scripts ?? []).map(id => scriptOf(id)?.name ?? id), ...(skill.owner?.games ?? []).map(g => findGame(g, games)?.name ?? g)]
  const blank = (to: { game?: string; script?: string }): Draft => ({ name: '', description: '', content: '', scripts: to.script === undefined ? [] : [to.script], games: to.script === undefined && to.game !== undefined ? [to.game] : [] })
  const row = (skill: SkillInfo) => (
    <button key={skill.name} className={`script-row ${draft === null && current?.name === skill.name ? 'active' : ''}`} onClick={() => { setDraft(null); setSelected(skill.name) }}>
      <span className="script-row-main">
        <span className="script-row-name">{skill.name}</span>
        <span className="muted small skills-row-desc">{skill.description}</span>
      </span>
    </button>
  )
  const addButton = (label: string, to: { game?: string; script?: string }, title: string) => (
    <button className="icon-button skills-add" title={title} aria-label={`在${label}下新建技能`} disabled={status.state !== 'open'} onClick={() => setDraft(blank(to))}>
      <Icon name="plus" />
    </button>
  )

  return (
    <section className="main scripts-page skills-page">
      <header className="page-header">
        <div className="breadcrumb"><span>技能</span><span className="breadcrumb-divider">/</span><h1>{tab === 'hub' ? '技能库' : 'agent 的技能'}</h1></div>
        <div className="page-actions">
          {capabilities.has('skillhub') && (
            <div className="tabs" role="tablist">
              <button role="tab" aria-selected={tab === 'mine'} className={tab === 'mine' ? 'active' : ''} onClick={() => setTab('mine')}>已有的技能</button>
              <button role="tab" aria-selected={tab === 'hub'} className={tab === 'hub' ? 'active' : ''} onClick={() => setTab('hub')}>技能库</button>
            </div>
          )}
          {tab === 'mine' && (
            <button className="small-button" disabled={status.state !== 'open'} onClick={() => setDraft(blank({}))}>
              <Icon name="plus" />新建技能
            </button>
          )}
          {tab === 'mine' && <button className="small-button" onClick={() => setRevision(r => r + 1)}><Icon name="refresh" />刷新</button>}
        </div>
      </header>
      {tab === 'hub' && capabilities.has('skillhub') ? (
        <div className="skill-hub-body"><SkillHubPanel client={client} focus={focus} openSession={openSession} openSkill={name => { setSelected(name); setTab('mine') }} /></div>
      ) : (
      <div className="scripts-body">
        <aside className="scripts-list" aria-label="技能列表">
          <div className="skills-search">
            <Icon name="search" />
            <input className="text-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索技能" aria-label="搜索技能" />
          </div>
          {skills !== null && shown.length === 0 && <p className="muted small pad">{needle === '' ? '还没有技能。' : '没有匹配的技能。'}</p>}
          {sections.map(section => (
            <div key={section.key} className="skills-group">
              <div className="sidebar-label">
                <span className="skills-group-name">{section.label}</span>
                <span className="skills-count">{new Set([...section.items, ...section.subs.flatMap(s => s.items)]).size}</span>
                <span className="spacer" />
                {addButton(section.label, section, section.game !== undefined ? `给游戏「${section.label}」新建一个技能（处理这个游戏的对话都能用）` : section.script !== undefined ? `给「${section.label}」新建一个技能（只给它用）` : '新建一个通用技能')}
              </div>
              {section.items.map(row)}
              {section.script !== undefined && section.items.length === 0 && <p className="muted small skills-empty">还没有只给它用的技能</p>}
              {section.subs.map(s => (
                <div key={s.key} className="skills-sub">
                  <div className="skills-sub-label">
                    <span className="skills-group-name">{s.label}</span><span className="skills-count">{s.items.length}</span>
                    <span className="spacer" />
                    {addButton(s.label, { script: s.script }, `给「${s.label}」新建一个技能（只给它用）`)}
                  </div>
                  {s.items.length === 0 && <p className="muted small skills-empty">还没有只给它用的技能</p>}
                  {s.items.map(row)}
                </div>
              ))}
            </div>
          ))}
        </aside>
        <div className="scripts-detail">
          <div className="script-detail">
            {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
            {draft !== null ? (
              <SkillForm client={client} draft={draft} scripts={scripts} games={games} onCancel={() => setDraft(null)}
                onSaved={name => { setDraft(null); setSelected(name); setError(null); setRevision(r => r + 1) }} />
            ) : (
              <>
                {skills === null && error === null && <p className="muted">正在读取…</p>}
                {current !== undefined && (
                  <article className="card skill-card">
                    <div className="skill-head">
                      <h2>{current.name}</h2>
                      <span className="badge">{sourceOf(current)}</span>
                      {current.modelInvocable && <span className="badge ok" title="agent 遇到相关的事会自己读这个技能">agent 自动使用</span>}
                      {current.userInvocable && <span className="badge" title="在对话里输入 /名字 来用它">可以用 /{current.name} 调用</span>}
                      {current.owner !== undefined && (
                        <span className="badge warn" title="技能隔离：只有在处理这些脚本或游戏的对话里，agent 才看得到、用得了这个技能">
                          只给 {owners(current).join('、')} 用
                        </span>
                      )}
                    </div>
                    <p className="skill-desc">{current.description}</p>
                    {current.whenToUse !== undefined && <p className="muted small">什么时候用：{current.whenToUse}</p>}
                    <div className="skill-actions">
                      {current.userInvocable && <button className="small-button" onClick={() => copyCommand(current.name)}><Icon name="copy" />{copied ? '已复制' : `复制 /${current.name}`}</button>}
                      {current.removable === true && (
                        <>
                          <button className="small-button" disabled={detail?.name !== current.name}
                            onClick={() => setDraft({ original: current.name, name: current.name, description: current.description, content: detail?.content ?? '', scripts: [...(current.owner?.scripts ?? [])], games: [...(current.owner?.games ?? [])] })}>
                            <Icon name="pencil" />编辑
                          </button>
                          <button className="small-button danger-outline" onClick={() => void remove(current)}><Icon name="close" />删除</button>
                        </>
                      )}
                      {current.path !== undefined && (
                        <button className="small-button" title={current.path} disabled={desktop()?.openPath === undefined}
                          onClick={() => void desktop()?.openPath?.(current.path!.replace(/[\\/][^\\/]+$/, ''))}>
                          <Icon name="layers" />打开所在文件夹
                        </button>
                      )}
                      {current.path !== undefined && <code className="muted small skill-path" title={current.path}>{current.path}</code>}
                    </div>
                    {current.removable !== true && <p className="muted small">{sourceOf(current)}的技能在这里不能改和删{current.source === 'hub' ? '，到「技能库」里卸载' : ''}。</p>}
                    <div className="skill-body">
                      {detail?.name === current.name ? <Markdown text={detail.content} /> : <p className="muted">正在读取…</p>}
                    </div>
                  </article>
                )}
              </>
            )}
          </div>
        </div>
      </div>
      )}
    </section>
  )
}

/** Make a skill, or change one kept in this app's skills folder. */
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
  // An owner the script list does not have (removed, or a pack id) stays as it was.
  const unknown = form.scripts.filter(id => !scripts.some(s => s.id === id))
  const unknownGames = form.games.filter(key => findGame(key, games) === undefined)
  const toggle = (id: string) => setForm(f => ({ ...f, scripts: f.scripts.includes(id) ? f.scripts.filter(s => s !== id) : [...f.scripts, id] }))
  const toggleGame = (id: string) => setForm(f => {
    const has = f.games.some(key => key === id || findGame(key, games)?.id === id)
    return { ...f, games: has ? f.games.filter(key => key !== id && findGame(key, games)?.id !== id) : [...f.games, id] }
  })

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      await client.connection.call('skills/save', {
        name: form.name, description: form.description.trim(), content: form.content.trim(),
        ...(form.scripts.length === 0 ? {} : { scripts: form.scripts }),
        ...(form.games.length === 0 ? {} : { games: form.games }),
        ...(editing ? { replace: true } : {}),
      })
      onSaved(form.name)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <article className="card skill-card skill-form">
      <div className="skill-head"><h2>{editing ? `编辑 ${draft.original}` : '新建技能'}</h2></div>
      <label className="field">
        <span className="field-label">名字（在对话里用 /名字 调用它）</span>
        <input className="text-input" value={form.name} disabled={editing} maxLength={MAX_SKILL_NAME} autoFocus={!editing}
          onChange={e => setForm(f => ({ ...f, name: e.target.value.trim().toLowerCase() }))} placeholder="例：maa-daily-check" />
        {form.name !== '' && !nameOk && <span className="error small">只能用小写英文字母、数字和短横线，例如 maa-daily-check</span>}
      </label>
      <fieldset className="field skill-owners">
        <legend className="field-label">给哪个脚本用（只在用这个脚本时才用得上的做法：它的配置、报错、日志）</legend>
        {scripts.length === 0 && unknown.length === 0 && <span className="muted small">还没有装脚本。</span>}
        <div className="skill-owner-list">
          {scripts.map(script => (
            <label key={script.id} className="check-label">
              <input type="checkbox" checked={form.scripts.includes(script.id)} onChange={() => toggle(script.id)} />{script.name}
            </label>
          ))}
          {unknown.map(id => (
            <label key={id} className="check-label">
              <input type="checkbox" checked onChange={() => toggle(id)} />{id}
            </label>
          ))}
        </div>
      </fieldset>
      {(games.length > 0 || unknownGames.length > 0) && (
        <fieldset className="field skill-owners">
          <legend className="field-label">给哪个游戏用（和游戏本身有关、换个脚本也用得上的：游戏里的操作、界面、活动、机制）</legend>
          <div className="skill-owner-list">
            {games.map(game => (
              <label key={game.id} className="check-label">
                <input type="checkbox" checked={form.games.some(key => key === game.id || findGame(key, games)?.id === game.id)} onChange={() => toggleGame(game.id)} />{game.name}
              </label>
            ))}
            {unknownGames.map(key => (
              <label key={key} className="check-label">
                <input type="checkbox" checked onChange={() => toggleGame(key)} />{key}
              </label>
            ))}
          </div>
        </fieldset>
      )}
      <p className="muted small">脚本和游戏都不选就是通用技能，所有对话都能用。</p>
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
