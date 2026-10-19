/**
 * Model services in one list: dsh's built-in providers (DeepSeek) and the
 * routes the user added (OpenAI-compatible, OpenAI Responses or Anthropic
 * endpoints). Routes are stored by dsh itself (the pi-ai adapter's settings),
 * keys by its credential service; this page only edits them.
 */
import { useCallback, useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { DEEPSEEK_API_KEY, type ModelCatalog, type ProviderProfile, type RequestResult } from '@adg/protocol'
import { useCredentials, useModelCatalog, useStore } from '../../hooks.ts'
import { CredentialCard } from '../settings/ApiKeysPage.tsx'
import { ProviderEditor } from './ProviderEditor.tsx'
import { PRESETS, type ProviderPreset } from './presets.ts'
import { formatContext, protocolInfo } from './protocols.ts'

/** Providers dsh ships with, and the key each one reads. */
const BUILTIN: readonly { id: string; name: string; note: string; keyRef: string; keyUrl: string }[] = [
  { id: 'deepseek-official', name: 'DeepSeek', note: '内置，只需要填 Key', keyRef: DEEPSEEK_API_KEY, keyUrl: 'https://platform.deepseek.com/api_keys' },
]

type ListResult = RequestResult<'providers/list'>

/** Every model service, the preset picker, or the editor while one is edited: a section of the 模型 settings page. */
export function ProvidersSection({ client }: { client: AdgClient }) {
  const { catalog } = useModelCatalog(client)
  const [picking, setPicking] = useState(false)
  const [preset, setPreset] = useState<ProviderPreset | undefined>(undefined)
  const revision = useStore(client.providersRevision)
  const credentials = useStore(client.credentialRevision)
  const status = useStore(client.connection.status)
  const [list, setList] = useState<ListResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** `null`: list view; `'new'`: create (from `preset`); otherwise the route being edited. */
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
          preset={editing === 'new' ? preset : undefined}
          taken={list.taken}
          revision={list.revision}
          readOnly={!list.writable}
          onDone={() => { setEditing(null); setPreset(undefined); reload() }}
        />
      </section>
    )
  }

  if (picking) {
    return (
      <section className="providers-section">
        <div className="page-head">
          <h3>添加模型服务</h3>
          <button className="ghost" onClick={() => setPicking(false)}>返回</button>
        </div>
        <div className="preset-grid">
          {BUILTIN.map(b => (
            <button key={b.id} className="preset-option" onClick={() => { setPicking(false); document.getElementById(`builtin-${b.id}`)?.scrollIntoView({ behavior: 'smooth' }) }}>
              <span className="mode-title">{b.name}</span><span className="mode-subtitle">{b.note}</span>
            </button>
          ))}
          {PRESETS.map(p => (
            <button key={p.key} className="preset-option" disabled={list === null || !list.writable} onClick={() => { setPreset(p); setPicking(false); setEditing('new') }}>
              <span className="mode-title">{p.name}</span><span className="mode-subtitle">{p.note}</span>
            </button>
          ))}
        </div>
      </section>
    )
  }

  const custom = new Set(list?.providers.map(p => p.id) ?? [])
  return (
    <section className="providers-section">
      <div className="page-head">
        <h3>模型服务</h3>
        <button className="primary" onClick={() => setPicking(true)} disabled={list === null}>＋ 添加模型服务</button>
      </div>
      <p className="muted">
        每个服务填一次 Key，它的模型就会出现在输入框旁的模型选择器里。Claude、ChatGPT、Gemini、国内各家和本机的 Ollama 都可以接；需要看截图的功能请选能看图的模型。Key 保存在本机 dsh 的凭据文件里，界面不会再显示。
      </p>
      {BUILTIN.map(b => <BuiltinCard key={b.id} client={client} provider={b} catalog={catalog} />)}
      {catalog?.groups.filter(g => !custom.has(g.id) && !BUILTIN.some(b => b.id === g.id)).map(g => (
        <section key={g.id} className="card provider-card">
          <div className="card-head"><div className="provider-title"><h3>{g.name}</h3><div className="muted small"><code>{g.id}</code></div></div><span className="badge">内置</span></div>
          <div className="model-chips">{g.models.map(m => <span key={m.id} className="chip">{m.name}</span>)}</div>
        </section>
      ))}
      {error !== null && <div className="banner error">{error}</div>}
      {notice !== null && <div className="success small">{notice}</div>}
      {list !== null && !list.writable && <div className="notice info left">当前 profile 是只读的，无法在界面中修改提供方。</div>}
      {list === null && error === null && <div className="muted small">读取中…</div>}

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

/** A provider dsh ships: its key in place, its models from the catalog. */
function BuiltinCard({ client, provider, catalog }: { client: AdgClient; provider: (typeof BUILTIN)[number]; catalog: ModelCatalog | null }) {
  const { items } = useCredentials(client, [provider.keyRef])
  const info = items?.[provider.keyRef] ?? null
  const group = catalog?.groups.find(g => g.id === provider.id)
  const failure = catalog?.failures.find(f => f.id === provider.id)
  return (
    <section className="card provider-card" id={`builtin-${provider.id}`}>
      <div className="card-head">
        <div className="provider-title"><h3>{provider.name}</h3><div className="muted small"><code>{provider.id}</code> · {provider.note}</div></div>
        <div className="badges">
          <span className="badge">内置</span>
          {info === null ? null : info.configured ? <span className="badge ok">Key 已配置</span> : <span className="badge warn">Key 未配置</span>}
        </div>
      </div>
      {group !== undefined && group.models.length > 0 && <div className="model-chips">{group.models.map(m => <span key={m.id} className="chip" title={m.description}>{m.name}</span>)}</div>}
      {failure !== undefined && <div className="error small">{failure.message}</div>}
      <CredentialCard client={client} refName={provider.keyRef} title={`${provider.name} API Key`} description="" helpUrl={provider.keyUrl} info={info} bare />
    </section>
  )
}
