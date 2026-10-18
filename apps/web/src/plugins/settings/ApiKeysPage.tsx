import { useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { DEEPSEEK_API_KEY, type CredentialInfo } from '@adg/protocol'
import { useCredentials, useModelCatalog, useStore } from '../../hooks.ts'
import { ProvidersSection } from '../providers/ProvidersPage.tsx'

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

/** Models and their keys in one place: the DeepSeek key, custom API routes, the resolved catalog, other credentials. */
export function ApiKeysPage({ client }: { client: AdgClient }) {
  const { items, error } = useCredentials(client, [DEEPSEEK_API_KEY])
  const capabilities = useStore(client.capabilities)
  return (
    <div className="settings-page">
      <h2>模型与 API</h2>
      <p className="muted">
        DeepSeek 官方模型和自定义 API 都在这里配置。Key 由 dsh 的凭据服务保存在本机 dsh 主目录的私有文件中，保存后立即生效，重启后仍然有效；界面只显示 Key 是否已配置，不会读出内容。
      </p>
      {error !== null && <div className="banner error">{error}</div>}
      <CredentialCard
        client={client}
        refName={DEEPSEEK_API_KEY}
        title="DeepSeek API Key"
        description="官方 DeepSeek 模型（deepseek-official）使用的密钥。"
        helpUrl="https://platform.deepseek.com/api_keys"
        info={items?.[DEEPSEEK_API_KEY] ?? null}
      />
      {capabilities.has('providers') && <ProvidersSection client={client} />}
      <ModelStatus client={client} />
      <OtherCredential client={client} />
    </div>
  )
}

/** Set, replace or remove one credential; never shows a stored value. */
export function CredentialCard({ client, refName, title, description, helpUrl, info, placeholder }: {
  client: AdgClient
  refName: string
  title: string
  description: string
  helpUrl?: string
  info: CredentialInfo | null
  /** Input hint while nothing is configured. */
  placeholder?: string
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

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          <div className="muted small">{description} <code>{refName}</code></div>
        </div>
        <CredentialBadge info={info} />
      </div>
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
    </section>
  )
}

function CredentialBadge({ info }: { info: CredentialInfo | null }) {
  if (info === null) return <span className="badge">读取中…</span>
  if (!info.configured) return <span className="badge warn">未配置</span>
  return <span className="badge ok">已配置 · {SOURCE_LABEL[info.source ?? ''] ?? info.source ?? '未知来源'}</span>
}

/** Model catalog as the host resolves it now; refreshed after every credential or provider change. */
function ModelStatus({ client }: { client: AdgClient }) {
  const { catalog, error } = useModelCatalog(client)

  return (
    <section className="card">
      <div className="card-head"><h3>可用模型</h3></div>
      {error !== null && <div className="error small">{error}</div>}
      {catalog === null && error === null && <div className="muted small">读取中…</div>}
      {catalog !== null && (
        <>
          <div className="small">默认模型：<code>{catalog.default.provider} / {catalog.default.model}</code></div>
          {catalog.groups.map(group => (
            <div key={group.id} className="model-group">
              <div className="small strong">{group.name}</div>
              <div className="model-chips">
                {group.models.map(model => <span key={model.id} className="chip" title={model.description}>{model.name}</span>)}
              </div>
            </div>
          ))}
          {catalog.failures.map(f => <div key={f.id} className="error small">{f.name}：{f.message}</div>)}
        </>
      )}
    </section>
  )
}

/** Any other credential by name, e.g. a custom provider's key. */
function OtherCredential({ client }: { client: AdgClient }) {
  const [name, setName] = useState('')
  const valid = /^[A-Za-z_][A-Za-z0-9_]*$/.test(name)
  const { items } = useCredentials(client, valid ? [name] : [])
  return (
    <details className="card advanced">
      <summary>其他凭据（高级）</summary>
      <label className="small">
        凭据名称
        <input className="text-input" value={name} onChange={e => setName(e.target.value.trim())} placeholder="例如 OPENROUTER_API_KEY" spellCheck={false} />
      </label>
      {name !== '' && !valid && <div className="error small">只能使用字母、数字和下划线，且不能以数字开头。</div>}
      {valid && (
        <CredentialCard client={client} refName={name} title={name} description="自定义凭据。" info={items?.[name] ?? null} />
      )}
    </details>
  )
}
