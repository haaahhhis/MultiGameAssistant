import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { CredentialInfo, ModelSelection } from '@adg/protocol'
import { useModelCatalog, useStore } from '../../hooks.ts'
import { ProvidersSection } from '../providers/ProvidersPage.tsx'
import { Select } from '../../components/Select.tsx'

const SOURCE_LABEL: Record<string, string> = {
  file: 'dsh 凭据文件',
  env: '启动环境变量',
  'project-env': '项目 .env 文件',
  'user-env': 'dsh 主目录 .env 文件',
}

/** Same rules as dsh's own Models page: printable ASCII, no spaces, not a pasted NAME=value or quoted string. */
export function apiKeyProblem(draft: string): string | null {
  const value = draft.trim()
  if (draft.length > 0 && value.length === 0) return 'API Key 不能只包含空白字符。'
  if (value === '') return null
  if (/^[A-Z][A-Z0-9_]*=[^=]/.test(value)) return '看起来粘贴了 "名称=值" 的整行，请只粘贴 Key 本身。'
  if (/^(["'`]).+\1$/.test(value)) return '请去掉 Key 两侧的引号。'
  if (!/^[\x21-\x7E]+$/.test(value)) return 'API Key 只能包含可见的 ASCII 字符，不能有空格或中文。'
  return null
}

/** Models in one place: the default model, the role agents' model, every model service with its key and models. */
export function ApiKeysPage({ client }: { client: AdgClient }) {
  const capabilities = useStore(client.capabilities)
  return (
    <div className="settings-page">
      <h2>模型</h2>
      <p className="muted">
        agent 用哪个模型、接哪些模型服务都在这里。保存后立即生效；新对话和飞书对话默认用下面选的模型，软件自己开的会话（干预、游戏等）可以另选一个；每个对话也可以在输入框旁边单独换。
      </p>
      <DefaultModel client={client} />
      {capabilities.has('role-model') && <RoleAgentModel client={client} />}
      {capabilities.has('providers') && <ProvidersSection client={client} />}
    </div>
  )
}

/** Set, replace or remove one credential; never shows a stored value. */
export function CredentialCard({ client, refName, title, description, helpUrl, info, placeholder, bare = false }: {
  client: AdgClient
  refName: string
  title: string
  description: string
  helpUrl?: string
  info: CredentialInfo | null
  /** Input hint while nothing is configured. */
  placeholder?: string
  /** Just the form, inside another card. */
  bare?: boolean
}) {
  const [draft, setDraft] = useState('')
  const [reveal, setReveal] = useState(false)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null)
  const problem = apiKeyProblem(draft)
  const readOnly = info !== null && !info.writable

  const save = async () => {
    if (draft.trim() === '' || problem !== null) return
    setBusy(true)
    setMessage(null)
    try {
      await client.setCredential(refName, draft.trim())
      setDraft('')
      setReveal(false)
      setMessage({ tone: 'ok', text: '已保存，立即生效。' })
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const remove = async () => {
    if (!window.confirm(`确定要删除已保存的 ${title} 吗？删除后需要重新填写才能使用对应模型。`)) return
    setBusy(true)
    setMessage(null)
    try {
      await client.unsetCredential(refName)
      setMessage({ tone: 'ok', text: '已删除。' })
    } catch (e) {
      setMessage({ tone: 'error', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }

  const Wrapper = bare ? 'div' : 'section'
  return (
    <Wrapper className={bare ? 'credential-inline' : 'card'}>
      {!bare && (
        <div className="card-head">
          <div>
            <h3>{title}</h3>
            <div className="muted small">{description} <code>{refName}</code></div>
          </div>
          <CredentialBadge info={info} />
        </div>
      )}
      {readOnly
        ? (
          <div className="notice info left">
            当前 Key 来自{SOURCE_LABEL[info.source ?? ''] ?? info.source}，优先级高于界面保存的值，因此这里无法修改。
            如需在界面中管理，请先从启动 dsh 的环境中移除 <code>{refName}</code> 再重新启动。
          </div>
        )
        : (
          <form className="key-form" onSubmit={e => { e.preventDefault(); void save() }}>
            <div className="key-input">
              <input
                type={reveal ? 'text' : 'password'}
                value={draft}
                onChange={e => { setDraft(e.target.value); setMessage(null) }}
                placeholder={info?.configured === true ? '已配置。输入新的 Key 可替换' : placeholder ?? '粘贴你的 API Key（sk-…）'}
                autoComplete="off"
                spellCheck={false}
                aria-label={title}
                disabled={busy}
              />
              <button type="button" className="ghost" onClick={() => setReveal(r => !r)} disabled={draft === ''}>
                {reveal ? '隐藏' : '显示'}
              </button>
            </div>
            {problem !== null && <div className="error small">{problem}</div>}
            <div className="key-actions">
              {helpUrl !== undefined && <a href={helpUrl} target="_blank" rel="noopener noreferrer" className="small">获取 API Key ↗</a>}
              <span className="spacer" />
              {info?.configured === true && info.source === 'file' && (
                <button type="button" className="danger-outline" onClick={() => void remove()} disabled={busy}>删除</button>
              )}
              <button type="submit" className="primary" disabled={busy || draft.trim() === '' || problem !== null}>
                {busy ? '保存中…' : info?.configured === true ? '替换' : '保存'}
              </button>
            </div>
          </form>
        )}
      {message !== null && <div className={message.tone === 'ok' ? 'success small' : 'error small'}>{message.text}</div>}
    </Wrapper>
  )
}

function CredentialBadge({ info }: { info: CredentialInfo | null }) {
  if (info === null) return <span className="badge">读取中…</span>
  if (!info.configured) return <span className="badge warn">未配置</span>
  return <span className="badge ok">已配置 · {SOURCE_LABEL[info.source ?? ''] ?? info.source ?? '未知来源'}</span>
}

/** The model new sessions use, chosen from every service's models; refreshed after every key or service change. */
function DefaultModel({ client }: { client: AdgClient }) {
  const { catalog, error } = useModelCatalog(client)
  const capabilities = useStore(client.capabilities)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const current = catalog === null ? '' : `${catalog.default.provider}/${catalog.default.model}`
  const choose = async (value: string) => {
    const [provider, ...rest] = value.split('/')
    setBusy(true)
    setMessage(null)
    try {
      await client.connection.call('models/setDefault', { provider: provider!, model: rest.join('/') })
      setMessage('已设为默认，新对话会用它。')
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const known = catalog?.groups.some(g => g.models.some(m => `${g.id}/${m.id}` === current)) ?? false
  return (
    <section className="card">
      <div className="card-head"><div><h3>默认模型</h3><p className="muted small">先在下面的模型服务里填好 Key，这里就能选它的模型。</p></div></div>
      {error !== null && <div className="error small">{error}</div>}
      {catalog === null && error === null && <div className="muted small">读取中…</div>}
      {catalog !== null && (
        <Select aria-label="默认模型" value={current} disabled={busy || !capabilities.has('model-default')} onChange={next => void choose(next)} options={[
          ...(known ? [] : [{ value: current, label: `${catalog.default.provider} / ${catalog.default.model}`, hint: '不可用：这个模型服务没有配好', disabled: true }]),
          ...catalog.groups.flatMap(group => group.models.map(model => ({ value: `${group.id}/${model.id}`, label: model.name, group: group.name }))),
        ]} />
      )}
      {catalog?.failures.map(f => <div key={f.id} className="error small">{f.name}：{f.message}</div>)}
      {message !== null && <div className="muted small">{message}</div>}
    </section>
  )
}

/**
 * The model role agents' sessions are created with (干预, 游戏, 脚本, 编排):
 * a cheaper one for their screenshots, logs and clicks, while your own
 * conversations keep the default. 「和默认模型一样」 clears it.
 */
function RoleAgentModel({ client }: { client: AdgClient }) {
  const { catalog } = useModelCatalog(client)
  const status = useStore(client.connection.status)
  const [chosen, setChosen] = useState<ModelSelection | null | undefined>(undefined)
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState<{ tone: 'ok' | 'warn'; text: string } | null>(null)
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('models/roleModel', {}).then(r => { if (live) setChosen(r.model) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state])
  const current = chosen == null ? '' : `${chosen.provider}/${chosen.model}`
  const choose = async (value: string) => {
    const [provider, ...rest] = value.split('/')
    const model = value === '' ? null : { provider: provider!, model: rest.join('/') }
    setBusy(true)
    setMessage(null)
    try {
      const { warning } = await client.connection.call('models/setRoleModel', { model })
      setChosen(model)
      setMessage(warning !== undefined ? { tone: 'warn', text: warning } : { tone: 'ok', text: model === null ? '角色 agent 和以前一样，用默认模型。' : '之后新开的干预、游戏、脚本、编排会话用它；已经开着的会话不变。' })
    } catch (e) {
      setMessage({ tone: 'warn', text: e instanceof Error ? e.message : String(e) })
    } finally {
      setBusy(false)
    }
  }
  const known = current === '' || (catalog?.groups.some(g => g.models.some(m => `${g.id}/${m.id}` === current)) ?? false)
  return (
    <section className="card">
      <div className="card-head"><div>
        <h3>角色 agent 的模型</h3>
        <p className="muted small">干预、游戏、脚本、编排这些软件自己开的会话用它。它们主要是截图、看日志、点击，选一个便宜、能看图的模型可以省用量；你自己的对话仍用上面的默认模型。</p>
      </div></div>
      {catalog === null || chosen === undefined ? <div className="muted small">读取中…</div> : (
        <Select aria-label="角色 agent 的模型" value={current} disabled={busy} onChange={next => void choose(next)} options={[
          { value: '', label: '和默认模型一样' },
          ...(known ? [] : [{ value: current, label: `${chosen!.provider} / ${chosen!.model}`, hint: '不可用：这个模型服务没有配好', disabled: true }]),
          ...catalog.groups.flatMap(group => group.models.map(model => ({ value: `${group.id}/${model.id}`, label: model.name, group: group.name }))),
        ]} />
      )}
      {message !== null && <div className={message.tone === 'ok' ? 'muted small' : 'error small'}>{message.text}</div>}
    </section>
  )
}
