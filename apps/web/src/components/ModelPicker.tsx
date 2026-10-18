/**
 * Composer model picker: every model the host can serve right now (DeepSeek
 * and custom APIs), grouped by provider, plus the model's reasoning efforts.
 * The choice applies to the session's next request.
 */
import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ModelCatalog, ModelSelection } from '@adg/protocol'
import { useModelCatalog, useStore } from '../hooks.ts'

const SEP = '\u0000'
const keyOf = (s: { provider: string; model: string }) => `${s.provider}${SEP}${s.model}`

function findModel(catalog: ModelCatalog | null, selection: ModelSelection | null) {
  if (catalog === null || selection === null) return undefined
  return catalog.groups.find(g => g.id === selection.provider)?.models.find(m => m.id === selection.model)
}

export function ModelPicker({ client, sessionId, disabled }: { client: AdgClient; sessionId: string; disabled: boolean }) {
  const { catalog, error: catalogError } = useModelCatalog(client)
  const models = useStore(client.sessionModels)
  const status = useStore(client.connection.status)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status.state !== 'open') return
    client.sessionModel(sessionId).catch(() => { /* a new session may not have a projection yet */ })
  }, [client, sessionId, status.state])

  const known = models.get(sessionId)
  const current: ModelSelection | null = known?.next ?? known?.lastUsed ?? catalog?.default ?? null
  const model = findModel(catalog, current)
  const missing = current !== null && catalog !== null && model === undefined

  const choose = async (selection: ModelSelection) => {
    setBusy(true)
    setError(null)
    try {
      await client.selectModel(sessionId, selection)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  const onModel = (value: string) => {
    const [provider, id] = value.split(SEP) as [string, string]
    const next = catalog?.groups.find(g => g.id === provider)?.models.find(m => m.id === id)
    void choose({ provider, model: id, ...(next?.defaultEffort === undefined ? {} : { reasoningEffort: next.defaultEffort }) })
  }

  const title = useMemo(() => {
    const parts = [error, catalogError, ...(catalog?.failures.map(f => `${f.name}：${f.message}`) ?? [])].filter(Boolean)
    return parts.length === 0 ? '下一次请求使用的模型' : parts.join('\n')
  }, [error, catalogError, catalog])

  if (catalog === null) return null
  return (
    <div className={`model-picker${error !== null ? ' has-error' : ''}`} title={title}>
      <select
        aria-label="模型"
        value={current === null ? '' : keyOf(current)}
        onChange={e => onModel(e.target.value)}
        disabled={disabled || busy}
      >
        {missing && <option value={keyOf(current)}>{current.provider} / {current.model}（不可用）</option>}
        {catalog.groups.map(group => (
          <optgroup key={group.id} label={group.name}>
            {group.models.map(m => <option key={m.id} value={keyOf({ provider: group.id, model: m.id })}>{m.name}</option>)}
          </optgroup>
        ))}
      </select>
      {model !== undefined && model.efforts.length > 0 && current !== null && (
        <select
          aria-label="推理强度"
          value={current.reasoningEffort ?? model.defaultEffort ?? ''}
          onChange={e => void choose({ provider: current.provider, model: current.model, reasoningEffort: e.target.value })}
          disabled={disabled || busy}
        >
          {model.efforts.map(effort => <option key={effort.id} value={effort.id}>{effort.name}</option>)}
        </select>
      )}
      {error !== null && <span className="error small">切换失败</span>}
    </div>
  )
}
