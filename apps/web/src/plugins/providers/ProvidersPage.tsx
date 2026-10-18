/**
 * Custom API providers: OpenAI-compatible, OpenAI Responses or Anthropic
 * endpoints. Routes are stored by dsh itself (the pi-ai adapter's settings),
 * keys by its credential service; this page only edits them.
 */
import { useCallback, useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ProviderProfile, RequestResult } from '@adg/protocol'
import { useStore } from '../../hooks.ts'
import { ProviderEditor } from './ProviderEditor.tsx'
import { formatContext, protocolInfo } from './protocols.ts'

type ListResult = RequestResult<'providers/list'>

/** Custom API routes, or the editor while one is edited: a section of the 模型与 API settings page. */
export function ProvidersSection({ client }: { client: AdgClient }) {
  const revision = useStore(client.providersRevision)
  const credentials = useStore(client.credentialRevision)
  const status = useStore(client.connection.status)
  const [list, setList] = useState<ListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** `null`: list view; `'new'`: create; otherwise the route being edited. */
  const [editing, setEditing] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const reload = useCallback(() => {
    client.listProviders()
      .then(value => { setList(value); setError(null) })
      .catch(e => setError(e instanceof Error ? e.message : String(e)))
  }, [client])
  useEffect(() => {
    if (status.state === 'open') reload()
  }, [reload, revision, credentials, status.state])

  if (editing !== null && list !== null) {
    const profile = editing === 'new' ? undefined : list.providers.find(p => p.id === editing)
    return (
      <section className="providers-section">
        <ProviderEditor
          key={editing}
          client={client}
          profile={profile}
          taken={list.taken}
          revision={list.revision}
          readOnly={!list.writable}
          onDone={() => { setEditing(null); reload() }}
        />
      </section>
    )
  }

  return (
    <section className="providers-section">
      <div className="page-head">
        <h3>自定义 API</h3>
        <button className="primary" onClick={() => setEditing('new')} disabled={list === null || !list.writable}>＋ 添加</button>
      </div>
      <p className="muted">
        接入任意 OpenAI 兼容、OpenAI Responses 或 Anthropic 兼容的服务。配置由 dsh 保存在当前 profile 中，Key 存放在 dsh 的凭据文件里；保存后立即生效，新模型会出现在输入框旁的模型选择器中。
      </p>
      {error !== null && <div className="banner error">{error}</div>}
      {notice !== null && <div className="success small">{notice}</div>}
      {list !== null && !list.writable && <div className="notice info left">当前 profile 是只读的，无法在界面中修改提供方。</div>}
      {list === null && error === null && <div className="muted small">读取中…</div>}
      {list !== null && list.providers.length === 0 && (
        <div className="card empty-card">
          <div className="muted">还没有自定义 API。</div>
          <button onClick={() => setEditing('new')} disabled={!list.writable}>添加第一个</button>
        </div>
      )}
      {list?.providers.map(profile => (
        <ProviderCard
          key={profile.id}
          client={client}
          profile={profile}
          revision={list.revision}
          readOnly={!list.writable}
          onEdit={() => setEditing(profile.id)}
          onRemoved={defaultReset => { setNotice(defaultReset ? `已删除。它原本是新会话的默认模型，默认模型已恢复为 profile 自带的设置。` : null); reload() }}
        />
      ))}
    </section>
  )
}

function ProviderCard({ client, profile, revision, readOnly, onEdit, onRemoved }: {
  client: AdgClient
  profile: ProviderProfile
  revision: number
  readOnly: boolean
  onEdit: () => void
  onRemoved: (defaultReset: boolean) => void
}) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const protocol = protocolInfo(profile.api)

  const remove = async () => {
    const keyNote = profile.apiKeyRef !== undefined && profile.credential?.source === 'file'
      ? `\n\n同时删除已保存的 Key（${profile.apiKeyRef}）。`
      : ''
    if (!window.confirm(`确定删除「${profile.displayName}」吗？使用它的会话需要换一个模型。${keyNote}`)) return
    setBusy(true)
    setError(null)
    try {
      const { defaultReset } = await client.removeProvider({ id: profile.id, removeKey: profile.credential?.source === 'file', expectedRevision: revision })
      onRemoved(defaultReset)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card provider-card">
      <div className="card-head">
        <div className="provider-title">
          <h3>{profile.displayName}</h3>
          <div className="muted small"><code>{profile.id}</code>{profile.baseURL !== undefined && <> · <span className="mono">{profile.baseURL}</span></>}</div>
        </div>
        <div className="badges">
          <span className="badge">{protocol === undefined ? (profile.api ?? '内置目录') : `${protocol.title} · ${protocol.subtitle}`}</span>
          <KeyBadge profile={profile} />
          {profile.active
            ? <span className="badge ok">已生效</span>
            : <span className="badge warn" title={profile.error}>未生效</span>}
        </div>
      </div>
      {profile.error !== undefined && <div className="error small">{profile.error}</div>}
      {profile.models.length > 0
        ? (
          <div className="model-chips">
            {profile.models.map(m => (
              <span key={m.id} className="chip" title={m.name ?? m.id}>
                {m.id}{formatContext(m.contextWindow) !== null && <span className="muted"> · {formatContext(m.contextWindow)}</span>}
              </span>
            ))}
          </div>
        )
        : <div className="muted small">使用 dsh 内置的模型目录。</div>}
      {error !== null && <div className="error small">{error}</div>}
      <div className="key-actions">
        {!profile.declared && <span className="muted small">这是 dsh 内置提供方的配置，请在 dsh 官方模型页面编辑。</span>}
        <span className="spacer" />
        <button className="danger-outline" onClick={() => void remove()} disabled={busy || readOnly}>删除</button>
        {profile.declared && <button onClick={onEdit} disabled={busy || readOnly}>编辑</button>}
      </div>
    </section>
  )
}

function KeyBadge({ profile }: { profile: ProviderProfile }) {
  if (profile.apiKeyRef === undefined) return <span className="badge">无 Key</span>
  if (profile.credential === undefined) return <span className="badge">Key：{profile.apiKeyRef}</span>
  return profile.credential.configured
    ? <span className="badge ok" title={profile.apiKeyRef}>Key 已配置</span>
    : <span className="badge warn" title={profile.apiKeyRef}>Key 未配置</span>
}
