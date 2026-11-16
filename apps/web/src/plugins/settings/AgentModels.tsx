/**
 * 设置 → 模型, the part that says which model each agent works with: its own
 * conversation, and the sub-agents it sends to do the concrete work. Nothing
 * has to be set: 助手 uses the default model, any other agent follows it, and
 * sub-agents follow 「所有子 agent」, else the agent that opened them
 * (agent-models.ts on the server). Each choice says what it follows now.
 */
import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { AgentModels, ModelCatalog, ModelSelection } from '@adg/protocol'
import { agentOf, MAIN, useRoles, type Agent } from '../../agents.ts'
import { useModelCatalog, useStore } from '../../hooks.ts'
import { Select, type SelectOption } from '../../components/Select.tsx'

const FOLLOW = ''
const valueOf = (s: ModelSelection | null | undefined) => s == null ? FOLLOW : `${s.provider}/${s.model}`
function parse(value: string): ModelSelection | null {
  if (value === FOLLOW) return null
  const [provider, ...rest] = value.split('/')
  return { provider: provider!, model: rest.join('/') }
}

/** A model's name as its service lists it; its id when no service has it now. */
function nameOf(catalog: ModelCatalog, s: ModelSelection): string {
  return catalog.groups.find(g => g.id === s.provider)?.models.find(m => m.id === s.model)?.name ?? s.model
}

/** Every model, by service; `chosen` listed as unavailable when no service has it now. */
function modelOptions(catalog: ModelCatalog, chosen: ModelSelection | null | undefined): SelectOption[] {
  const known = chosen == null || catalog.groups.some(g => g.id === chosen.provider && g.models.some(m => m.id === chosen.model))
  return [
    ...(known ? [] : [{ value: valueOf(chosen), label: `${chosen!.provider} / ${chosen!.model}`, hint: '不可用：这个模型服务没有配好', disabled: true }]),
    ...catalog.groups.flatMap(g => g.models.map(m => ({ value: `${g.id}/${m.id}`, label: m.name, group: g.name }))),
  ]
}

type Message = { tone: 'ok' | 'warn'; text: string }

