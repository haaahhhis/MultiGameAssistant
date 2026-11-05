import { useEffect, useMemo, useState } from 'react'
import { MAX_SKILL_NAME, SKILL_NAME, type RequestResult, type ScriptInfo, type SkillInfo } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { desktop } from '../../desktop.ts'
import { useStore } from '../../hooks.ts'
import { errorText, useScriptList } from '../scripts/data.ts'
import { findGame, gameOfScript, placeLabel, placesOf, type GameRef } from '../../skillPlaces.ts'
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
/** Sections folded away in the list, kept for the next visit. */
const FOLDED_KEY = 'adg:skills:folded'

function readFolded(): Set<string> {
  try { return new Set(JSON.parse(localStorage.getItem(FOLDED_KEY) ?? '[]') as string[]) } catch { return new Set() }
}
function writeFolded(folded: ReadonlySet<string>): void {
  try { localStorage.setItem(FOLDED_KEY, JSON.stringify([...folded])) } catch { /* private window: unfolded next time */ }
}
const sectionIcon = (key: string): 'gamepad' | 'package' | 'layers' => (key.startsWith('game:') ? 'gamepad' : key.startsWith('script:') ? 'package' : 'layers')

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
  const [folded, setFolded] = useState(readFolded)
  const [moving, setMoving] = useState(false)
  const fold = (key: string) => setFolded(f => {
    const next = new Set(f)
    if (!next.delete(key)) next.add(key)
    writeFolded(next)
    return next
  })
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
    // Every game and every installed script has its place (a script in its game), so a skill can be added while there is none.
    if (needle === '') {
      for (const game of games) gameSection(game)
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
    setMoving(false)
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
  /** Where it belongs, in words: 明日方舟 · MAA; empty for a general skill. */
  const owners = (skill: SkillInfo) => [...new Set(placesOf(skill.owner, scripts, games).map(placeLabel))]
  const blank = (to: { game?: string; script?: string }): Draft => ({ name: '', description: '', content: '', scripts: to.script === undefined ? [] : [to.script], games: to.script === undefined && to.game !== undefined ? [to.game] : [] })
  const row = (skill: SkillInfo) => (
    <button key={skill.name} className={`script-row skill-row ${draft === null && current?.name === skill.name ? 'active' : ''}`} onClick={() => { setDraft(null); setSelected(skill.name) }}>
      <span className="script-row-main">
        <span className="script-row-name">{skill.name}</span>
        <span className="muted small skills-row-desc">{skill.description}</span>
      </span>
      {skill.removable === true && <span className="skill-row-mark" title="在这里存的：可以编辑和删除"><Icon name="pencil" /></span>}
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
          {skills !== null && needle !== '' && <p className="muted small skills-found">{shown.length === 0 ? '没有匹配的技能。' : `找到 ${shown.length} 个技能`}</p>}
          {skills !== null && needle === '' && shown.length === 0 && <p className="muted small pad">还没有技能。</p>}
          {sections.map(section => {
            // Searching shows every match, folded or not.
            const open = needle !== '' || !folded.has(section.key)
            return (
            <div key={section.key} className={`skills-group ${open ? '' : 'folded'}`}>
              <div className="skills-section-head">
                <button className="skills-fold" aria-expanded={open} onClick={() => fold(section.key)}>
                  <Icon name="chevron-down" className="skills-chevron" />
                  <Icon name={sectionIcon(section.key)} className="skills-section-icon" />
                  <span className="skills-group-name">{section.label}</span>
                  <span className="skills-count">{new Set([...section.items, ...section.subs.flatMap(s => s.items)]).size}</span>
                </button>
                {addButton(section.label, section, section.game !== undefined ? `给游戏「${section.label}」新建一个技能（处理这个游戏的对话都能用）` : section.script !== undefined ? `给「${section.label}」新建一个技能（只给它用）` : '新建一个通用技能')}
              </div>
              {open && <>
              {section.items.map(row)}
              {section.script !== undefined && section.items.length === 0 && <p className="muted small skills-empty">还没有只给它用的技能</p>}
              {section.game !== undefined && section.items.length === 0 && section.subs.length === 0 && <p className="muted small skills-empty">还没有这个游戏的技能</p>}
              {section.subs.map(s => (
                <div key={s.key} className="skills-sub">
                  <div className="skills-sub-label">
                    <Icon name="package" className="skills-section-icon" />
                    <span className="skills-group-name">{s.label}</span><span className="skills-count">{s.items.length}</span>
                    <span className="spacer" />
                    {addButton(s.label, { script: s.script }, `给「${s.label}」新建一个技能（只给它用）`)}
                  </div>
                  {s.items.length === 0 && <p className="muted small skills-empty">还没有只给它用的技能</p>}
                  {s.items.map(row)}
                </div>
              ))}
              </>}
            </div>
            )
          })}
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
                {skills !== null && current === undefined && (
                  <div className="skills-blank">
                    <Icon name="sparkles" />
                    <strong>还没有技能</strong>
                    <span className="muted small">agent 做成一件事后会提议存成技能；也可以自己写一个。</span>
                    <button className="small-button primary" disabled={status.state !== 'open'} onClick={() => setDraft(blank({}))}><Icon name="plus" />新建技能</button>
                  </div>
                )}
                {current !== undefined && (
                  <article className="card skill-card">
                    <header className="skill-top">
                      <div className="skill-title">
                        <h2>{current.name}</h2>
                        <div className="skill-meta">
                          {owners(current).length === 0
                            ? <span className="badge" title="所有对话都看得到、用得了"><Icon name="layers" />通用</span>
                            : <span className="badge warn" title="技能隔离：只有在处理这些游戏或脚本的对话里，agent 才看得到、用得了这个技能"><Icon name={current.owner?.scripts?.length ? 'package' : 'gamepad'} />只给 {owners(current).join('、')} 用</span>}
                          {current.modelInvocable && <span className="badge ok" title="agent 遇到相关的事会自己读这个技能">agent 自动使用</span>}
                          <span className="badge" title={current.removable === true ? '存在这个软件的技能文件夹里，可以编辑和删除' : `在这里不能改和删${current.source === 'hub' ? '，到「技能库」里卸载' : ''}`}>
                            {sourceOf(current)}{current.removable === true ? '' : ' · 只读'}
                          </span>
                        </div>
                      </div>
                      <div className="skill-buttons">
                        {current.userInvocable && (
                          <button className="small-button" onClick={() => copyCommand(current.name)} title="复制后粘贴到对话框，后面写要它做的事">
                            <Icon name={copied ? 'check' : 'copy'} />{copied ? '已复制' : `/${current.name}`}
                          </button>
                        )}
                        {(current.removable === true || current.source === 'hub') && (
                          <button className="small-button" aria-expanded={moving} onClick={() => setMoving(m => !m)} title="放错了游戏或脚本时，换到对的那个">
                            <Icon name="gamepad" />更换游戏和脚本
                          </button>
                        )}
                        {current.removable === true && (
                          <>
                            <button className="small-button" disabled={detail?.name !== current.name}
                              onClick={() => setDraft({ original: current.name, name: current.name, description: current.description, content: detail?.content ?? '', scripts: [...(current.owner?.scripts ?? [])], games: [...(current.owner?.games ?? [])] })}>
                              <Icon name="pencil" />编辑
                            </button>
                            <button className="small-button danger-outline" onClick={() => void remove(current)}>删除</button>
                          </>
                        )}
                        {current.path !== undefined && desktop()?.openPath !== undefined && (
                          <button className="icon-button skill-folder" title={`打开所在文件夹：${current.path}`} aria-label="打开所在文件夹"
                            onClick={() => void desktop()?.openPath?.(current.path!.replace(/[\\/][^\\/]+$/, ''))}>
                            <Icon name="layers" />
                          </button>
                        )}
                      </div>
                    </header>
                    {moving && (
                      <MoveSkill key={current.name} client={client} skill={current} content={detail?.name === current.name ? detail.content : undefined}
                        scripts={scripts} games={games} onCancel={() => setMoving(false)}
                        onMoved={() => { setMoving(false); setError(null); setRevision(r => r + 1) }} />
                    )}
                    <p className="skill-desc">{current.description}</p>
                    {current.whenToUse !== undefined && <p className="muted small">什么时候用：{current.whenToUse}</p>}
                    <section className="skill-body" aria-label="技能内容">
                      <div className="skill-body-label">技能内容</div>
                      {detail?.name === current.name ? <Markdown text={detail.content} /> : <p className="muted">正在读取…</p>}
                    </section>
                    {current.path !== undefined && <code className="muted small skill-path" title={current.path}>{current.path}</code>}
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
      <OwnerFields scripts={scripts} games={games} value={form} onChange={owner => setForm(f => ({ ...f, ...owner }))} />
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
      {hub && <p className="muted small">这是从技能库下载的技能：你选的会一直保留，技能库更新它也不变。</p>}
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
