import { useEffect, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ReleaseInfo, ScriptJob } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { errorText, formatBytes, PHASE_LABEL } from './data.ts'

/**
 * Install from a GitHub release: pick the repository, then the release and
 * file (the suggested file is preselected). Starting the install is the user's
 * explicit confirmation of where the code comes from. The panel then follows
 * the install (steps, bytes, speed) until it is done, failed or cancelled.
 */
export function InstallPanel({ client, initialRepo, jobs, onDone, onClose }: {
  client: AdgClient
  initialRepo?: string
  /** The library's jobs by script id (useScriptJobs). */
  jobs: ReadonlyMap<string, ScriptJob>
  /** Show the installed script. */
  onDone: (scriptId: string) => void
  onClose: () => void
}) {
  const [repo, setRepo] = useState(initialRepo ?? '')
  const [loaded, setLoaded] = useState<{ repo: string; packId?: string | undefined; releases: ReleaseInfo[] } | null>(null)
  const [tag, setTag] = useState<string>('')
  const [asset, setAsset] = useState<string>('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState<{ jobId: string; scriptId: string; tag: string; asset: string; size?: number | undefined } | null>(null)

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
      const { jobId, scriptId } = await client.connection.call('scripts/install', { repo: loaded.repo, tag: release.tag, asset })
      setStarted({ jobId, scriptId, tag: release.tag, asset, size: release.assets.find(a => a.name === asset)?.size })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (started !== null && loaded !== null) {
    const job = jobs.get(started.scriptId)
    return (
      <InstallProgress client={client} repo={loaded.repo} {...started} job={job?.id === started.jobId ? job : undefined}
        onDone={() => onDone(started.scriptId)} onRetry={() => setStarted(null)} onClose={onClose} />
    )
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

/**
 * Install from Mirror酱: a resource id (or one of the known ones), looked up
 * first (no CDK needed for that); downloading needs the user's CDK. A
 * resource with a GitHub repository can be installed from there instead.
 */
export function MirrorInstallPanel({ client, initialRid, choices, jobs, onDone, onGitHub, onClose }: {
  client: AdgClient
  initialRid?: string
  /** Resources to offer with one click. */
  choices: readonly { rid: string; name: string }[]
  jobs: ReadonlyMap<string, ScriptJob>
  onDone: (scriptId: string) => void
  /** Install the resource's GitHub repository instead. */
  onGitHub: (repo: string) => void
  onClose: () => void
}) {
  const [rid, setRid] = useState(initialRid ?? '')
  const [found, setFound] = useState<{ rid: string; version: string; platform: boolean; name?: string | undefined; repo?: string | undefined } | null>(null)
  const [cdk, setCdk] = useState<boolean | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [started, setStarted] = useState<{ jobId: string; scriptId: string } | null>(null)

  useEffect(() => {
    void client.connection.call('scripts/settings', {}).then(s => setCdk(s.cdkConfigured), () => setCdk(null))
  }, [client])

  const lookup = async (value = rid) => {
    const target = value.trim()
    if (!/^[\w.-]{1,100}$/.test(target)) {
      setError('请输入 Mirror酱 的资源 id，例如 BGI、MAA')
      return
    }
    setBusy(true)
    setError(null)
    try {
      setRid(target)
      setFound(await client.connection.call('scripts/mirrorchyan/lookup', { rid: target }))
    } catch (e) {
      setFound(null)
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  useEffect(() => {
    if (initialRid !== undefined) void lookup(initialRid)
    // Look up once for a resource handed in by a list row.
  }, [initialRid])

  const install = async () => {
    if (found === null) return
    setBusy(true)
    setError(null)
    try {
      setStarted(await client.connection.call('scripts/install', { mirrorchyan: found.rid }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  if (started !== null && found !== null) {
    const job = jobs.get(started.scriptId)
    return (
      <InstallProgress client={client} repo={`Mirror酱 · ${found.rid}`} tag={found.version} asset={`${found.name ?? found.rid}（Mirror酱 完整包）`} job={job?.id === started.jobId ? job : undefined}
        onDone={() => onDone(started.scriptId)} onRetry={() => setStarted(null)} onClose={onClose} />
    )
  }

  return (
    <section className="card panel-card">
      <div className="card-head">
        <div><h3>从 Mirror酱 安装</h3><p className="muted small">从 Mirror酱 下载（国内快，以后的更新有增量包）；需要在「设置 → 脚本安装」填写 CDK。</p></div>
        <button className="icon-button" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
      </div>
      <form className="field-row" onSubmit={e => { e.preventDefault(); void lookup() }}>
        <input className="text-input plain" aria-label="Mirror酱 资源 id" value={rid} onChange={e => setRid(e.target.value)} placeholder="资源 id，例如 BGI、MAA、M9A" spellCheck={false} disabled={busy} />
        <button type="submit" disabled={busy || rid.trim() === ''}>{busy && found === null ? '查询中…' : '查询'}</button>
      </form>
      {choices.length > 0 && (
        <div className="mirror-choices">
          {choices.map(c => (
            <button key={c.rid} className={`mirror-choice ${found?.rid === c.rid ? 'active' : ''}`} disabled={busy} onClick={() => void lookup(c.rid)}>{c.name}<span className="muted small">{c.rid}</span></button>
          ))}
        </div>
      )}

      {found !== null && (
        <>
          <div className="install-file">
            <Icon name="package" />
            <span className="asset-name">{found.name ?? found.rid}</span>
            <span className="badge">Mirror酱 {found.rid}</span>
            <span className="muted small">最新 {found.version}</span>
          </div>
          {cdk === false && (
            <div className="notice info left small">
              <span>还没有填写 Mirror酱 CDK，没法从 Mirror酱 下载。{found.repo !== undefined ? '也可以从 GitHub 安装，填了 CDK 后它的更新会走 Mirror酱。' : ''}</span>
            </div>
          )}
          <div className="key-actions">
            <span className="muted small">{found.repo === undefined ? '' : `GitHub：${found.repo}`}</span>
            <span className="spacer" />
            {found.repo !== undefined && <button className="small-button" disabled={busy} onClick={() => onGitHub(found.repo!)}>从 GitHub 安装</button>}
            <button className="primary" onClick={() => void install()} disabled={busy || cdk === false}>安装 {found.version}</button>
          </div>
        </>
      )}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}

const STEPS: readonly ScriptJob['phase'][] =['resolving', 'downloading', 'verifying', 'extracting', 'checking', 'done']

/** An install under way: where it comes from, each step, and while downloading how much, how fast and how long is left. */
function InstallProgress({ client, repo, tag, asset, size, job, onDone, onRetry, onClose }: {
  client: AdgClient
  repo: string
  tag: string
  asset: string
  size?: number | undefined
  job: ScriptJob | undefined
  onDone: () => void
  onRetry: () => void
  onClose: () => void
}) {
  const phase = job?.phase ?? 'queued'
  const running = job === undefined || job.endedAt === undefined
  const speed = useSpeed(job?.received)
  const total = job?.total ?? size
  const ratio = total !== undefined && total > 0 && job?.received !== undefined ? Math.min(1, job.received / total) : undefined
  // The furthest step reached: a failed or cancelled job stops there.
  const reached = useRef(-1)
  const at = STEPS.indexOf(phase)
  if (at > reached.current) reached.current = at
  const title = phase === 'done' ? '安装完成' : phase === 'failed' ? '安装失败' : phase === 'cancelled' ? '已取消安装' : '正在安装'
  const stepState = (i: number): string => {
    if (phase === 'done' || i < reached.current) return 'done'
    if (i === reached.current) return running ? 'active' : 'stopped'
    return 'todo'
  }
  return (
    <section className="card panel-card install-progress" aria-live="polite">
      <div className="card-head">
        <div>
          <h3>{title}</h3>
          <p className="muted small">{repo} · {tag}</p>
        </div>
        <button className="icon-button" aria-label="关闭" title={running ? '关掉面板，安装在后台继续（左边列表里能看到进度）' : '关闭'} onClick={onClose}><Icon name="close" /></button>
      </div>
      <div className="install-file"><Icon name="package" /><span className="asset-name">{asset}</span>{size !== undefined && <span className="muted small">{formatBytes(size)}</span>}</div>

      <ol className="install-steps">
        {STEPS.slice(0, -1).map((step, i) => {
          const state = stepState(i)
          return (
            <li key={step} className={`install-step ${state}`}>
              <span className="install-step-mark">{state === 'done' ? <Icon name="check" /> : state === 'stopped' ? <Icon name="close" /> : i + 1}</span>
              <span>{PHASE_LABEL[step]}</span>
            </li>
          )
        })}
      </ol>

      {running && (
        <div className="install-bar">
          <div className={`progress ${phase === 'downloading' && ratio !== undefined ? '' : 'indeterminate'}`} aria-hidden="true">
            <span style={phase === 'downloading' && ratio !== undefined ? { width: `${(ratio * 100).toFixed(1)}%` } : undefined} />
          </div>
          <div className="install-numbers muted small">
            <span>{job === undefined ? '等待开始…' : job.message ?? PHASE_LABEL[phase]}</span>
            {phase === 'downloading' && job?.received !== undefined && (
              <span className="install-bytes">
                {formatBytes(job.received)}{total !== undefined ? ` / ${formatBytes(total)}` : ''}
                {ratio !== undefined ? ` · ${Math.floor(ratio * 100)}%` : ''}
                {speed !== undefined ? ` · ${formatBytes(Math.round(speed))}/s` : ''}
                {speed !== undefined && speed > 0 && total !== undefined ? ` · 还要 ${duration((total - job.received) / speed)}` : ''}
              </span>
            )}
          </div>
        </div>
      )}
      {job?.error !== undefined && <div className="notice error left"><Icon name="alert" /><span>{job.error}</span></div>}

      <div className="key-actions">
        <span className="muted small">{running ? '可以关掉这个面板，安装会在后台继续。' : phase === 'done' ? `已安装 ${job?.version ?? tag}。` : ''}</span>
        <span className="spacer" />
        {running && job !== undefined && <button className="small-button" onClick={() => void client.connection.call('scripts/jobs/cancel', { jobId: job.id }).catch(() => {})}>取消安装</button>}
        {(phase === 'failed' || phase === 'cancelled') && <button className="small-button" onClick={onRetry}>重新选择</button>}
        {phase === 'done' && <button className="primary small-button" onClick={onDone}>查看脚本</button>}
      </div>
    </section>
  )
}

/** Bytes per second over the last few seconds of a growing count. */
function useSpeed(received: number | undefined): number | undefined {
  const samples = useRef<{ at: number; bytes: number }[]>([])
  const [speed, setSpeed] = useState<number | undefined>(undefined)
  useEffect(() => {
    if (received === undefined) return
    const now = Date.now()
    const list = [...samples.current.filter(s => now - s.at <= 4000 && s.bytes <= received), { at: now, bytes: received }]
    samples.current = list
    const first = list[0]!
    if (now - first.at >= 500) setSpeed((received - first.bytes) / ((now - first.at) / 1000))
  }, [received])
  return speed
}

/** "12 秒", "3 分 5 秒". */
function duration(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return '—'
  if (seconds < 60) return `${Math.max(1, Math.round(seconds))} 秒`
  return `${Math.floor(seconds / 60)} 分 ${Math.round(seconds % 60)} 秒`
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
