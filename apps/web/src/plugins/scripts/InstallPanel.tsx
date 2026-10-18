import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ReleaseInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { errorText, formatBytes } from './data.ts'

/**
 * Install from a GitHub release: pick the repository, then the release and
 * file (the suggested file is preselected). Starting the install is the user's
 * explicit confirmation of where the code comes from.
 */
export function InstallPanel({ client, initialRepo, onStarted, onClose }: {
  client: AdgClient
  initialRepo?: string
  onStarted: (scriptId: string) => void
  onClose: () => void
}) {
  const [repo, setRepo] = useState(initialRepo ?? '')
  const [loaded, setLoaded] = useState<{ repo: string; packId?: string | undefined; releases: ReleaseInfo[] } | null>(null)
  const [tag, setTag] = useState<string>('')
  const [asset, setAsset] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const load = async (value = repo) => {
    const target = value.trim().replace(/^https?:\/\/github\.com\//i, '').replace(/\.git$|\/$/g, '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(target)) {
      setError('请输入 owner/repo，或粘贴 GitHub 仓库地址')
      return
    }
    setBusy(true)
    setError(null)
    try {
      const result = await client.connection.call('scripts/releases', { repo: target, limit: 10 })
      setRepo(target)
      setLoaded(result)
      const first = result.releases.find(r => !r.prerelease) ?? result.releases[0]
      setTag(first?.tag ?? '')
      setAsset(first?.suggestedAsset ?? '')
      if (result.releases.length === 0) setError('这个仓库还没有发布版本')
    } catch (e) {
      setLoaded(null)
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (initialRepo !== undefined) void load(initialRepo)
    // Load once for a repo handed in by a pack card.
  }, [initialRepo])

  const release = loaded?.releases.find(r => r.tag === tag)
  const install = async () => {
    if (loaded === null || release === undefined || asset === '') return
    setBusy(true)
    setError(null)
    try {
      const { scriptId } = await client.connection.call('scripts/install', { repo: loaded.repo, tag: release.tag, asset })
      onStarted(scriptId)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }

  return (
    <section className="card panel-card">
      <div className="card-head">
        <div><h3>从 GitHub 安装</h3><p className="muted small">优先使用发布版本；文件会放进统一的工具目录，旧版本保留用于回滚。</p></div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="field-row" onSubmit={e => { e.preventDefault(); void load() }}>
        <input className="text-input plain" aria-label="GitHub 仓库" value={repo} onChange={e => setRepo(e.target.value)} placeholder="owner/repo，例如 MaaAssistantArknights/MaaAssistantArknights" spellCheck={false} disabled={busy} />
        <button type="submit" disabled={busy || repo.trim() === ''}>{busy && loaded === null ? '读取中…' : '读取发布'}</button>
      </form>

      {loaded !== null && loaded.releases.length > 0 && (
        <>
          <label className="field-label" htmlFor="release-select">版本{loaded.packId !== undefined && <span className="chip subtle">内置脚本包 {loaded.packId}</span>}</label>
          <select id="release-select" className="text-input plain" value={tag} disabled={busy} onChange={e => {
            setTag(e.target.value)
            setAsset(loaded.releases.find(r => r.tag === e.target.value)?.suggestedAsset ?? '')
          }}>
            {loaded.releases.map(r => (
              <option key={r.tag} value={r.tag}>{r.tag}{r.prerelease ? '（预发布）' : ''}{r.publishedAt === undefined ? '' : ` · ${r.publishedAt.slice(0, 10)}`}</option>
            ))}
          </select>
          {release !== undefined && (
            <fieldset className="asset-list" disabled={busy}>
              <legend className="field-label">下载文件</legend>
              {release.assets.length === 0 && <div className="muted small">这个版本没有可下载的文件</div>}
              {[...release.assets].sort((a, b) => Number(b.name === release.suggestedAsset) - Number(a.name === release.suggestedAsset)).map(a => (
                <label key={a.name} className={`asset-option ${a.name === asset ? 'active' : ''}`}>
                  <input type="radio" name="asset" value={a.name} checked={a.name === asset} onChange={() => setAsset(a.name)} />
                  <span className="asset-name">{a.name}</span>
                  {a.name === release.suggestedAsset && <span className="badge ok">推荐</span>}
                  <span className="muted small">{formatBytes(a.size)}</span>
                </label>
              ))}
            </fieldset>
          )}
          <div className="key-actions">
            <span className="muted small">{release?.suggestedAsset === undefined ? '没有自动匹配到适合本机的文件，请手动选择。' : '已按本机（Windows x64）选好文件。'}</span>
            <span className="spacer" />
            <button className="primary" onClick={() => void install()} disabled={busy || asset === ''}>安装 {release?.tag}</button>
          </div>
        </>
      )}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}

/** Register a directory the user already has, in place. */
export function ImportPanel({ client, onImported, onClose }: { client: AdgClient; onImported: (scriptId: string) => void; onClose: () => void }) {
  const [path, setPath] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async () => {
    setBusy(true)
    setError(null)
    try {
      const info = await client.connection.call('scripts/import', { path: path.trim().replace(/^"|"$/g, ''), ...(name.trim() === '' ? {} : { name: name.trim() }) })
      onImported(info.id)
    } catch (e) {
      setError(errorText(e))
      setBusy(false)
    }
  }
  return (
    <section className="card panel-card">
      <div className="card-head">
        <div><h3>导入本地项目</h3><p className="muted small">登记电脑上已有的脚本目录，原地使用：不移动、不复制、不修改，移除时也不会删除。</p></div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="import-form" onSubmit={e => { e.preventDefault(); void submit() }}>
        <label className="field-label" htmlFor="import-path">目录路径</label>
        <input id="import-path" className="text-input plain" value={path} onChange={e => setPath(e.target.value)} placeholder="例如 D:\Games\MAA" spellCheck={false} disabled={busy} />
        <label className="field-label" htmlFor="import-name">显示名称（可选）</label>
        <input id="import-name" className="text-input plain" value={name} onChange={e => setName(e.target.value)} placeholder="留空则按脚本包或目录名" disabled={busy} />
        <div className="key-actions">
          <span className="muted small">会按内置脚本包自动识别是哪个脚本。</span>
          <span className="spacer" />
          <button className="primary" type="submit" disabled={busy || path.trim() === ''}>{busy ? '导入中…' : '导入'}</button>
        </div>
      </form>
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}
