import { useMemo, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ProviderApi, ProviderModel, ProviderProfile } from '@adg/protocol'
import { apiKeyProblem } from '../settings/ApiKeysPage.tsx'
import type { ProviderPreset } from './presets.ts'
import { ID_PATTERN, PROTOCOLS, formatContext, isHttpUrl, keyRefFor, protocolInfo, slugify } from './protocols.ts'

export function ProviderEditor({ client, profile, preset, taken, revision, readOnly, onDone }: {
  client: AdgClient
  /** Absent when creating. */
  profile: ProviderProfile | undefined
  /** A known service picked when adding: fills the fields. */
  preset?: ProviderPreset | undefined
  taken: readonly string[]
  revision: number
  readOnly: boolean
  onDone: () => void
}) {
  const creating = profile === undefined
  const presetId = preset === undefined || preset.id === '' ? '' : taken.includes(preset.id) ? `${preset.id}-2` : preset.id
  const [api, setApi] = useState<ProviderApi>(() => protocolInfo(profile?.api ?? preset?.api)?.id ?? 'openai-completions')
  const [displayName, setDisplayName] = useState(profile?.displayName ?? (preset?.baseURL === '' ? '' : preset?.name ?? ''))
  const [id, setId] = useState(profile?.id ?? presetId)
  const [idTouched, setIdTouched] = useState(!creating || presetId !== '')
  const [baseURL, setBaseURL] = useState(profile?.baseURL ?? preset?.baseURL ?? '')
  const [key, setKey] = useState('')
  const [models, setModels] = useState<readonly ProviderModel[]>(profile?.models ?? [])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const protocol = protocolInfo(api)!
  const base = baseURL.trim()
  const baseInvalid = base !== '' && !isHttpUrl(base)
  const idInvalid = id !== '' && !ID_PATTERN.test(id)
  const idTaken = creating && taken.includes(id)
  const keyProblem = apiKeyProblem(key)
  const keyRef = profile?.apiKeyRef ?? (id === '' ? null : keyRefFor(id))
  const keyConfigured = profile?.credential?.configured === true
  const keyReadOnly = profile?.credential !== undefined && !profile.credential.writable

  const blocker = id === '' ? '请填写标识'
    : idInvalid ? '标识格式不正确'
    : idTaken ? '这个标识已被占用'
    : base === '' ? '请填写 Base URL'
    : baseInvalid ? 'Base URL 需要以 http:// 或 https:// 开头'
    : keyProblem !== null ? keyProblem
    : models.length === 0 ? '至少需要一个模型：点击「拉取模型列表」或手动添加'
    : null

  const onName = (value: string) => {
    setDisplayName(value)
    if (!idTouched) setId(slugify(value))
  }

  const save = async () => {
    if (blocker !== null) return
    setBusy(true)
    setError(null)
    try {
      await client.saveProvider({
        id,
        create: creating,
        ...(displayName.trim() === '' ? {} : { displayName: displayName.trim() }),
        api,
        baseURL: base,
        models: [...models],
        ...(key.trim() === '' ? {} : { apiKey: key.trim() }),
        expectedRevision: revision,
      })
      onDone()
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e)
      setError(/SETTINGS_CONFLICT|conflict/i.test(message) ? '配置在别处被修改过了，请返回列表后重试。' : message)
    } finally {
      setBusy(false)
    }
  }

  const disabled = busy || readOnly
  return (
    <form className="provider-editor" onSubmit={e => { e.preventDefault(); void save() }}>
      <div className="page-head">
        <h3>{creating ? (preset !== undefined && preset.baseURL !== '' ? `添加 ${preset.name}` : '添加模型服务') : `编辑「${profile.displayName}」`}</h3>
        <button type="button" className="ghost" onClick={onDone} disabled={busy}>返回</button>
      </div>

      <section className="card">
        <h3 className="field-title">接口模式</h3>
        <div className="mode-grid" role="radiogroup" aria-label="接口模式">
          {PROTOCOLS.map(p => (
            <button
              type="button"
              key={p.id}
              role="radio"
              aria-checked={api === p.id}
              aria-label={`${p.title}（${p.subtitle}）`}
              className={`mode-option${api === p.id ? ' selected' : ''}`}
              onClick={() => setApi(p.id)}
              disabled={disabled}
            >
              <span className="mode-title">{p.title}</span>
              <span className="mode-subtitle">{p.subtitle}</span>
            </button>
          ))}
        </div>
        <div className="muted small">{protocol.hint}</div>
      </section>

      <section className="card">
        <div className="field-row">
          <label className="field">
            <span className="field-title">名称</span>
            <input className="text-input plain" value={displayName} onChange={e => onName(e.target.value)} placeholder="例如：我的中转站" disabled={disabled} />
          </label>
          <label className="field">
            <span className="field-title">标识</span>
            <input
              className="text-input"
              value={id}
              onChange={e => { setId(e.target.value.trim()); setIdTouched(true) }}
              placeholder="my-gateway"
              disabled={disabled || !creating}
              spellCheck={false}
            />
          </label>
        </div>
        <div className={idInvalid || idTaken ? 'error small' : 'muted small'}>
          {idInvalid ? '标识只能用小写字母、数字和单个连字符，并以字母开头。'
            : idTaken ? '这个标识已被占用（可能是已有的提供方或 dsh 内置提供方）。'
            : creating ? '用于区分提供方，保存后不能修改。' : '标识创建后不能修改。'}
        </div>

        <label className="field">
          <span className="field-title">Base URL</span>
          <input className="text-input" value={baseURL} onChange={e => setBaseURL(e.target.value)} placeholder={protocol.placeholder} disabled={disabled} spellCheck={false} />
        </label>
        {baseInvalid
          ? <div className="error small">Base URL 需要以 http:// 或 https:// 开头。</div>
          : base !== '' && (
            <div className="muted small endpoint-preview">
              对话请求 <code>POST {protocol.requestPath(base)}</code><br />
              模型列表 <code>GET {protocol.listPath(base)}</code>
            </div>
          )}

        <label className="field">
          <span className="field-title">API Key</span>
          <input
            className="text-input"
            type="password"
            value={key}
            onChange={e => setKey(e.target.value)}
            placeholder={keyReadOnly ? '由启动环境变量提供，无法在此修改' : keyConfigured ? '已配置，留空则保持不变' : '粘贴 Key；本地服务不需要时可留空'}
            autoComplete="new-password"
            disabled={disabled || keyReadOnly}
            spellCheck={false}
          />
        </label>
        {keyProblem !== null
          ? <div className="error small">{keyProblem}</div>
          : keyRef !== null && <div className="muted small">保存在 dsh 凭据 <code>{keyRef}</code> 中，界面不会再显示 Key 的内容。{preset?.keyUrl !== undefined && <> <a href={preset.keyUrl} target="_blank" rel="noopener noreferrer">获取 Key ↗</a></>}</div>}
        {preset?.vision !== undefined && <div className="muted small">截图诊断、读游戏信息需要能看图的模型：{preset.vision}。</div>}
      </section>

      <ModelsSection
        client={client}
        models={models}
        onChange={setModels}
        probe={{
          ...(profile === undefined ? {} : { provider: profile.id }),
          api,
          baseURL: base,
          apiKey: key.trim(),
        }}
        probeBlocked={base === '' ? '先填写 Base URL' : baseInvalid ? 'Base URL 无效' : keyProblem}
        disabled={disabled}
      />

      {error !== null && <div className="banner error">{error}</div>}
      <div className="key-actions">
        <span className="muted small">{blocker}</span>
        <span className="spacer" />
        <button type="button" onClick={onDone} disabled={busy}>取消</button>
        <button type="submit" className="primary" disabled={disabled || blocker !== null}>
          {busy ? '保存中…' : creating ? '创建' : '保存'}
        </button>
      </div>
    </form>
  )
}

