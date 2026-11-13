/**
 * 设置 → 记忆 (memory@1): what the agents remember about the user across
 * conversations — 核心 (the user's core wishes, in every prompt and never
 * pushed out), 资料 (lasting facts and preferences) and 日记 (what was done
 * or decided on a day), shared by every agent or one agent's own. The agents
 * write them as they work, and with 自动整理 on a model reads a quiet
 * conversation back for what they forgot; here the user reads them one agent
 * at a time, newest first by day, writes one down, changes one, or makes an
 * agent forget it.
 *
 * The page reads top to bottom as: the one setting (自动整理), then one card of
 * memories — its head picks whose they are (a dropdown, 共享 first), says who sees
 * them and holds 「记一条」, which writes into the one on screen. 核心 entries are
 * always shared: in 共享 they come first, under a heading of their own, with how
 * much of their room is used.
 */
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react'
import type { AdgClient } from '@adg/client-core'
import { MAX_CORE_CHARS, MAX_MEMORY_TEXT, SHARED_MEMORY, type MemoryAutoSettings, type MemoryEntry, type MemoryKind } from '@adg/protocol'
import { MAIN, useRoles } from '../../agents.ts'
import { confirm } from '../../components/Dialog.tsx'
import { Icon } from '../../components/Icons.tsx'
import { Select } from '../../components/Select.tsx'
import { useModelCatalog, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

const KINDS: readonly { kind: MemoryKind; title: string; hint: string }[] = [
  { kind: 'core', title: '核心', hint: `你最在意的要求和偏好：每个 agent 每次都会带上，不会被挤掉；所有核心一共最多 ${MAX_CORE_CHARS} 字，总是共享` },
  { kind: 'profile', title: '资料', hint: '长期有效的事实和偏好' },
  { kind: 'journal', title: '日记', hint: '某一天做过或决定的事' },
]
const KIND_TITLES: Record<MemoryKind, string> = { core: '核心', profile: '资料', journal: '日记' }

/** Both kinds. */
const ANY = ''

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'] as const

function day(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** A day as its heading reads: 「今天 · 11月13日 周五」, the year only when it is not this one. */
function dayTitle(key: string): string {
  const [y, m, d] = key.split('-').map(Number) as [number, number, number]
  const date = new Date(y, m - 1, d)
  const now = new Date()
  const ago = Math.round((new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime() - date.getTime()) / 86_400_000)
  const text = `${y === now.getFullYear() ? '' : `${y}年`}${m}月${d}日 ${WEEKDAYS[date.getDay()]}`
  return ago === 0 ? `今天 · ${text}` : ago === 1 ? `昨天 · ${text}` : text
}

/** When an entry is dated: a journal entry by when it happened, a profile entry by when it was last true. */
const at = (entry: MemoryEntry) => (entry.kind === 'journal' ? entry.createdAt : entry.updatedAt)

/** Ctrl/⌘+Enter confirms what is being written, Esc drops it. */
const writingKeys = (confirmIt: () => void, drop: () => void) => (e: KeyboardEvent) => {
  if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); confirmIt() }
  else if (e.key === 'Escape') { e.preventDefault(); drop() }
}

