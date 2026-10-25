import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { Persona, PersonaStyle } from '@adg/protocol'
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

/** 设置 → 回复风格: how the agent talks, in every conversation (the app, Feishu, pipelines' agent steps). */
export function PersonaPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const [persona, setPersona] = useState<Persona | null>(null)
  const [prompt, setPrompt] = useState('')
  const [dirty, setDirty] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('persona/get', {}).then(r => { if (live) { setPersona(r.persona); setPrompt(r.prompt) } }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state])

  const edit = (patch: Partial<Persona>) => { setPersona(p => (p === null ? p : { ...p, ...patch })); setDirty(true); setSaved(false) }
  const save = async (next = persona) => {
    if (next === null) return
    setBusy(true)
    setError(null)
    try {
      const r = await client.connection.call('persona/set', { persona: next })
      setPersona(r.persona)
      setPrompt(r.prompt)
      setDirty(false)
      setSaved(true)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="settings-page persona-page">
      <h2>回复风格</h2>
      <p>agent 说话的方式和人设，对所有对话都有效：软件里的对话、飞书里的回复、流水线里的 agent 步骤。只改说话方式，不改做事的规则：该确认的照样确认，密码、验证码和付款照样不碰。</p>
      {persona !== null && (
        <>
          <section className="card">
            <h3>风格</h3>
            <div className="persona-styles" role="radiogroup" aria-label="风格">
              {STYLES.map(s => (
                <button key={s.style} role="radio" aria-checked={persona.style === s.style} className={`mode-option persona-style ${persona.style === s.style ? 'selected' : ''}`} onClick={() => edit({ style: s.style })}>
                  <strong>{s.title}</strong>
                  <span className="muted small">{s.sample}</span>
                </button>
              ))}
            </div>
          </section>
          <section className="card">
            <h3>人设</h3>
            <div className="field-row">
              <label className="field">
                <span className="field-title">agent 的名字（可选）</span>
                <input className="text-input plain" maxLength={20} placeholder="例如：小助" value={persona.name ?? ''} onChange={e => edit({ name: e.target.value })} />
              </label>
              <label className="field">
                <span className="field-title">怎么称呼你（可选）</span>
                <input className="text-input plain" maxLength={20} placeholder="例如：博士、开拓者、指挥官" value={persona.callUser ?? ''} onChange={e => edit({ callUser: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span className="field-title">其他要求（可选）</span>
              <textarea className="text-input plain" rows={6} placeholder="例如：说话带一点罗德岛干员的口吻；汇报时先说有没有失败；不要用英文缩写。"
                value={persona.custom ?? ''} onChange={e => edit({ custom: e.target.value })} />
            </label>
            <div className="persona-actions">
              <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
              <button disabled={busy} onClick={() => void save({ style: 'default' })}>恢复默认</button>
              {saved && !dirty && <span className="muted small">已保存，下一句回复开始生效。</span>}
            </div>
            {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
          </section>
          <section className="card">
            <h3>加到 agent 提示词里的内容</h3>
            {prompt === '' ? <p className="muted small">现在是默认风格，什么都不加。</p> : <pre className="persona-prompt">{prompt}</pre>}
            {dirty && <p className="muted small">保存后更新。</p>}
          </section>
        </>
      )}
      {persona === null && error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}
