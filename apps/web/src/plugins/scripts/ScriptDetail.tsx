import { useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { EnvItem, ScriptInfo, ScriptJob } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { relativeTime } from '../../components/SessionList.tsx'
import { errorText, FAMILY_LABEL, isActive } from './data.ts'
import { JobProgress } from './JobProgress.tsx'
import { GuardCard, PackCard } from './PackCards.tsx'
import { ConfigCard } from './ConfigCard.tsx'
import { GameCard } from './GameCard.tsx'
import { RunsCard } from './RunsCard.tsx'

const ENV_BADGE: Readonly<Record<EnvItem['status'], [string, string]>> = {
  ok: ['ok', '满足'],
  missing: ['warn', '缺少'],
  outdated: ['warn', '版本过旧'],
  unknown: ['warn', '无法判断'],
  unsupported: ['', '暂不检测'],
}

export function ScriptDetail({ client, script, job, onRemoved, openSession }: {
  client: AdgClient
  script: ScriptInfo
  job: ScriptJob | undefined
  onRemoved: () => void
  openSession: (sessionId: string) => void
}) {
  const now = useNow(60_000)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [message, setMessage] = useState<string | null>(null)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const [deleteFiles, setDeleteFiles] = useState(false)
  // A finished job from before this entry existed belonged to an earlier script with the same id.
  const shown = job !== undefined && (job.endedAt === undefined || job.startedAt >= script.addedAt - 1000) ? job : undefined
  const running = isActive(shown)
  const capabilities = useStore(client.capabilities)
  const github = script.source.kind === 'github'

  const act = async (name: string, fn: () => Promise<string | void>) => {
    setBusy(name)
    setError(null)
    setMessage(null)
    try {
      const note = await fn()
      if (typeof note === 'string') setMessage(note)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  return (
    <div className="script-detail">
      <header className="script-detail-head">
        <div>
          <h2>{script.name}</h2>
          <div className="script-meta">
            <span className="chip">{script.id}</span>
            {script.family !== undefined && <span className="badge">{FAMILY_LABEL[script.family] ?? script.family}</span>}
            {script.packId !== undefined ? <span className="badge ok">脚本包 {script.packId}</span> : <span className="badge warn">无脚本包</span>}
            <span className="muted small">{github ? `GitHub · ${script.source.kind === 'github' ? script.source.repo : ''}` : '本地导入'}</span>
          </div>
        </div>
      </header>

      {shown !== undefined && <JobProgress client={client} job={shown} />}

      <section className="card">
        <div className="card-head">
          <div><h3>位置与版本</h3><p className="muted small">{script.dir ?? '（无）'}</p></div>
          {script.dir !== undefined && (
            <button className="ghost small-button" onClick={() => void navigator.clipboard?.writeText(script.dir!)}><Icon name="copy" />复制路径</button>
          )}
        </div>
        {github ? (
          <>
            <ul className="version-list">
              {script.versions.map(v => (
                <li key={v.version} className={v.current ? 'current' : ''}>
                  <span className="version-name">{v.version}</span>
                  {v.current && <span className="badge ok">当前</span>}
                  <span className="muted small">{v.asset?.name ?? ''} · {relativeTime(v.installedAt, now)}</span>
                  <span className="spacer" />
                  {!v.current && (
                    <button className="small-button" disabled={running || busy !== null} onClick={() => void act('rollback', async () => {
                      await client.connection.call('scripts/rollback', { id: script.id, version: v.version })
                      return `已切换到 ${v.version}`
                    })}>切换到此版本</button>
                  )}
                </li>
              ))}
            </ul>
            <div className="key-actions">
              <span className="muted small">
                {script.update === undefined ? '还没有检查过更新' : script.update.available ? `有新版本 ${script.update.latest}` : `已是最新（${script.update.latest}）`}
                {script.update !== undefined && ` · ${relativeTime(script.update.checkedAt, now)}检查`}
              </span>
              <span className="spacer" />
              <button className="small-button" disabled={running || busy !== null} onClick={() => void act('check', async () => {
                const r = await client.connection.call('scripts/checkUpdate', { id: script.id })
                return r.available ? `发现新版本 ${r.latest}` : '已是最新版本'
              })}>{busy === 'check' ? '检查中…' : '检查更新'}</button>
              <button className="primary small-button" disabled={running || busy !== null || script.update?.available !== true} onClick={() => void act('update', async () => {
                const r = await client.connection.call('scripts/update', { id: script.id })
                return r.upToDate ? '已是最新版本' : undefined
              })}>更新</button>
            </div>
          </>
        ) : (
          <p className="muted small">本地导入的脚本原地使用，由你自己维护版本；AutoDailyGamePlay 不会改动这个目录。</p>
        )}
      </section>

      <section className="card">
        <div className="card-head">
          <div>
            <h3>运行环境</h3>
            <p className="muted small">{script.env === undefined ? (script.packId === undefined ? '没有脚本包，暂时不知道它需要什么' : '还没有检查') : `${relativeTime(script.env.checkedAt, now)}检查`}</p>
          </div>
          <button className="small-button" disabled={running || busy !== null} onClick={() => void act('env', async () => {
            const r = await client.connection.call('scripts/envCheck', { id: script.id })
            return r.ok ? '运行环境满足' : '有依赖需要处理'
          })}>{busy === 'env' ? '检查中…' : '重新检查'}</button>
        </div>
        {script.env !== undefined && script.env.items.length === 0 && <div className="muted small">脚本包没有声明额外依赖。</div>}
        {script.env !== undefined && script.env.items.length > 0 && (
          <ul className="env-list">
            {script.env.items.map(item => {
              const [tone, text] = ENV_BADGE[item.status]
              return (
                <li key={item.kind}>
                  <div className="env-main">
                    <span className="env-label">{item.label}</span>
                    <span className={`badge ${tone}`}>{text}</span>
                    {item.found !== undefined && <span className="muted small">{item.found}</span>}
                  </div>
                  {item.detail !== undefined && <div className="muted small">{item.detail}</div>}
                  {item.fix !== undefined && (
                    <div className="env-fix">
                      <span className="muted small">{item.fix.description}</span>
                      {item.fix.kind !== 'manual' && (
                        <button className="small-button" disabled={running || busy !== null} onClick={() => void act(`fix-${item.kind}`, async () => {
                          await client.connection.call('scripts/envFix', { id: script.id, kind: item.kind })
                        })}>{item.fix.kind === 'installer' ? '安装（需要管理员）' : '自动修复'}</button>
                      )}
                    </div>
                  )}
                </li>
              )
            })}
          </ul>
        )}
      </section>

      {capabilities.has('runs') && script.dir !== undefined && <RunsCard client={client} scriptId={script.id} packId={script.packId} />}
      {capabilities.has('runs') && script.packId !== undefined && script.dir !== undefined && <ConfigCard client={client} script={script} />}
      {capabilities.has('runs') && script.packId !== undefined && script.dir !== undefined && <GameCard key={script.id} client={client} scriptId={script.id} />}
      {capabilities.has('packs') && <PackCard client={client} script={script} openSession={openSession} />}

      {script.probe !== undefined && (
        <section className="card">
          <div className="card-head"><div><h3>目录概况</h3><p className="muted small">只是快速查看；启动方式、任务和配置的完整分析请用上面的「让 agent 分析」。</p></div></div>
          <div className="probe-grid">
            <span className="field-label">可执行文件</span>
            <div className="chip-row">{script.probe.executables.length === 0 ? <span className="muted small">未发现</span> : script.probe.executables.map(e => <span key={e} className="chip">{e}</span>)}</div>
            <span className="field-label">标志文件</span>
            <div className="chip-row">{script.probe.markers.length === 0 ? <span className="muted small">未发现</span> : script.probe.markers.map(m => <span key={m} className="chip">{m}</span>)}</div>
          </div>
        </section>
      )}

      {capabilities.has('guard') && <GuardCard client={client} script={script} />}

      <section className="card danger-zone">
        {!confirmRemove ? (
          <div className="key-actions">
            <span className="muted small">{github ? '从脚本库移除；可选择同时删除已安装的文件。' : '从脚本库移除；你的目录不会被删除。'}</span>
            <span className="spacer" />
            <button className="danger-outline small-button" disabled={running} onClick={() => setConfirmRemove(true)}>移除</button>
          </div>
        ) : (
          <div className="key-actions">
            {github && (
              <label className="check-label"><input type="checkbox" checked={deleteFiles} onChange={e => setDeleteFiles(e.target.checked)} />同时删除所有已安装版本</label>
            )}
            <span className="spacer" />
            <button className="small-button" onClick={() => setConfirmRemove(false)}>取消</button>
            <button className="danger small-button" disabled={busy !== null} onClick={() => void act('remove', async () => {
              await client.connection.call('scripts/remove', { id: script.id, deleteFiles: github && deleteFiles })
              onRemoved()
            })}>确认移除</button>
          </div>
        )}
      </section>

      {message !== null && <div className="notice info">{message}</div>}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}
