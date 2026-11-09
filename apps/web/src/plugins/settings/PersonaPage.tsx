import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { PeerStyle, Persona, PersonaOverride, PersonaSettings, PersonaStyle } from '@adg/protocol'
import { MAIN, useRoles } from '../../agents.ts'
import { Icon } from '../../components/Icons.tsx'
import { useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

const STYLES: readonly { style: PersonaStyle; title: string; sample: string }[] = [
  { style: 'default', title: '默认', sample: '不加设定，按模型自己的说话方式。' },
  { style: 'concise', title: '简洁干练', sample: '「日常跑完了，3 个成功 1 个失败：MAA 刷理智没体力了。」' },
  { style: 'patient', title: '耐心细致', sample: '「我先帮你看了 MAA 的日志，失败是因为理智不够——这不是脚本坏了，等理智恢复再跑就行。」' },
  { style: 'lively', title: '活泼可爱', sample: '「搞定啦～日常都跑完了！就是理智又见底了 (｡•́︿•̀｡)」' },
  { style: 'buddy', title: '游戏搭子', sample: '「日常清完了，理智又被榨干了哈哈，活动商店还差两样，明天接着肝。」' },
  { style: 'butler', title: '稳重管家', sample: '「今日日常已完成。另有一项需要您决定：活动商店剩余两件，是否明日继续兑换？」' },
]

const PEER_STYLES: readonly { style: PeerStyle; title: string; text: string }[] = [
  { style: 'plain', title: '平实（推荐）', text: '直接说事，不带人设和称呼：它们要读的是内容。' },
  { style: 'same', title: '和对你说话一样', text: '人设也带到 agent 之间的往来里。你在「协作」里看到的就是这个语气。' },
]

/** All agents' settings; otherwise the id of the agent on screen. */
const ALL = ''

/** What following the shared settings means: every field of the voice left out. A name stays, it is the agent's either way. */
function followsAll(own: PersonaOverride | undefined): boolean {
  return own === undefined || (own.style === undefined && own.callUser === undefined && own.custom === undefined && own.peerStyle === undefined)
}

/** 设置 → 回复风格: how agents talk: one setting for all, and any agent's own over it. It never changes what they can do. */
export function PersonaPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const roles = useRoles(client)
  const [settings, setSettings] = useState<PersonaSettings | null>(null)
  const [prompts, setPrompts] = useState<{ all: string; agents: Readonly<Record<string, string>> }>({ all: '', agents: {} })
  const [scope, setScope] = useState(ALL)
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const take = (r: PersonaSettings & { prompt: string; prompts: Record<string, string> }) => {
    setSettings({ persona: r.persona, agents: r.agents })
    setPrompts({ all: r.prompt, agents: r.prompts })
  }

  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('persona/get', {}).then(r => { if (live) take(r) }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state])

  const changed = (next: PersonaSettings) => { setSettings(next); setDirty(true); setSaved(false) }
  const save = async (next = settings) => {
    if (next === null) return
    setBusy(true)
    setError(null)
    try {
      take(await client.connection.call('persona/set', next))
      setDirty(false)
      setSaved(true)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const agents = [{ id: MAIN.id, name: MAIN.name }, ...roles]
  const editAll = (patch: Partial<Persona>) => { if (settings !== null) changed({ ...settings, persona: { ...settings.persona, ...patch } }) }
  const own = settings?.agents[scope]
  const editOwn = (patch: PersonaOverride) => { if (settings !== null) changed({ ...settings, agents: { ...settings.agents, [scope]: { ...own, ...patch } } }) }
  /** Leaves an agent's name where it is. */
  const voiceless = (name: string | undefined): PersonaSettings | null => settings === null ? null : { ...settings, agents: { ...settings.agents, [scope]: name === undefined ? {} : { name } } }
  const separate = scope !== ALL && !followsAll(own)
  const prompt = scope === ALL ? prompts.all : prompts.agents[scope] ?? ''

  return (
    <div className="settings-page persona-page">
      <h2>回复风格</h2>
      <p>agent 说话的方式和人设：可以统一设置，也可以给某个 agent 单独设置。软件里的对话、飞书里的回复、流水线里的 agent 步骤都算。只改说话方式：它们能做什么、该做什么、什么要问你，都不变。子 agent 不用设置，它们只把结果交回给开它们的 agent。</p>
      {settings !== null && (
        <>
          <div className="persona-scope segmented-control" role="tablist" aria-label="设置给谁">
            <button role="tab" aria-selected={scope === ALL} className={scope === ALL ? 'active' : ''} onClick={() => setScope(ALL)}>统一</button>
            {agents.map(a => (
              <button key={a.id} role="tab" aria-selected={scope === a.id} className={scope === a.id ? 'active' : ''} onClick={() => setScope(a.id)}>
                {a.name}{!followsAll(settings.agents[a.id]) && <span className="persona-own-dot" title="有单独设置" />}
              </button>
            ))}
          </div>
          {scope !== ALL && (
            <section className="card">
              <div className="field-row">
                <label className="field">
                  <span className="field-title">它的名字（可选）</span>
                  <input className="text-input plain" maxLength={20} placeholder="例如：小助" value={own?.name ?? ''} onChange={e => editOwn({ name: e.target.value })} />
                  <span className="muted small">它自称时用这个名字；别的 agent 也会知道你这么叫它。</span>
                </label>
              </div>
              <div className="segmented-control persona-follow" role="radiogroup" aria-label="说话方式">
                <button role="radio" aria-checked={!separate} className={!separate ? 'active' : ''} onClick={() => { const next = voiceless(own?.name); if (next !== null && separate) changed(next) }}>跟随统一</button>
                <button role="radio" aria-checked={separate} className={separate ? 'active' : ''} onClick={() => { if (!separate) editOwn({ style: settings.persona.style }) }}>单独设置</button>
              </div>
              {!separate && <p className="muted small">说话方式和「统一」一样：{STYLES.find(s => s.style === settings.persona.style)?.title}。</p>}
            </section>
          )}
          {(scope === ALL || separate) && (
            <Voice
              value={scope === ALL ? settings.persona : { style: own?.style ?? settings.persona.style, callUser: own?.callUser, custom: own?.custom, peerStyle: own?.peerStyle ?? settings.persona.peerStyle }}
              shared={scope === ALL ? undefined : settings.persona}
              onChange={scope === ALL ? editAll : editOwn}
            />
          )}
          <section className="card">
            <div className="persona-actions">
              <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
              {scope === ALL
                ? <button disabled={busy} onClick={() => void save({ ...settings, persona: { style: 'default' } })}>统一设置恢复默认</button>
                : separate && <button disabled={busy} onClick={() => void save(voiceless(own?.name))}>恢复跟随统一</button>}
              {saved && !dirty && <span className="muted small">已保存，下一句回复开始生效。</span>}
            </div>
            {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
          </section>
          <section className="card">
            <h3>{scope === ALL ? '加到 agent 提示词里的内容' : `加到「${agents.find(a => a.id === scope)?.name ?? scope}」提示词里的内容`}</h3>
            {prompt === '' ? <p className="muted small">现在什么都不加。</p> : <pre className="persona-prompt">{prompt}</pre>}
            {dirty && <p className="muted small">保存后更新。</p>}
          </section>
        </>
      )}
      {settings === null && error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}

/**
 * The voice itself, for all agents or for one.
 * @param shared - what is set for all, when this is one agent's: a field left blank follows it.
 */
function Voice({ value, shared, onChange }: { value: Partial<Persona> & { style: PersonaStyle }; shared: Persona | undefined; onChange: (patch: Partial<Persona>) => void }) {
  const peer = value.peerStyle ?? 'plain'
  const following = (text: string | undefined, example: string) => shared === undefined ? example : text === undefined || text === '' ? '留空：和统一一样（现在没有设置）' : `留空：和统一一样（${text}）`
  return (
    <>
      <section className="card">
        <h3>风格</h3>
        <div className="persona-styles" role="radiogroup" aria-label="风格">
          {STYLES.map(s => (
            <button key={s.style} role="radio" aria-checked={value.style === s.style} className={`mode-option persona-style ${value.style === s.style ? 'selected' : ''}`} onClick={() => onChange({ style: s.style })}>
              <strong>{s.title}</strong>
              <span className="muted small">{s.sample}</span>
            </button>
          ))}
        </div>
      </section>
      <section className="card">
        <h3>对你</h3>
        <div className="field-row">
          <label className="field">
            <span className="field-title">怎么称呼你（可选）</span>
            <input className="text-input plain" maxLength={20} placeholder={following(shared?.callUser, '例如：博士、开拓者、指挥官')} value={value.callUser ?? ''} onChange={e => onChange({ callUser: e.target.value })} />
          </label>
        </div>
        <label className="field">
          <span className="field-title">其他要求（可选）</span>
          <textarea className="text-input plain" rows={5} placeholder={following(shared?.custom, '例如：说话带一点罗德岛干员的口吻；汇报时先说有没有失败；不要用表情。')} value={value.custom ?? ''} onChange={e => onChange({ custom: e.target.value })} />
        </label>
      </section>
      <section className="card">
        <h3>对其他 agent</h3>
        <div className="persona-styles" role="radiogroup" aria-label="对其他 agent">
          {PEER_STYLES.map(s => (
            <button key={s.style} role="radio" aria-checked={peer === s.style} className={`mode-option persona-style ${peer === s.style ? 'selected' : ''}`} onClick={() => onChange({ peerStyle: s.style })}>
              <strong>{s.title}</strong>
              <span className="muted small">{s.text}</span>
            </button>
          ))}
        </div>
      </section>
    </>
  )
}
