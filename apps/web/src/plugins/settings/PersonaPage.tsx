/**
 * 设置 → 回复风格 (persona@1): how agents talk — one setting for all of them,
 * and whatever one agent has of its own over it. It never changes what they
 * can do.
 *
 * One card: who is being set (a dropdown, 所有 agent first), the choices on the
 * left, and on the right what they come to — a line said in that style, and the
 * very text that goes into the agent's prompt, written by the same function
 * the host uses (@adg/protocol personaPrompt), so it follows every click before
 * anything is saved. For one agent each field follows what is set for all
 * until it is given its own: there is no separate "follow / own" switch.
 */
import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { personaOf, personaPrompt, type PeerStyle, type Persona, type PersonaOverride, type PersonaSettings, type PersonaStyle } from '@adg/protocol'
import { MAIN, useRoles } from '../../agents.ts'
import { Icon } from '../../components/Icons.tsx'
import { Select } from '../../components/Select.tsx'
import { useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

/** `sample`: the same daily report said in this style; none for the model's own voice. */
const STYLES: readonly { style: PersonaStyle; title: string; note: string; sample: string }[] = [
  { style: 'default', title: '默认', note: '模型自己的说话方式', sample: '' },
  { style: 'concise', title: '简洁干练', note: '先说结论，少寒暄', sample: '日常跑完了，3 个成功 1 个失败：MAA 刷理智没体力了。' },
  { style: 'patient', title: '耐心细致', note: '每一步讲清楚为什么', sample: '我先帮你看了 MAA 的日志，失败是因为理智不够——这不是脚本坏了，等理智恢复再跑就行。' },
  { style: 'lively', title: '活泼可爱', note: '轻松，带点语气词和表情', sample: '搞定啦～日常都跑完了！就是理智又见底了 (｡•́︿•̀｡)' },
  { style: 'buddy', title: '游戏搭子', note: '像一起玩的老朋友', sample: '日常清完了，理智又被榨干了哈哈，活动商店还差两样，明天接着肝。' },
  { style: 'butler', title: '稳重管家', note: '礼貌周到，主动汇报', sample: '今日日常已完成。另有一项需要您决定：活动商店剩余两件，是否明日继续兑换？' },
]

const PEER_STYLES: readonly { style: PeerStyle; title: string; text: string }[] = [
  { style: 'plain', title: '平实', text: '直接说事，不带人设和称呼：它们要读的是内容。推荐。' },
  { style: 'same', title: '和对你一样', text: '人设也带到 agent 之间的往来里，你在「协作」里看到的就是这个语气。' },
]

/** All agents' settings; otherwise the id of the agent on screen. */
const ALL = ''

const titleOf = (style: PersonaStyle) => STYLES.find(s => s.style === style)?.title ?? style

/** What following the shared settings means: every field of the voice left out. A name stays, it is the agent's either way. */
function followsAll(own: PersonaOverride | undefined): boolean {
  return own === undefined || (own.style === undefined && own.callUser === undefined && own.custom === undefined && own.peerStyle === undefined)
}

const fields = (p: PersonaOverride) => [p.style ?? '', p.name?.trim() ?? '', p.callUser?.trim() ?? '', p.custom?.trim() ?? '', p.peerStyle ?? '']

/** Two settings with the same one are saved the same: blanks, spaces and an agent with nothing of its own do not count. */
function fingerprint(s: PersonaSettings): string {
  const agents = Object.entries(s.agents).map(([id, own]) => [id, fields(own)] as const).filter(([, own]) => own.some(v => v !== '')).sort(([a], [b]) => a.localeCompare(b))
  return JSON.stringify([fields({ ...s.persona, peerStyle: s.persona.peerStyle ?? 'plain' }), agents])
}

export function PersonaPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const roles = useRoles(client)
  /** What is saved, and what is on screen. */
  const [stored, setStored] = useState<PersonaSettings | null>(null)
  const [settings, setSettings] = useState<PersonaSettings | null>(null)
  const [scope, setScope] = useState(ALL)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)

  const take = (r: PersonaSettings) => {
    const next = { persona: r.persona, agents: r.agents }
    setStored(next)
    setSettings(next)
  }

  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('persona/get', {}).then(r => { if (live) take(r) }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state])

  if (settings === null || stored === null) {
    return (
      <div className="settings-page persona-page">
        <h2>回复风格</h2>
        {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
      </div>
    )
  }

  const dirty = fingerprint(settings) !== fingerprint(stored)
  const change = (next: PersonaSettings) => { setSettings(next); setSaved(false) }
  const save = async () => {
    setBusy(true)
    setError(null)
    try {
      take(await client.connection.call('persona/set', settings))
      setSaved(true)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const agents = [{ id: MAIN.id, name: MAIN.name }, ...roles.map(r => ({ id: r.id, name: r.name }))]
  const all = scope === ALL
  const shared = settings.persona
  const own = all ? undefined : settings.agents[scope]
  const scopeName = agents.find(a => a.id === scope)?.name ?? scope
  const editAll = (patch: Partial<Persona>) => change({ ...settings, persona: { ...shared, ...patch } })
  /** One agent's own: a field left out or blank goes back to following what is set for all. */
  const editOwn = (patch: { readonly [K in keyof PersonaOverride]?: PersonaOverride[K] | undefined }) => {
    const next = Object.fromEntries(Object.entries({ ...own, ...patch }).filter(([, v]) => v !== undefined && (typeof v !== 'string' || v.trim() !== ''))) as PersonaOverride
    change({ ...settings, agents: { ...settings.agents, [scope]: next } })
  }
  const edit = all ? editAll : editOwn

  // What is on screen comes to this, and what is saved came to that: the lines that differ are marked.
  const voice: Persona & { name?: string } = all ? shared : personaOf(settings, scope)
  const prompt = personaPrompt(voice)
  const before = new Set(personaPrompt(all ? stored.persona : personaOf(stored, scope)).split('\n'))
  const sample = STYLES.find(s => s.style === voice.style)?.sample ?? ''
  const style = all ? shared.style : own?.style
  const peer = all ? shared.peerStyle ?? 'plain' : own?.peerStyle
  const following = (text: string | undefined, example: string) => all ? example : text === undefined || text === '' ? '留空：跟随统一（现在没有设置）' : `留空：跟随统一（${text}）`
  const canReset = all ? fingerprint({ persona: shared, agents: {} }) !== fingerprint({ persona: { style: 'default' }, agents: {} }) : !followsAll(own)
  const reset = () => all
    ? change({ ...settings, persona: { style: 'default' } })
    : change({ ...settings, agents: { ...settings.agents, [scope]: own?.name === undefined ? {} : { name: own.name } } })

  return (
    <div className="settings-page persona-page">
      <h2>回复风格</h2>
      <p>agent 说话的方式和人设：可以统一设置，也可以给某个 agent 单独设置。软件里的对话、飞书里的回复、流水线里的 agent 步骤都算。只改说话方式：它们能做什么、该做什么、什么要问你，都不变。子 agent 不用设置，它们只把结果交回给开它们的 agent。</p>
      <section className="card persona-board">
        <header className="persona-bar">
          <label className="persona-who">
            <span className="field-title">设置给</span>
            <Select className="scope-select" aria-label="设置给谁" value={scope} onChange={setScope} options={[
              { value: ALL, label: '所有 agent', hint: '统一设置' },
              ...agents.map(a => {
                const theirs = settings.agents[a.id]
                const alias = theirs?.name?.trim()
                return { value: a.id, label: alias ? `${a.name}（${alias}）` : a.name, hint: followsAll(theirs) ? '跟随统一' : '有单独设置', group: '只给一个 agent' }
              }),
            ]} />
          </label>
          <span className={`persona-state ${dirty ? 'dirty' : ''}`} role="status">
            {dirty
              ? <><span className="persona-dot" />有没保存的改动</>
              : saved ? <><Icon name="check" />已保存，下一句回复开始生效</> : null}
          </span>
          {dirty && <button disabled={busy} onClick={() => change(stored)}>撤销</button>}
          <button className="primary" disabled={busy || !dirty} onClick={() => void save()}>{busy ? '保存中…' : '保存'}</button>
        </header>
        {error !== null && <div className="notice error left persona-error"><Icon name="alert" /><span>{error}</span></div>}
        <div className="persona-panes">
          <div className="persona-form">
            <div className="field">
              <span className="field-title">风格</span>
              <div className="persona-tiles" role="radiogroup" aria-label="风格">
                {!all && <Tile wide title="跟随统一" note={`现在是「${titleOf(shared.style)}」`} selected={style === undefined} onClick={() => editOwn({ style: undefined })} />}
                {STYLES.map(s => <Tile key={s.style} title={s.title} note={s.note} selected={style === s.style} onClick={() => edit({ style: s.style })} />)}
              </div>
            </div>
            <div className="persona-pair">
              {!all && (
                <label className="field">
                  <span className="field-title">它的名字（可选）</span>
                  <input className="text-input plain" maxLength={20} placeholder="例如：小助" value={own?.name ?? ''} onChange={e => editOwn({ name: e.target.value })}
                    title="它自称时用这个名字；别的 agent 也会知道你这么叫它。" />
                </label>
              )}
              <label className="field">
                <span className="field-title">怎么称呼你（可选）</span>
                <input className="text-input plain" maxLength={20} placeholder={following(shared.callUser, '例如：博士、开拓者、指挥官')}
                  value={(all ? shared.callUser : own?.callUser) ?? ''} onChange={e => edit({ callUser: e.target.value })} />
              </label>
            </div>
            <label className="field">
              <span className="field-title">其他要求（可选）</span>
              <textarea className="text-input plain persona-custom" rows={4} placeholder={following(shared.custom, '例如：说话带一点罗德岛干员的口吻；汇报时先说有没有失败；不要用表情。')}
                value={(all ? shared.custom : own?.custom) ?? ''} onChange={e => edit({ custom: e.target.value })} />
            </label>
            <div className="field">
              <span className="field-title">对其他 agent 说话</span>
              <div className="segmented-control persona-peer" role="radiogroup" aria-label="对其他 agent 说话">
                {!all && <button role="radio" aria-checked={peer === undefined} className={peer === undefined ? 'active' : ''} onClick={() => editOwn({ peerStyle: undefined })}>跟随统一</button>}
                {PEER_STYLES.map(s => <button key={s.style} role="radio" aria-checked={peer === s.style} className={peer === s.style ? 'active' : ''} onClick={() => edit({ peerStyle: s.style })}>{s.title}</button>)}
              </div>
              <span className="muted small">{peer === undefined
                ? `和统一设置一样：${PEER_STYLES.find(s => s.style === (shared.peerStyle ?? 'plain'))?.title}。`
                : PEER_STYLES.find(s => s.style === peer)?.text}</span>
            </div>
            <div className="persona-foot muted small">
              <span>{all ? '没有单独设置的 agent 都按这里的来。' : `没改的地方跟随「所有 agent」的设置。`}</span>
              {canReset && <button className="link-button small" onClick={reset}>{all ? '恢复默认' : '全部改回跟随统一'}</button>}
            </div>
          </div>
          <aside className="persona-preview" aria-label="预览">
            <div className="persona-preview-in">
              <div className="persona-preview-head">
                <strong>预览</strong>
                <span className="muted small">{dirty ? '跟着左边的选择变，保存后生效' : '现在生效的设置'}</span>
              </div>
              <div className="field">
                <span className="field-title">说出来大概这样</span>
                {sample === ''
                  ? <p className="persona-sample none">不加风格，按模型自己的说话方式。</p>
                  : (
                    <div className="persona-sample">
                      <span className="persona-sample-who">{voice.name?.trim() || (all ? 'agent' : scopeName)}</span>
                      <p>{sample}</p>
                    </div>
                  )}
                <span className="muted small">只是「{titleOf(voice.style)}」的示例；实际怎么说，模型照下面这段来。</span>
              </div>
              <div className="field">
                <span className="field-title">{all ? '加到 agent 提示词里的内容' : `加到「${scopeName}」提示词里的内容`}</span>
                {prompt === ''
                  ? <p className="persona-prompt empty-prompt">什么都不加。</p>
                  : <div className="persona-prompt">{prompt.split('\n').map((line, i) => <div key={i} className={before.has(line) ? '' : 'changed'}>{line}</div>)}</div>}
              </div>
            </div>
          </aside>
        </div>
      </section>
    </div>
  )
}

/** One choice of a few: its name, and a few words on what it is. */
function Tile({ title, note, selected, wide, onClick }: { title: string; note: string; selected: boolean; wide?: boolean; onClick: () => void }) {
  return (
    <button role="radio" aria-checked={selected} className={`persona-tile ${selected ? 'selected' : ''} ${wide === true ? 'wide' : ''}`} onClick={onClick}>
      <strong>{title}{selected && <Icon name="check" />}</strong>
      <span className="muted small">{note}</span>
    </button>
  )
}
