import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { InstallSettings } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useStore } from '../../hooks.ts'
import { errorText } from './data.ts'

/** Where installs download from: mirror, API, optional token, and how many versions to keep. */
export function InstallSettingsPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const [settings, setSettings] = useState<(InstallSettings & { tokenConfigured: boolean }) | null>(null)
  const [draft, setDraft] = useState<InstallSettings | null>(null)
  const [token, setToken] = useState('')
  const [saving, setSaving] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  const load = () => client.connection.call('scripts/settings', {}).then(s => { setSettings(s); setDraft(s) }).catch(e => setError(errorText(e)))
  useEffect(() => { if (status.state === 'open') void load() }, [client, status.state])

  if (draft === null || settings === null) return <div className="settings-page"><h2>脚本安装</h2>{error === null ? <p>加载中…</p> : <div className="notice error left">{error}</div>}</div>
  const set = <K extends keyof InstallSettings>(key: K, value: InstallSettings[K]) => setDraft({ ...draft, [key]: value })

  const save = async () => {
    setSaving(true)
    setError(null)
    setNote(null)
    try {
      const { tokenConfigured: _ignored, ...current } = settings
      const patch = Object.fromEntries(Object.entries(draft).filter(([k, v]) => current[k as keyof InstallSettings] !== v))
      if (Object.keys(patch).length > 0) await client.connection.call('scripts/settings/set', patch)
      if (token.trim() !== '') await client.connection.call('credentials/set', { ref: draft.tokenRef, value: token.trim() })
      setToken('')
      await load()
      setNote('已保存，下一次安装起生效')
    } catch (e) {
      setError(errorText(e))
    } finally {
      setSaving(false)
    }
  }

  return (
    <div className="settings-page">
      <h2>脚本安装</h2>
      <p>从 GitHub 发布页下载脚本时使用的设置。国内网络下载慢或失败时，可以填写下载镜像前缀。</p>

      <section className="card">
        <h3>下载镜像</h3>
        <input className="text-input plain" value={draft.downloadMirror} onChange={e => set('downloadMirror', e.target.value)} placeholder="留空直接下载；例如 https://ghfast.top/" spellCheck={false} />
        <p className="muted small">镜像只用于 GitHub 上的文件：下载地址前面加上这个前缀。微软、Google 等官方组件始终直接下载。</p>
        <label className="check-label"><input type="checkbox" checked={draft.mirrorFallback} onChange={e => set('mirrorFallback', e.target.checked)} />镜像失败时改为直接下载</label>
      </section>

      <section className="card">
        <h3>GitHub 访问</h3>
        <label className="field-label" htmlFor="gh-token">GitHub Token（可选）</label>
        <div className="key-input">
          <input id="gh-token" className="text-input" type="password" value={token} onChange={e => setToken(e.target.value)}
            placeholder={settings.tokenConfigured ? '已配置；输入新值可替换' : '不填也能用；填写后请求上限从每小时 60 次提高到 5000 次'} autoComplete="off" />
          {settings.tokenConfigured ? <span className="badge ok">已配置</span> : <span className="badge">未配置</span>}
        </div>
        <p className="muted small">只需要读取公开仓库的权限。保存在 dsh 的凭据文件里（{draft.tokenRef}），界面不会显示它的内容。</p>
        <label className="field-label" htmlFor="gh-api">API 地址</label>
        <input id="gh-api" className="text-input plain" value={draft.apiBase} onChange={e => set('apiBase', e.target.value)} spellCheck={false} />
      </section>

      <section className="card">
        <h3>版本</h3>
        <label className="field-label" htmlFor="keep-versions">每个脚本保留的版本数（含当前版本）</label>
        <input id="keep-versions" className="text-input plain" type="number" min={1} max={10} value={draft.keepVersions}
          onChange={e => set('keepVersions', Math.max(1, Math.min(10, Number(e.target.value) || 1)))} />
        <label className="check-label"><input type="checkbox" checked={draft.includePrereleases} onChange={e => set('includePrereleases', e.target.checked)} />没有正式版时使用预发布版本</label>
      </section>

      <div className="key-actions">
        {note !== null && <span className="muted small">{note}</span>}
        <span className="spacer" />
        <button className="primary" disabled={saving} onClick={() => void save()}>{saving ? '保存中…' : '保存'}</button>
      </div>
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}
