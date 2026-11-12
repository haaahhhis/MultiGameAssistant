/**
 * 设置 → 记忆 (memory@1): what the agents remember about the user across
 * conversations — 资料 (lasting facts and preferences) and 日记 (what was done
 * or decided on a day), shared by every agent or one agent's own. The agents
 * write them as they work, and with 自动整理 on a model reads a quiet
 * conversation back for what they forgot; here the user reads them one agent
 * at a time, newest first by day, writes one down, changes one, or makes an
 * agent forget it.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { MAX_MEMORY_TEXT, SHARED_MEMORY, type MemoryAutoSettings, type MemoryEntry, type MemoryKind } from '@adg/protocol'
import { MAIN, useRoles } from '../../agents.ts'
import { confirm } from '../../components/Dialog.tsx'
import { Icon } from '../../components/Icons.tsx'
import { Select } from '../../components/Select.tsx'
import { useModelCatalog, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

const KINDS: readonly { kind: MemoryKind; title: string }[] = [
  { kind: 'profile', title: '资料' },
  { kind: 'journal', title: '日记' },
]

/** Both kinds. */
const ANY = ''

function day(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

/** When an entry is dated: a journal entry by when it happened, a profile entry by when it was last true. */
const at = (entry: MemoryEntry) => (entry.kind === 'journal' ? entry.createdAt : entry.updatedAt)

export function MemoryPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const roles = useRoles(client)
  const [items, setItems] = useState<readonly MemoryEntry[] | null>(null)
  const [revision, setRevision] = useState(0)
  const [scope, setScope] = useState(SHARED_MEMORY)
  const [kind, setKind] = useState<MemoryKind | typeof ANY>(ANY)
  const [query, setQuery] = useState('')
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
  const shown = (items ?? [])
    .filter(e => e.scope === scope && (kind === ANY || e.kind === kind) && words.every(w => e.text.toLowerCase().includes(w)))
    .sort((a, b) => at(b).localeCompare(at(a)))
  // Newest day first, each day's entries under it.
  const days: { day: string; entries: MemoryEntry[] }[] = []
  for (const entry of shown) {
    const d = day(at(entry))
    if (days.at(-1)?.day === d) days.at(-1)!.entries.push(entry)
    else days.push({ day: d, entries: [entry] })
  }
  const tabs = [{ id: SHARED_MEMORY, name: '共享' }, ...agents]
  const tabName = tabs.find(t => t.id === scope)?.name ?? scope

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

  return (
    <div className="settings-page memory-page">
      <h2>记忆</h2>
      <p>agent 在对话里记下的关于你的事，新开的对话也记得。「共享」的每个 agent 都看得到，其余的只有那个 agent 自己看得到。你也可以在这里记一条、改掉或删掉。密码、验证码、密钥不会被记下。怎么一步步做一件事是另一回事，存在「技能」里。</p>
      {items !== null && (
        <>
          <AutoMemorySettings client={client} />
          <AddMemory agents={agents} scope={scope} onAdd={(k, to, text) => run(() => client.connection.call('memory/add', { kind: k, scope: to, text }))} />
          <section className="card memory-browse">
            <div className="persona-scope segmented-control memory-tabs" role="tablist" aria-label="谁的记忆">
              {tabs.map(t => (
                <button key={t.id} role="tab" aria-selected={scope === t.id} className={scope === t.id ? 'active' : ''} onClick={() => setScope(t.id)}>
                  {t.name}<span className="memory-tab-count">{count(t.id)}</span>
                </button>
              ))}
            </div>
            <div className="memory-filters">
              <div className="segmented-control memory-kind" role="radiogroup" aria-label="种类">
                {[{ kind: ANY, title: '全部' } as const, ...KINDS].map(k => (
                  <button key={k.kind} role="radio" aria-checked={kind === k.kind} className={kind === k.kind ? 'active' : ''} onClick={() => setKind(k.kind)}>{k.title}</button>
                ))}
              </div>
              <input className="text-input plain memory-search" type="search" placeholder="搜索（空格分开几个词）" value={query} onChange={e => setQuery(e.target.value)} aria-label="搜索记忆" />
            </div>
            {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
            {days.length === 0
              ? <p className="muted small">{words.length > 0 || kind !== ANY ? '没有找到。' : `「${tabName}」还没有记忆。`}</p>
              : days.map(group => (
                <div key={group.day} className="memory-day">
                  <h4 className="memory-day-title">{group.day}</h4>
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
    <section className="card">
      <h3>自动整理</h3>
      <label className="check-label">
        <input type="checkbox" checked={on} disabled={busy || settings.forced === true} onChange={e => void save({ ...settings, auto: e.target.checked })} />
        对话停下几分钟后，自动把没记下的偏好和做过的事整理进记忆
      </label>
      {settings.forced === true && <p className="muted small">低上下文模式开着，自动整理会一直开着。</p>}
      {on && (
        <label className="field">
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
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}

function AddMemory({ agents, scope, onAdd }: { agents: readonly { id: string; name: string }[]; scope: string; onAdd: (kind: MemoryKind, scope: string, text: string) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MemoryKind>('profile')
  const [to, setTo] = useState(scope)
  const [busy, setBusy] = useState(false)
  useEffect(() => { setTo(scope) }, [scope])
  const add = async () => {
    setBusy(true)
    if (await onAdd(kind, to, text.trim())) setText('')
    setBusy(false)
  }
  return (
    <section className="card">
      <h3>记一条</h3>
      <textarea className="text-input plain" rows={2} maxLength={MAX_MEMORY_TEXT} placeholder="一句话写一件事，例如：日报只要告诉我有没有失败的；明日方舟只玩 B 服。" value={text} onChange={e => setText(e.target.value)} />
      <div className="memory-add-row">
        <div className="segmented-control memory-kind" role="radiogroup" aria-label="种类">
          {KINDS.map(k => <button key={k.kind} role="radio" aria-checked={kind === k.kind} className={kind === k.kind ? 'active' : ''} onClick={() => setKind(k.kind)}>{k.title}</button>)}
        </div>
        <Select className="memory-scope" aria-label="给谁看" value={to} onChange={setTo} options={[
          { value: SHARED_MEMORY, label: '共享：每个 agent 都看得到' },
          ...agents.map(a => ({ value: a.id, label: `只给「${a.name}」` })),
        ]} />
        <button className="primary" disabled={busy || text.trim() === ''} onClick={() => void add()}>{busy ? '记下中…' : '记下'}</button>
      </div>
    </section>
  )
}

function MemoryRow({ entry, nameOf, onSave, onForget }: { entry: MemoryEntry; nameOf: (id: string) => string; onSave: (text: string) => Promise<boolean>; onForget: () => void }) {
  const [editing, setEditing] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const save = async () => {
    if (editing === null) return
    setBusy(true)
    if (await onSave(editing.trim())) setEditing(null)
    setBusy(false)
  }
  return (
    <li className="memory-row">
      {editing === null
        ? <div className="memory-text">{entry.text}</div>
        : <textarea className="text-input plain" rows={2} maxLength={MAX_MEMORY_TEXT} value={editing} onChange={e => setEditing(e.target.value)} aria-label="修改记忆" autoFocus />}
      <div className="memory-meta">
        <span className={`memory-kind-tag ${entry.kind}`}>{entry.kind === 'profile' ? '资料' : '日记'}</span>
        <time className="muted small" dateTime={at(entry)} title={entry.kind === 'journal' ? '记下的时间' : '最后更新的时间'}>
          {new Date(at(entry)).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' })}
        </time>
        <span className="muted small">{entry.by === 'user' ? '你记的' : entry.by === 'auto' ? '自动整理出来的' : `${nameOf(entry.by)}记的`}</span>
        <span className="memory-actions">
          {editing === null
            ? <>
                <button className="link-button small" onClick={() => setEditing(entry.text)}>修改</button>
                <button className="link-button small memory-forget" onClick={onForget}>忘掉</button>
              </>
            : <>
                <button className="link-button small" disabled={busy} onClick={() => setEditing(null)}>取消</button>
                <button className="small-button primary" disabled={busy || editing.trim() === ''} onClick={() => void save()}>保存</button>
              </>}
        </span>
      </div>
    </li>
  )
}
