/**
 * 设置 → 记忆 (memory@1): what the agents remember about the user across
 * conversations — 资料 (lasting facts and preferences) and 日记 (what was done
 * or decided on a day), shared by every agent or one agent's own. The agents
 * write them as they work; here the user reads them, writes one down, changes
 * one, or makes an agent forget it.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { MAX_MEMORY_TEXT, SHARED_MEMORY, type MemoryEntry, type MemoryKind } from '@adg/protocol'
import { MAIN, useRoles } from '../../agents.ts'
import { Icon } from '../../components/Icons.tsx'
import { useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

/** Every entry, whoever reads it. */
const ALL = ''

const KINDS: readonly { kind: MemoryKind; title: string; hint: string }[] = [
  { kind: 'profile', title: '资料', hint: '长期有效的事：怎么称呼你、你的偏好和习惯、设备、约定好的规矩。每条都会放进 agent 的提示词。' },
  { kind: 'journal', title: '日记', hint: '哪天做了什么、定了什么、还剩什么。最近 30 天的放进提示词，更早的 agent 需要时再查。' },
]

function day(iso: string): string {
  const d = new Date(iso)
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

export function MemoryPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const roles = useRoles(client)
  const [items, setItems] = useState<readonly MemoryEntry[] | null>(null)
  const [revision, setRevision] = useState(0)
  const [scope, setScope] = useState(ALL)
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
  const nameOf = (id: string) => id === SHARED_MEMORY ? '共享' : id === 'user' ? '你' : agents.find(a => a.id === id)?.name ?? id
  const words = query.trim().toLowerCase().split(/\s+/).filter(w => w !== '')
  const shown = (items ?? []).filter(e => (scope === ALL || e.scope === scope) && words.every(w => e.text.toLowerCase().includes(w)))
  const count = (id: string) => (items ?? []).filter(e => e.scope === id).length

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
      <p>agent 在对话里记下的关于你的事，新开的对话也记得。「共享」的每个 agent 都看得到，其余的只有那个 agent 自己看得到。agent 会在你说起偏好、纠正它、或者一件事做完时自己记；你也可以在这里记一条、改掉或删掉。密码、验证码、密钥不会被记下。怎么一步步做一件事是另一回事，存在「技能」里。</p>
      {items !== null && (
        <>
          <div className="persona-scope segmented-control" role="tablist" aria-label="谁的记忆">
            <button role="tab" aria-selected={scope === ALL} className={scope === ALL ? 'active' : ''} onClick={() => setScope(ALL)}>全部 {items.length}</button>
            <button role="tab" aria-selected={scope === SHARED_MEMORY} className={scope === SHARED_MEMORY ? 'active' : ''} onClick={() => setScope(SHARED_MEMORY)}>共享 {count(SHARED_MEMORY)}</button>
            {agents.map(a => (
              <button key={a.id} role="tab" aria-selected={scope === a.id} className={scope === a.id ? 'active' : ''} onClick={() => setScope(a.id)}>{a.name} {count(a.id)}</button>
            ))}
          </div>
          <AddMemory agents={agents} scope={scope} onAdd={(kind, to, text) => run(() => client.connection.call('memory/add', { kind, scope: to, text }))} />
          <input className="text-input plain memory-search" type="search" placeholder="搜索记忆（空格分开几个词）" value={query} onChange={e => setQuery(e.target.value)} aria-label="搜索记忆" />
          {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
          {KINDS.map(k => {
            const list = shown.filter(e => e.kind === k.kind)
            return (
              <section key={k.kind} className="card">
                <h3>{k.title} <span className="muted">{list.length}</span></h3>
                <p className="muted small">{k.hint}</p>
                {list.length === 0
                  ? <p className="muted small">{words.length > 0 ? '没有找到。' : '还没有。'}</p>
                  : (
                    <ul className="memory-list">
                      {list.map(entry => (
                        <MemoryRow key={entry.id} entry={entry} nameOf={nameOf}
                          onSave={text => run(() => client.connection.call('memory/update', { id: entry.id, text }))}
                          onForget={() => { if (window.confirm(`忘掉这条记忆？之后 agent 就不记得了，不能撤销。\n\n${entry.text}`)) void run(() => client.connection.call('memory/remove', { id: entry.id })) }} />
                      ))}
                    </ul>
                  )}
              </section>
            )
          })}
        </>
      )}
      {items === null && error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}

function AddMemory({ agents, scope, onAdd }: { agents: readonly { id: string; name: string }[]; scope: string; onAdd: (kind: MemoryKind, scope: string, text: string) => Promise<boolean> }) {
  const [text, setText] = useState('')
  const [kind, setKind] = useState<MemoryKind>('profile')
  const [to, setTo] = useState(SHARED_MEMORY)
  const [busy, setBusy] = useState(false)
  useEffect(() => { if (scope !== ALL) setTo(scope) }, [scope])
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
        <select className="text-input plain memory-scope" value={to} onChange={e => setTo(e.target.value)} aria-label="给谁看">
          <option value={SHARED_MEMORY}>共享：每个 agent 都看得到</option>
          {agents.map(a => <option key={a.id} value={a.id}>只给「{a.name}」</option>)}
        </select>
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
  const date = day(entry.kind === 'journal' ? entry.createdAt : entry.updatedAt)
  return (
    <li className="memory-row">
      {editing === null
        ? <div className="memory-text">{entry.text}</div>
        : <textarea className="text-input plain" rows={2} maxLength={MAX_MEMORY_TEXT} value={editing} onChange={e => setEditing(e.target.value)} aria-label="修改记忆" autoFocus />}
      <div className="memory-meta">
        <span className={`memory-scope-tag ${entry.scope === SHARED_MEMORY ? 'shared' : ''}`}>{nameOf(entry.scope)}</span>
        <span className="muted small">{date} · {entry.by === 'user' ? '你记的' : `${nameOf(entry.by)}记的`}</span>
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