export function MemoryPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const roles = useRoles(client)
  const [items, setItems] = useState<readonly MemoryEntry[] | null>(null)
  const [revision, setRevision] = useState(0)
  const [scope, setScope] = useState(SHARED_MEMORY)
  const [kind, setKind] = useState<MemoryKind | typeof ANY>(ANY)
  const [query, setQuery] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => client.connection.on('memory/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('memory/list', {}).then(r => { if (live) { setItems(r.items); setError(null) } }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, revision])

  const agents = useMemo(() => [{ id: MAIN.id, name: MAIN.name }, ...roles.map(r => ({ id: r.id, name: r.name }))], [roles])
  const nameOf = (id: string) => id === SHARED_MEMORY ? '共享' : id === 'user' ? '你' : id === 'auto' ? '自动整理' : agents.find(a => a.id === id)?.name ?? id
  const words = query.trim().toLowerCase().split(/\s+/).filter(w => w !== '')
  const count = (id: string) => (items ?? []).filter(e => e.scope === id).length
  const mine = (items ?? []).filter(e => e.scope === scope)
  const coreUsed = (items ?? []).filter(e => e.kind === 'core').reduce((sum, e) => sum + e.text.length, 0)
  const shown = mine
    .filter(e => (kind === ANY || e.kind === kind) && words.every(w => e.text.toLowerCase().includes(w)))
    .sort((a, b) => at(b).localeCompare(at(a)))
  // The core entries first, on their own; then newest day first, each day's entries under it.
  const core = shown.filter(e => e.kind === 'core')
  const days: { day: string; entries: MemoryEntry[] }[] = []
  for (const entry of shown.filter(e => e.kind !== 'core')) {
    const d = day(at(entry))
    if (days.at(-1)?.day === d) days.at(-1)!.entries.push(entry)
    else days.push({ day: d, entries: [entry] })
  }
  const tabs = [{ id: SHARED_MEMORY, name: '共享' }, ...agents]
  const tabName = tabs.find(t => t.id === scope)?.name ?? scope
  const shared = scope === SHARED_MEMORY
  const filtered = words.length > 0 || kind !== ANY

  const run = async (action: () => Promise<unknown>): Promise<boolean> => {
    setError(null)
    try {
      await action()
      setRevision(r => r + 1)
      return true
    } catch (e) {
      setError(errorText(e))
      return false
    }
  }
  const add = async (k: MemoryKind, text: string): Promise<boolean> => {
    // A core entry is everyone's.
    const to = k === 'core' ? SHARED_MEMORY : scope
    if (!await run(() => client.connection.call('memory/add', { kind: k, scope: to, text }))) return false
    // The new one is on screen: in its memory, not filtered away by the other kind or a search.
    if (to !== scope) setScope(to)
    if (kind !== ANY && kind !== k) setKind(ANY)
    setQuery('')
    setAdding(false)
    return true
  }

  return (
    <div className="settings-page memory-page">
      <h2>记忆</h2>
      <p>agent 在对话里记下的关于你的事，新开的对话也记得。「共享」的每个 agent 都看得到，其余的只有那个 agent 自己看得到。「核心」是你最在意的要求和偏好，每个 agent 每次都会带上，不会因为记得多了或时间久了被挤掉；只有你自己（或你明确让 agent 记）才会写进去。你也可以在这里记一条、改掉或删掉。密码、验证码、密钥不会被记下。怎么一步步做一件事是另一回事，存在「技能」里。</p>
      {items !== null && (
        <>
          <AutoMemorySettings client={client} />
          <section className="card memory-browse">
            <div className="card-head memory-head">
              <div className="memory-whose">
                <Select className="scope-select" aria-label="谁的记忆" value={scope} onChange={setScope} options={tabs.map(t => ({
                  value: t.id,
                  label: t.id === SHARED_MEMORY ? '共享的记忆' : `「${t.name}」的记忆`,
                  hint: count(t.id) === 0 ? '还没有' : `${count(t.id)} 条`,
                  ...(t.id === SHARED_MEMORY ? {} : { group: '一个 agent 自己的' }),
                }))} />
                <span className="muted small">{shared ? '每个 agent 都看得到' : `只有「${tabName}」自己看得到`}</span>
              </div>
              {!adding && <button className="small-button" onClick={() => setAdding(true)}><Icon name="plus" />记一条</button>}
            </div>
            {adding && <AddMemory to={shared ? '共享' : `「${tabName}」`} coreUsed={coreUsed} onAdd={add} onClose={() => setAdding(false)} />}
            {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
            {mine.length > 0 && (
              <div className="memory-filters">
                <div className="memory-kinds" role="radiogroup" aria-label="种类">
                  {[{ kind: ANY, title: '全部' } as const, ...KINDS].map(k => (
                    <button key={k.kind} role="radio" aria-checked={kind === k.kind} className={`filter-chip ${kind === k.kind ? 'active' : ''}`} onClick={() => setKind(k.kind)}>
                      {k.title}<span className="memory-kind-count">{k.kind === ANY ? mine.length : mine.filter(e => e.kind === k.kind).length}</span>
                    </button>
                  ))}
                </div>
                <label className="memory-search">
                  <Icon name="search" />
                  <input className="text-input plain" type="search" placeholder="搜索（空格分开几个词）" value={query} onChange={e => setQuery(e.target.value)} aria-label="搜索记忆" />
                </label>
              </div>
            )}
            {core.length > 0 && (
              <div className="memory-day memory-core">
                <h4 className="memory-day-title"><span>核心 · 每次都带上（{coreUsed} / {MAX_CORE_CHARS} 字）</span></h4>
                <ul className="memory-list">
                  {core.map(entry => (
                    <MemoryRow key={entry.id} entry={entry} nameOf={nameOf}
                      onSave={text => run(() => client.connection.call('memory/update', { id: entry.id, text }))}
                      onForget={() => void confirm({ title: '删掉这条核心记忆？', message: '之后 agent 就不会每次都带上它了，不能撤销。', quote: entry.text, confirmLabel: '删掉', danger: true })
                        .then(ok => { if (ok) void run(() => client.connection.call('memory/remove', { id: entry.id })) })} />
                  ))}
                </ul>
              </div>
            )}
            {days.length === 0 && core.length === 0
              ? (
                <div className="memory-empty">
                  <p className="muted">{filtered ? '没有找到。' : `「${tabName}」还没有记忆。`}</p>
                  {filtered
                    ? <button className="link-button small" onClick={() => { setKind(ANY); setQuery('') }}>清除筛选</button>
                    : <p className="muted small">agent 干活时会自己记下，你也可以点「记一条」写给它。</p>}
                </div>
              )
              : days.map(group => (
                <div key={group.day} className="memory-day">
                  <h4 className="memory-day-title"><span>{dayTitle(group.day)}</span></h4>
                  <ul className="memory-list">
                    {group.entries.map(entry => (
                      <MemoryRow key={entry.id} entry={entry} nameOf={nameOf}
                        onSave={text => run(() => client.connection.call('memory/update', { id: entry.id, text }))}
                        onForget={() => void confirm({ title: '忘掉这条记忆？', message: '之后 agent 就不记得了，不能撤销。', quote: entry.text, confirmLabel: '忘掉', danger: true })
                          .then(ok => { if (ok) void run(() => client.connection.call('memory/remove', { id: entry.id })) })} />
                    ))}
                  </ul>
                </div>
              ))}
          </section>
        </>
      )}
      {items === null && error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}

/**
 * 自动整理: once a conversation has been quiet for a few minutes, a model reads
 * what you said there and keeps what the agent forgot to. On by default; the
 * model is the default one unless another is chosen (a cheaper one saves usage).
 */
function AutoMemorySettings({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const { catalog } = useModelCatalog(client)
  const [settings, setSettings] = useState<(MemoryAutoSettings & { forced?: boolean | undefined }) | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('memory/auto/get', {}).then(r => { if (live) { setSettings(r); setError(null) } }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state])
  const save = async (next: MemoryAutoSettings) => {
    setBusy(true)
    setError(null)
    try {
      const saved = await client.connection.call('memory/auto/set', { auto: next.auto, model: next.model })
      setSettings({ ...saved, ...(settings?.forced === true ? { forced: true } : {}) })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  if (settings === null) return error === null ? null : <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>
  const on = settings.auto || settings.forced === true
  const current = settings.model === null ? '' : `${settings.model.provider}/${settings.model.model}`
  const known = current === '' || (catalog?.groups.some(g => g.models.some(m => `${g.id}/${m.id}` === current)) ?? false)
  const choose = (value: string) => {
    const [provider, ...rest] = value.split('/')
    void save({ ...settings, model: value === '' ? null : { provider: provider!, model: rest.join('/') } })
  }
  return (
    <section className="card memory-auto">
      <div className="memory-auto-row">
        <label className="check-label memory-auto-check">
          <input type="checkbox" checked={on} disabled={busy || settings.forced === true} onChange={e => void save({ ...settings, auto: e.target.checked })} />
          <span className="memory-auto-text">
            <strong>自动整理</strong>
            <span className="muted small">对话停下几分钟后，自动把没记下的偏好和做过的事整理进记忆{settings.forced === true ? '。低上下文模式开着，自动整理会一直开着。' : ''}</span>
          </span>
        </label>
        {on && (
          <label className="field memory-auto-model">
            <span className="field-title">整理用的模型</span>
            {catalog === null ? <span className="muted small">读取中…</span> : (
              <Select aria-label="整理用的模型" value={current} disabled={busy} onChange={choose} options={[
                { value: '', label: '和默认模型一样' },
                ...(known ? [] : [{ value: current, label: `${settings.model!.provider} / ${settings.model!.model}`, hint: '不可用：这个模型服务没有配好', disabled: true }]),
                ...catalog.groups.flatMap(group => group.models.map(model => ({ value: `${group.id}/${model.id}`, label: model.name, group: group.name }))),
              ]} />
            )}
          </label>
        )}
      </div>
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}

/**
 * Writing one down, opened by 「记一条」: it goes to whose memories are on screen.
 * @param to - whose memory that is, as the button says it.
 */
function AddMemory({ to, coreUsed, onAdd, onClose }: { to: string; coreUsed: number; onAdd: (kind: MemoryKind, text: string) => Promise<boolean>; onClose: () => void }) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MemoryKind>('profile')
  const [busy, setBusy] = useState(false)
  const coreLeft = MAX_CORE_CHARS - coreUsed
  const tooLong = kind === 'core' && text.trim().length > coreLeft
  const ready = !busy && text.trim() !== '' && !tooLong
  const add = async () => {
    if (!ready) return
    setBusy(true)
    await onAdd(kind, text.trim())
    setBusy(false)
  }
  return (
    <div className="memory-compose">
      <textarea className="text-input plain" rows={3} maxLength={MAX_MEMORY_TEXT} autoFocus aria-label="要记下的事"
        placeholder="一句话写一件事，例如：日报只要告诉我有没有失败的；明日方舟只玩 B 服。"
        value={text} onChange={e => setText(e.target.value)} onKeyDown={writingKeys(() => void add(), onClose)} />
      <div className="memory-compose-foot">
        <div className="segmented-control memory-kind" role="radiogroup" aria-label="种类">
          {KINDS.map(k => <button key={k.kind} role="radio" aria-checked={kind === k.kind} className={kind === k.kind ? 'active' : ''} onClick={() => setKind(k.kind)}>{k.title}</button>)}
        </div>
        <span className={`small memory-compose-hint ${tooLong ? 'warn-text' : 'muted'}`}>
          {KINDS.find(k => k.kind === kind)?.hint}
          {kind === 'core' && (tooLong ? `。核心只剩 ${Math.max(0, coreLeft)} 字了：先合并或删掉几条，或记成资料。` : `（还能写 ${coreLeft} 字）`)}
        </span>
        <span className="memory-compose-actions">
          <button disabled={busy} onClick={onClose}>取消</button>
          <button className="primary" disabled={!ready} onClick={() => void add()}>{busy ? '记下中…' : kind === 'core' ? '记成核心' : `记到${to}`}</button>
        </span>
      </div>
    </div>
  )
}

function MemoryRow({ entry, nameOf, onSave, onForget }: { entry: MemoryEntry; nameOf: (id: string) => string; onSave: (text: string) => Promise<boolean>; onForget: () => void }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const ready = !busy && editing !== null && editing.trim() !== ''
  const save = async () => {
    if (!ready) return
    setBusy(true)
    if (await onSave(editing.trim())) setEditing(null)
    setBusy(false)
  }
  return (
    <li className={`memory-row ${editing === null ? '' : 'editing'}`}>
      <time className="memory-time" dateTime={at(entry)} title={entry.kind === 'journal' ? '记下的时间' : '最后更新的时间'}>
        {new Date(at(entry)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}
      </time>
      <div className="memory-body">
        {editing === null
          ? <div className="memory-text">{entry.text}</div>
          : <textarea className="text-input plain" rows={3} maxLength={MAX_MEMORY_TEXT} value={editing} onChange={e => setEditing(e.target.value)} onKeyDown={writingKeys(() => void save(), () => setEditing(null))} aria-label="修改记忆" autoFocus />}
        <div className="memory-meta">
          <span className={`memory-kind-tag ${entry.kind}`}>{KIND_TITLES[entry.kind]}</span>
          <span className="muted small">{entry.by === 'user' ? '你记的' : entry.by === 'auto' ? '自动整理出来的' : `${nameOf(entry.by)}记的`}</span>
          {editing !== null && (
            <span className="memory-edit-actions">
              <button className="small-button" disabled={busy} onClick={() => setEditing(null)}>取消</button>
              <button className="small-button primary" disabled={!ready} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
            </span>
          )}
        </div>
      </div>
      {editing === null && (
        <span className="memory-actions">
          <button className="link-button small" onClick={() => setEditing(entry.text)}>修改</button>
          <button className="link-button small memory-forget" onClick={onForget}>忘掉</button>
        </span>
      )}
    </li>
  )
}