export function AgentModelsCard({ client }: { client: AdgClient }) {
  const { catalog, error } = useModelCatalog(client)
  const capabilities = useStore(client.capabilities)
  const status = useStore(client.connection.status)
  const roles = useRoles(client)
  const [models, setModels] = useState<AgentModels | null>(null)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<Message | null>(null)
  const perAgent = capabilities.has('agent-models')

  useEffect(() => {
    if (status.state !== 'open' || !perAgent) return
    let live = true
    client.connection.call('models/agentModels', {}).then(r => { if (live) setModels(r) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, perAgent])
  useEffect(() => client.connection.on('models/agentModelsChanged', setModels), [client])

  const run = async (work: () => Promise<Message>) => {
    setBusy(true)
    setMessage(null)
    try {
      setMessage(await work())
    } catch (e) {
      setMessage({ tone: 'warn', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const setDefault = (value: string) => void run(async () => {
    const chosen = parse(value)!
    await client.connection.call('models/setDefault', chosen)
    return { tone: 'ok', text: `默认模型换成了 ${nameOf(catalog!, chosen)}：助手和跟随默认的 agent 从下一句起用它。` }
  })

  /** `agent` undefined: every sub-agent. */
  const setLayer = (agent: Agent | undefined, sub: boolean, value: string) => void run(async () => {
    const model = parse(value)
    const { warning } = await client.connection.call('models/setAgentModel', { ...(agent === undefined ? {} : { agentId: agent.id }), ...(sub ? { sub: true } : {}), model })
    // The notification brings the same; this keeps the page right if it is late.
    setModels(prev => prev === null ? prev : next(prev, agent?.id, sub, model))
    if (warning !== undefined) return { tone: 'warn', text: warning }
    const name = model === null ? undefined : nameOf(catalog!, model)
    if (!sub) return { tone: 'ok', text: name === undefined ? `「${agent!.name}」改回跟随默认模型，从下一句起生效。` : `「${agent!.name}」的对话从下一句起用 ${name}。` }
    const whose = agent === undefined ? '没单独设的子 agent' : `「${agent.name}」新开的子 agent`
    return { tone: 'ok', text: name === undefined ? `${whose}改回跟随，正在干活的不受影响。` : `${whose}用 ${name}，正在干活的不受影响。` }
  })

  const agents: readonly Agent[] = [MAIN, ...roles.map(agentOf)]
  const ready = catalog !== null && (models !== null || !perAgent)
  return (
    <section className="card">
      <div className="card-head"><div>
        <h3>每个 agent 用的模型</h3>
        <p className="muted small">
          「对话」是 agent 自己做判断、和你说话用的模型；「子 agent」是它派去干具体活（运行命令、截图点击、装脚本）用的模型，活多、看图多，可以选便宜些、能看图的。
          没单独设的会跟着上一级：agent 跟默认模型，子 agent 跟「所有子 agent」，那里也没设就和开它的 agent 用同一个。先在下面的模型服务里填好 Key，这里才能选它的模型。
        </p>
      </div></div>
      {error !== null && <div className="error small">{error}</div>}
      {!ready && error === null && <div className="muted small">读取中…</div>}
      {ready && (
        <div className="agent-models" role="table" aria-label="每个 agent 用的模型">
          <div className="agent-models-row head" role="row">
            <span role="columnheader">agent</span>
            <span role="columnheader">对话</span>
            {perAgent && <span role="columnheader">子 agent</span>}
          </div>
          {perAgent && (
            <div className="agent-models-row all" role="row">
              <div className="agent-models-name" role="cell">
                <strong>所有子 agent</strong>
                <span className="muted small">下面没单独设子 agent 模型的，都用这个</span>
              </div>
              <div className="agent-models-cell empty" role="cell" />
              <div className="agent-models-cell" role="cell">
                <span className="agent-models-cell-label">子 agent</span>
                <Select aria-label="所有子 agent 的模型" value={valueOf(models!.subAgents)} disabled={busy} onChange={v => setLayer(undefined, true, v)} options={[
                  { value: FOLLOW, label: '和开它的 agent 一样' },
                  ...modelOptions(catalog, models!.subAgents),
                ]} />
              </div>
            </div>
          )}
          {agents.map(agent => {
            const main = agent.id === MAIN.id
            const own = main ? catalog.default : models?.agents[agent.id] ?? null
            const working = own ?? catalog.default
            const subOwn = models?.subAgentsOf[agent.id] ?? null
            const subFollows = models?.subAgents == null
              ? `和${agent.name}一样（${nameOf(catalog, working)}）`
              : `跟随上面（${nameOf(catalog, models.subAgents)}）`
            return (
              <div key={agent.id} className="agent-models-row" role="row">
                <div className="agent-models-name" role="cell">
                  <strong>{agent.name}</strong>
                  <span className="muted small">{main ? '它用的就是默认模型' : agent.description}</span>
                </div>
                <div className="agent-models-cell" role="cell">
                  <span className="agent-models-cell-label">对话</span>
                  {main
                    ? <Select aria-label="默认模型（助手）" value={valueOf(own)} disabled={busy || !capabilities.has('model-default')} onChange={setDefault} options={modelOptions(catalog, own)} />
                    : <Select aria-label={`${agent.name}的模型`} value={valueOf(own)} disabled={busy || !perAgent} onChange={v => setLayer(agent, false, v)} options={[
                        { value: FOLLOW, label: `跟随默认（${nameOf(catalog, catalog.default)}）` },
                        ...modelOptions(catalog, own),
                      ]} />}
                </div>
                {perAgent && (
                  <div className="agent-models-cell" role="cell">
                    <span className="agent-models-cell-label">子 agent</span>
                    <Select aria-label={`${agent.name}的子 agent 的模型`} value={valueOf(subOwn)} disabled={busy} onChange={v => setLayer(agent, true, v)} options={[
                      { value: FOLLOW, label: subFollows },
                      ...modelOptions(catalog, subOwn),
                    ]} />
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
      {catalog?.failures.map(f => <div key={f.id} className="error small">{f.name}：{f.message}</div>)}
      {message !== null && <div className={message.tone === 'ok' ? 'muted small' : 'error small'}>{message.text}</div>}
    </section>
  )
}

function next(prev: AgentModels, agentId: string | undefined, sub: boolean, model: ModelSelection | null): AgentModels {
  const put = (record: Readonly<Record<string, ModelSelection>>, key: string) => {
    const { [key]: _old, ...rest } = record
    return model === null ? rest : { ...rest, [key]: model }
  }
  if (!sub) return { ...prev, agents: put(prev.agents, agentId!) }
  return agentId === undefined ? { ...prev, subAgents: model } : { ...prev, subAgentsOf: put(prev.subAgentsOf, agentId) }
}
