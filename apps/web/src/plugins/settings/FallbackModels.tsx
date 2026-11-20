/**
 * 设置 → 模型 → 备用模型: two ordered lists, one for every agent's own
 * conversations and one for every sub-agent. When a model fails with an error
 * another model would not have (余额不足, Key 无效, the model gone, the service
 * still failing after its retries), the agent goes on with the next model of
 * its list and its conversation shows a card saying so (model-fallback.ts on
 * the server).
 */
import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ModelCatalog, ModelFallbacks, ModelSelection } from '@adg/protocol'
import { useModelCatalog, useStore } from '../../hooks.ts'
import { Select, type SelectOption } from '../../components/Select.tsx'
import { Icon } from '../../components/Icons.tsx'

const keyOf = (s: ModelSelection) => `${s.provider}/${s.model}`

function parse(value: string): ModelSelection {
  const [provider, ...rest] = value.split('/')
  return { provider: provider!, model: rest.join('/') }
}

/** A model as the catalog names it: its service and its name; `missing` when no service has it now. */
function describe(catalog: ModelCatalog, s: ModelSelection): { service: string; model: string; missing: boolean } {
  const group = catalog.groups.find(g => g.id === s.provider)
  const model = group?.models.find(m => m.id === s.model)
  return { service: group?.name ?? s.provider, model: model?.name ?? s.model, missing: model === undefined }
}

const LISTS = [
  { sub: false, key: 'agents', title: 'agent 的对话', hint: '助手和各个 agent 自己的对话' },
  { sub: true, key: 'subAgents', title: '子 agent', hint: '派去干具体活的子 agent' },
] as const

export function FallbackModelsCard({ client }: { client: AdgClient }) {
  const { catalog } = useModelCatalog(client)
  const status = useStore(client.connection.status)
  const [fallbacks, setFallbacks] = useState<ModelFallbacks | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('models/agentModels', {}).then(r => { if (live) setFallbacks(r.fallbacks ?? null) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state])
  useEffect(() => client.connection.on('models/agentModelsChanged', r => setFallbacks(r.fallbacks ?? null)), [client])

  if (fallbacks === null || catalog === null) return null

  const save = async (sub: boolean, models: ModelSelection[]) => {
    setBusy(true)
    setError(null)
    const before = fallbacks
    setFallbacks({ ...fallbacks, [sub ? 'subAgents' : 'agents']: models })
    try {
      await client.connection.call('models/setFallbacks', { sub, models })
    } catch (e) {
      setFallbacks(before)
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card">
      <div className="card-head"><div>
        <h3>备用模型</h3>
        <p className="muted small">
          模型报错用不了时（余额不足、Key 失效、模型下线、服务重试后还是出错），agent 自动换成下面的下一个模型接着做，对话里会出现一张卡片，写明换到了哪个服务的哪个模型、因为什么；agent 自己也看得到这张卡片。
          按顺序从出错的那个往下试，试过的不再试；网络断了、对话太长这类换模型也没用的错误不会切换。
        </p>
      </div></div>
      <div className="fallback-lists">
        {LISTS.map(({ sub, key, title, hint }) => {
          const list = fallbacks[key]
          const listed = new Set(list.map(keyOf))
          const options: SelectOption[] = catalog.groups.flatMap(g => g.models
            .filter(m => !listed.has(`${g.id}/${m.id}`))
            .map(m => ({ value: `${g.id}/${m.id}`, label: m.name, group: g.name })))
          const move = (from: number, to: number) => {
            const next = [...list]
            const [item] = next.splice(from, 1)
            next.splice(to, 0, item!)
            void save(sub, next)
          }
          return (
            <div key={key} className="fallback-list">
              <div className="fallback-list-head"><strong>{title}</strong><span className="muted small">{hint}</span></div>
              {list.length === 0
                ? <div className="muted small fallback-empty">没有备用模型：出错就停下，等你处理。</div>
                : (
                  <ol>
                    {list.map((s, i) => {
                      const d = describe(catalog, s)
                      return (
                        <li key={keyOf(s)} className={d.missing ? 'missing' : undefined}>
                          <span className="fallback-order">{i + 1}</span>
                          <span className="fallback-name">
                            <span>{d.model}</span>
                            <span className="muted small">{d.missing ? '不可用：这个模型服务没有配好，会跳过' : d.service}</span>
                          </span>
                          <span className="fallback-actions">
                            <button className="icon-button" aria-label={`把 ${d.model} 往前移`} title="往前移" disabled={busy || i === 0} onClick={() => move(i, i - 1)}><Icon name="arrow" /></button>
                            <button className="icon-button down" aria-label={`把 ${d.model} 往后移`} title="往后移" disabled={busy || i === list.length - 1} onClick={() => move(i, i + 1)}><Icon name="arrow" /></button>
                            <button className="icon-button" aria-label={`去掉 ${d.model}`} title="去掉" disabled={busy} onClick={() => void save(sub, list.filter((_, j) => j !== i))}><Icon name="close" /></button>
                          </span>
                        </li>
                      )
                    })}
                  </ol>
                )}
              <Select
                aria-label={`给${title}添加备用模型`}
                value=""
                placeholder={options.length === 0 ? '没有可以添加的模型' : '添加备用模型…'}
                disabled={busy || options.length === 0}
                options={options}
                onChange={value => void save(sub, [...list, parse(value)])}
              />
            </div>
          )
        })}
      </div>
      {error !== null && <div className="error small">{error}</div>}
    </section>
  )
}
