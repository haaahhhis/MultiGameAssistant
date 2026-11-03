import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { MAX_AGENT_DUTY, MAX_AGENT_NAME, type ModelSelection } from '@adg/protocol'
import { useUserAgents } from '../agents.ts'
import { useModelCatalog, useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'
import { Select } from './Select.tsx'

const DUTY_HINT = '例：你是「日常」agent，每天早上检查各个游戏的脚本昨晚有没有跑完，没跑完的看日志找原因，能重跑就重跑，最后告诉我哪些游戏需要我自己处理。'

/**
 * 新建 agent, or change one the person made (docs/design/agent-roles.md §9.2):
 * its name, its duty — the system prompt it carries every turn, shown in full —
 * the app's tool groups it may use, and its model. Saved, it is in the roster
 * like the plugins' role agents, its tasks under it.
 */
export function AgentEditor({ client, agentId, onSaved, onCancel, onDeleted }: {
  client: AdgClient
  /** null: a new one. */
  agentId: string | null
  onSaved: (agentId: string) => void
  onCancel: () => void
  onDeleted: () => void
}) {
  const status = useStore(client.connection.status)
  const userAgents = useUserAgents(client)
  const { catalog } = useModelCatalog(client)
  const [name, setName] = useState('')
  const [duty, setDuty] = useState('')
  const [tools, setTools] = useState<readonly string[]>(['screen'])
  const [model, setModel] = useState<ModelSelection | null>(null)
  const [filled, setFilled] = useState(agentId === null)
  const [busy, setBusy] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const kept = agentId === null ? undefined : userAgents?.items.find(a => a.id === agentId)
  useEffect(() => {
    if (filled || kept === undefined) return
    setName(kept.name)
    setDuty(kept.duty)
    setTools(kept.tools)
    setModel(kept.model)
    setFilled(true)
  }, [filled, kept])

  if (userAgents === null) return <section className="main empty">{status.state === 'open' ? '读取中…' : '正在连接…'}</section>
  if (agentId !== null && kept === undefined) {
    return <section className="main empty"><span>没有这个 agent，可能已经删掉了。<button className="link-button" onClick={onDeleted}>回到助手</button></span></section>
  }

  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      const { agent } = await client.connection.call('agents/save', { ...(agentId === null ? {} : { id: agentId }), name: name.trim(), duty: duty.trim(), tools: [...tools], model })
      onSaved(agent.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  const remove = async () => {
    if (agentId === null) return
    setBusy(true)
    setError(null)
    try {
      await client.connection.call('agents/delete', { id: agentId })
      onDeleted()
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  const toggle = (id: string, on: boolean) => setTools(prev => (on ? [...prev, id] : prev.filter(t => t !== id)))

  const current = model === null ? '' : `${model.provider}/${model.model}`
  const known = current === '' || (catalog?.groups.some(g => g.models.some(m => `${g.id}/${m.id}` === current)) ?? false)
  const chooseModel = (value: string) => {
    const [provider, ...rest] = value.split('/')
    setModel(value === '' ? null : { provider: provider!, model: rest.join('/') })
  }
  const ready = name.trim() !== '' && duty.trim() !== '' && !busy && status.state === 'open'

  return (
    <section className="main agent-page">
      <header className="welcome-header">
        <span>对话<span className="breadcrumb-divider">/</span><strong>{agentId === null ? '新建 agent' : `编辑 ${kept?.name ?? ''}`}</strong></span>
      </header>
      <div className="agent-page-content agent-editor">
        <label className="field">
          <span className="field-label">名字</span>
          <input className="text-input" value={name} maxLength={MAX_AGENT_NAME} onChange={e => setName(e.target.value)} placeholder="例：日常" autoFocus={agentId === null} />
        </label>

        <label className="field">
          <span className="field-label">职责</span>
          <span className="muted small">它每一轮都会带着这段话：写清楚它做什么、做到哪一步为止、最后要告诉你什么。</span>
          <textarea className="text-input agent-duty-input" value={duty} maxLength={MAX_AGENT_DUTY} rows={9} onChange={e => setDuty(e.target.value)} placeholder={DUTY_HINT} />
        </label>

        <fieldset className="field agent-tools">
          <legend className="field-label">能用本软件的哪些工具</legend>
          {userAgents.groups.map(group => (
            <label key={group.id} className="check-label">
              <input type="checkbox" checked={tools.includes(group.id)} onChange={e => toggle(group.id, e.target.checked)} />
              <span><strong>{group.name}</strong><span className="muted"> · {group.description}</span></span>
            </label>
          ))}
          <span className="muted small">文件、命令、上网这些通用工具每个 agent 都有；没勾的本软件工具它看不到。</span>
        </fieldset>

        <div className="field">
          <span className="field-label">模型</span>
          {catalog === null ? <span className="muted small">读取中…</span> : (
            <Select aria-label="模型" value={current} disabled={busy} onChange={chooseModel} options={[
              { value: '', label: '和角色 agent 一样', hint: '设置 → 模型里的「角色 agent 的模型」' },
              ...(known ? [] : [{ value: current, label: `${model!.provider} / ${model!.model}`, hint: '不可用：这个模型服务没有配好', disabled: true }]),
              ...catalog.groups.flatMap(group => group.models.map(m => ({ value: `${group.id}/${m.id}`, label: m.name, group: group.name }))),
            ]} />
          )}
        </div>

        {error !== null && <div className="error small">{error}</div>}
        <div className="agent-editor-actions">
          {agentId !== null && (confirmDelete
            ? <span className="agent-delete-confirm">
                <span className="small">删掉「{kept?.name}」？它做过的事会留在助手下面。</span>
                <button className="danger" onClick={() => void remove()} disabled={busy}>删除</button>
                <button onClick={() => setConfirmDelete(false)} disabled={busy}>不删</button>
              </span>
            : <button className="danger-outline" onClick={() => setConfirmDelete(true)} disabled={busy}><Icon name="close" />删除</button>)}
          <span className="spacer" />
          <button onClick={onCancel} disabled={busy}>取消</button>
          <button className="primary" onClick={() => void save()} disabled={!ready}>{agentId === null ? '建好' : '保存'}</button>
        </div>
      </div>
    </section>
  )
}
