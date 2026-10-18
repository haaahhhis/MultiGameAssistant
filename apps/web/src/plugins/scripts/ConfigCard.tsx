import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { RequestResult, ScriptInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { relativeTime } from '../../components/SessionList.tsx'
import { errorText } from './data.ts'

type Status = RequestResult<'configs/status'>

/**
 * The script's local config copy: what AutoDailyGamePlay runs with. The
 * original project config stays as the user left it; changes made in the
 * script's own window show up here as drift to import.
 */
export function ConfigCard({ client, script }: { client: AdgClient; script: ScriptInfo }) {
  const status = useStore(client.connection.status)
  const now = useNow(60_000)
  const [data, setData] = useState<Status | null>(null)
  const [revision, setRevision] = useState(0)
  const [confirmImport, setConfirmImport] = useState(false)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  // A finished settings session or run may have changed the local copy.
  useEffect(() => client.connection.on('runs/state', run => {
    if (run.scriptId === script.id && run.endedAt !== undefined) setRevision(r => r + 1)
  }), [client, script.id])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('configs/status', { scriptId: script.id })
      .then(s => { if (live) { setData(s); setError(null) } })
      .catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, script.id, script.packId, status.state, revision])

  const act = async (fn: () => Promise<string | void>) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const message = await fn()
      if (typeof message === 'string') setNote(message)
      setRevision(r => r + 1)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const present = data?.files.filter(f => f.local) ?? []
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>配置</h3>
          <p className="muted small">通过本应用运行时，用的是本地保存的配置；原项目里的配置不会被改动，你自己打开脚本时仍是它原来的设置。</p>
        </div>
        <button className="small-button" disabled={busy || status.state !== 'open'} onClick={() => void act(async () => {
          await client.connection.call('configs/open', { scriptId: script.id })
          return '已打开脚本的设置界面：改好后关掉窗口，设置会存到本地配置'
        })}><Icon name="settings" />打开脚本修改设置</button>
      </div>

      {data !== null && (
        <>
          {data.drift.length > 0 && (
            <div className="notice warn-box left">
              <Icon name="info" />
              <span>原项目的配置在导入后改过（{data.drift.join('、')}），可能是在脚本自己的界面里改的。本应用仍按本地配置运行；需要的话可以导入。</span>
            </div>
          )}
          <ul className="version-list">
            {data.files.map(f => (
              <li key={f.file}>
                <span className="version-name">{f.file}</span>
                {f.local ? <span className="badge ok">本地已保存</span> : <span className="badge">本地没有</span>}
                {f.changed && <span className="badge warn">原项目已改动</span>}
                {!f.original && <span className="muted small">原项目里没有</span>}
              </li>
            ))}
            {data.files.length === 0 && <li className="muted small">脚本包没有声明配置文件</li>}
          </ul>
          <div className="key-actions">
            <span className="muted small">
              {data.importedAt === undefined ? '还没有导入' : `${relativeTime(data.importedAt, now)}从原项目导入`}
              {present.length > 0 && ' · '}
              {present.length > 0 && <button className="link-button" onClick={() => void navigator.clipboard?.writeText(data.dir)}>复制本地配置目录</button>}
            </span>
            <span className="spacer" />
            {!confirmImport
              ? <button className="small-button" disabled={busy} onClick={() => setConfirmImport(true)}>导入原项目设置</button>
              : (
                <>
                  <span className="muted small">会用原项目当前的配置覆盖本地配置</span>
                  <button className="small-button" onClick={() => setConfirmImport(false)}>取消</button>
                  <button className="primary small-button" disabled={busy} onClick={() => void act(async () => {
                    const r = await client.connection.call('configs/import', { scriptId: script.id })
                    setConfirmImport(false)
                    return r.imported.length > 0 ? `已导入：${r.imported.join('、')}` : '原项目里还没有这些配置文件'
                  })}>确认导入</button>
                </>
              )}
          </div>
        </>
      )}
      {note !== null && <div className="notice info left small">{note}</div>}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}