/**
 * The route's model list: pull candidates from the endpoint, tick the ones to
 * use, or type ids by hand. Only ticked models are stored. Each stored model
 * can be marked as accepting images: model lists rarely say so, and dsh
 * refuses image attachments for a model not declared with `input: [text, image]`.
 */
function ModelsSection({ client, models, onChange, probe, probeBlocked, disabled }: {
  client: AdgClient
  models: readonly ProviderModel[]
  onChange: (models: readonly ProviderModel[]) => void
  probe: { provider?: string; api: ProviderApi; baseURL: string; apiKey: string }
  probeBlocked: string | null
  disabled: boolean
}) {
  const [candidates, setCandidates] = useState<readonly ProviderModel[] | null>(null)
  const [filter, setFilter] = useState('')
  const [manual, setManual] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const inflight = useRef<AbortController | null>(null)
  const selected = useMemo(() => new Set(models.map(m => m.id)), [models])

  const pull = async () => {
    inflight.current?.abort()
    const controller = new AbortController()
    inflight.current = controller
    setBusy(true)
    setError(null)
    try {
      const found = await client.discoverModels({
        ...(probe.provider === undefined ? {} : { provider: probe.provider }),
        api: probe.api,
        baseURL: probe.baseURL,
        ...(probe.apiKey === '' ? {} : { apiKey: probe.apiKey }),
      }, controller.signal)
      if (controller.signal.aborted) return
      setCandidates([...found].sort((a, b) => a.id.localeCompare(b.id)))
      if (found.length === 0) setError('接口返回了空的模型列表，可以手动添加模型 ID。')
    } catch (e) {
      if (!controller.signal.aborted) setError(e instanceof Error ? e.message : String(e))
    } finally {
      if (inflight.current === controller) {
        inflight.current = null
        setBusy(false)
      }
    }
  }

  const toggle = (model: ProviderModel) => {
    onChange(selected.has(model.id) ? models.filter(m => m.id !== model.id) : [...models, model])
  }

  const toggleThinking = (id: string) => {
    onChange(models.map(m => {
      if (m.id !== id) return m
      if (m.efforts !== undefined && m.efforts.length > 0) { const { efforts: _e, ...rest } = m; return rest }
      return { ...m, efforts: ['off', 'low', 'medium', 'high'] }
    }))
  }

  const toggleImages = (id: string) => {
    onChange(models.map(m => (m.id !== id ? m : { ...m, input: m.input?.includes('image') === true ? ['text'] : ['text', 'image'] })))
  }

  const visible = useMemo(() => {
    const q = filter.trim().toLowerCase()
    return (candidates ?? []).filter(m => q === '' || m.id.toLowerCase().includes(q) || (m.name ?? '').toLowerCase().includes(q))
  }, [candidates, filter])

  const selectVisible = (on: boolean) => {
    if (on) {
      const extra = visible.filter(m => !selected.has(m.id))
      onChange([...models, ...extra])
    } else {
      const drop = new Set(visible.map(m => m.id))
      onChange(models.filter(m => !drop.has(m.id)))
    }
  }

  const addManual = () => {
    const ids = manual.split(/[\s,，]+/).map(s => s.trim()).filter(s => s !== '' && !selected.has(s))
    if (ids.length === 0) return
    onChange([...models, ...ids.map(id => candidates?.find(c => c.id === id) ?? { id })])
    setManual('')
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>模型</h3>
          <div className="muted small">已选 {models.length} 个。只有选中的模型会出现在模型选择器里。能看图的模型点亮「图片」，否则 dsh 会拒绝发送图片；支持调思考强度的模型（如 GPT-5、o 系列、Claude、DeepSeek R 系列）点亮「思考」，对话里就能选强度。</div>
        </div>
        <button type="button" onClick={() => void pull()} disabled={disabled || busy || probeBlocked !== null} title={probeBlocked ?? undefined}>
          {busy ? '拉取中…' : candidates === null ? '拉取模型列表' : '重新拉取'}
        </button>
      </div>
      {error !== null && <div className="error small">{error}</div>}

      {models.length > 0 && (
        <div className="model-chips">
          {models.map(m => (
            <span key={m.id} className="chip removable">
              {m.id}
              {formatContext(m.contextWindow) !== null && <span className="muted"> · {formatContext(m.contextWindow)}</span>}
              <button
                type="button" className={`chip-flag${m.input?.includes('image') === true ? ' on' : ''}`} onClick={() => toggleImages(m.id)} disabled={disabled}
                aria-pressed={m.input?.includes('image') === true} title={m.input?.includes('image') === true ? '支持图片输入（点击关闭）' : '不支持图片输入（点击开启）'}
              >
                图片
              </button>
              <button
                type="button" className={`chip-flag${(m.efforts?.length ?? 0) > 0 ? ' on' : ''}`} onClick={() => toggleThinking(m.id)} disabled={disabled}
                aria-pressed={(m.efforts?.length ?? 0) > 0} title={(m.efforts?.length ?? 0) > 0 ? `可选思考强度：${m.efforts!.join(' / ')}（点击关闭）` : '没有声明思考强度（点击开启：不思考 / 低 / 中 / 高）'}
              >
                思考
              </button>
              <button type="button" className="chip-x" onClick={() => onChange(models.filter(x => x.id !== m.id))} disabled={disabled} aria-label={`移除 ${m.id}`}>×</button>
            </span>
          ))}
        </div>
      )}

      {candidates !== null && candidates.length > 0 && (
        <div className="candidates">
          <div className="candidates-bar">
            <input className="text-input plain" value={filter} onChange={e => setFilter(e.target.value)} placeholder={`搜索 ${candidates.length} 个模型`} />
            <button type="button" className="small-button" onClick={() => selectVisible(true)} disabled={disabled}>全选{filter !== '' ? '筛选结果' : ''}</button>
            <button type="button" className="small-button" onClick={() => selectVisible(false)} disabled={disabled}>全不选</button>
          </div>
          <ul className="candidate-list">
            {visible.map(m => (
              <li key={m.id}>
                <label>
                  <input type="checkbox" checked={selected.has(m.id)} onChange={() => toggle(m)} disabled={disabled} />
                  <span className="mono">{m.id}</span>
                  {m.name !== undefined && <span className="muted"> {m.name}</span>}
                  <span className="spacer" />
                  {m.input?.includes('image') === true && <span className="badge">图像</span>}
                  {formatContext(m.contextWindow) !== null && <span className="muted small">{formatContext(m.contextWindow)} 上下文</span>}
                </label>
              </li>
            ))}
            {visible.length === 0 && <li className="muted small">没有匹配的模型。</li>}
          </ul>
        </div>
      )}

      <div className="key-input">
        <input
          className="text-input plain-mono"
          value={manual}
          onChange={e => setManual(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { e.preventDefault(); addManual() } }}
          placeholder="手动添加模型 ID，多个用空格或逗号分隔"
          disabled={disabled}
          spellCheck={false}
        />
        <button type="button" onClick={addManual} disabled={disabled || manual.trim() === ''}>添加</button>
      </div>
    </section>
  )
}
