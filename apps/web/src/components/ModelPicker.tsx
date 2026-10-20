/**
 * Composer model picker: every model the host can serve right now, grouped
 * by service, with the model's thinking levels. A button showing the choice
 * opens a panel: search, models, and the thinking level of the chosen one.
 * In a session the choice applies to its next request; without one (a new
 * conversation not sent yet) it is held by the caller.
 */
import { useEffect, useMemo, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ModelCatalog, ModelSelection } from '@adg/protocol'
import { useModelCatalog, useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'

type CatalogModel = ModelCatalog['groups'][number]['models'][number]

/** Thinking levels in words; unknown ids show as they are. */
const EFFORT: Readonly<Record<string, string>> = {
  off: '不思考', none: '不思考', minimal: '最少', low: '低', medium: '中', high: '高', xhigh: '很高', max: '最大',
}
export const effortLabel = (id: string, name?: string) => EFFORT[id] ?? (name !== undefined && name !== id ? name : id)

function findModel(catalog: ModelCatalog | null, selection: ModelSelection | null): CatalogModel | undefined {
  if (catalog === null || selection === null) return undefined
  return catalog.groups.find(g => g.id === selection.provider)?.models.find(m => m.id === selection.model)
}

export function ModelPicker({ client, sessionId, disabled, value, onChange }: {
  client: AdgClient
  /** The session whose next request this chooses for; absent for a conversation not started yet. */
  sessionId?: string | undefined
  disabled: boolean
  /** Without a session: the held choice (undefined = the default model). */
  value?: ModelSelection | undefined
  onChange?: ((selection: ModelSelection) => void) | undefined
}) {
  const { catalog, error: catalogError } = useModelCatalog(client)
  const models = useStore(client.sessionModels)
  const status = useStore(client.connection.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const box = useRef<HTMLDivElement>(null)

  useEffect(() => {
    if (status.state !== 'open' || sessionId === undefined) return
    client.sessionModel(sessionId).catch(() => { /* a new session may not have a projection yet */ })
  }, [client, sessionId, status.state])

  useEffect(() => {
    if (!open) return
    const close = (e: MouseEvent) => { if (box.current !== null && !box.current.contains(e.target as Node)) setOpen(false) }
    const esc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('mousedown', close)
    document.addEventListener('keydown', esc)
    return () => { document.removeEventListener('mousedown', close); document.removeEventListener('keydown', esc) }
  }, [open])

  const known = sessionId === undefined ? undefined : models.get(sessionId)
  const current: ModelSelection | null = (sessionId === undefined ? value : known?.next ?? known?.lastUsed) ?? catalog?.default ?? null
  const model = findModel(catalog, current)
  const missing = current !== null && catalog !== null && model === undefined

  const choose = async (selection: ModelSelection) => {
    setError(null)
    if (sessionId === undefined) { onChange?.(selection); return }
    setBusy(true)
    try {
      await client.selectModel(sessionId, selection)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const pickModel = (provider: string, m: CatalogModel) => {
    // Keep the thinking level when the new model has it; else its default.
    const effort = current?.reasoningEffort !== undefined && m.efforts.some(e => e.id === current.reasoningEffort) ? current.reasoningEffort : m.defaultEffort
    void choose({ provider, model: m.id, ...(effort === undefined ? {} : { reasoningEffort: effort }) })
    if (m.efforts.length === 0) setOpen(false)
  }

  const groups = useMemo(() => {
    const q = query.trim().toLowerCase()
    return (catalog?.groups ?? [])
      .map(g => ({ ...g, models: g.models.filter(m => q === '' || m.id.toLowerCase().includes(q) || m.name.toLowerCase().includes(q) || g.name.toLowerCase().includes(q)) }))
      .filter(g => g.models.length > 0)
  }, [catalog, query])

  const problems = [error, catalogError, ...(catalog?.failures.map(f => `${f.name}：${f.message}`) ?? [])].filter(Boolean) as string[]

  if (catalog === null) return null
  const effort = current?.reasoningEffort ?? model?.defaultEffort
  const effortName = model?.efforts.find(e => e.id === effort)?.name
  return (
    <div className={`model-picker${error !== null ? ' has-error' : ''}`} ref={box}>
      <button type="button" className="model-trigger" aria-haspopup="dialog" aria-expanded={open} disabled={disabled || busy}
        title={problems.length > 0 ? problems.join('\n') : '选择模型和思考强度'} onClick={() => setOpen(o => !o)}>
        <span className={`model-dot ${missing ? 'off' : ''}`} />
        <span className="model-name">{model?.name ?? (current === null ? '选择模型' : `${current.model}（不可用）`)}</span>
        {effort !== undefined && model !== undefined && model.efforts.length > 0 && <span className="model-effort">{effortLabel(effort, effortName)}</span>}
        <Icon name="chevron-down" />
      </button>
      {open && (
        <div className="model-panel" role="dialog" aria-label="选择模型">
          <input className="text-input plain model-search" autoFocus placeholder="搜索模型" value={query} onChange={e => setQuery(e.target.value)} />
          <div className="model-list" role="listbox" aria-label="模型">
            {groups.length === 0 && <div className="muted small pad">没有匹配的模型</div>}
            {groups.map(group => (
              <div key={group.id} className="model-group">
                <div className="model-group-name">{group.name}</div>
                {group.models.map(m => {
                  const active = current?.provider === group.id && current.model === m.id
                  return (
                    <button key={m.id} type="button" role="option" aria-selected={active} className={`model-option ${active ? 'active' : ''}`} onClick={() => pickModel(group.id, m)}>
                      <span className="model-option-main">
                        <span>{m.name}</span>
                        {m.name !== m.id && <span className="muted small">{m.id}</span>}
                      </span>
                      {m.efforts.length > 0 && <span className="model-tag">思考</span>}
                      {active && <Icon name="check" />}
                    </button>
                  )
                })}
              </div>
            ))}
          </div>
          {model !== undefined && current !== null && (
            <div className="model-efforts">
              <span className="field-label">思考强度</span>
              {model.efforts.length === 0
                ? <span className="muted small">这个模型没有可选的思考强度（在「设置 → 模型」里给模型打开「思考」）</span>
                : (
                  <div className="segmented-control" role="radiogroup" aria-label="思考强度">
                    {model.efforts.map(e => (
                      <button key={e.id} type="button" role="radio" aria-checked={effort === e.id} className={effort === e.id ? 'active' : ''}
                        onClick={() => void choose({ provider: current.provider, model: current.model, reasoningEffort: e.id })}>
                        {effortLabel(e.id, e.name)}
                      </button>
                    ))}
                  </div>
                )}
            </div>
          )}
          {problems.length > 0 && <div className="error small model-problems">{problems.join('；')}</div>}
        </div>
      )}
    </div>
  )
}
