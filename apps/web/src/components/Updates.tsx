/**
 * A newer release on GitHub (apps/desktop/updates.mjs): the card in the
 * floating dock, and the actions 「设置 → 关于」 shares with it. Only in the
 * installed desktop app; in a browser, or run from the repository, nothing.
 */
import { useEffect, useState, type ReactNode } from 'react'
import { desktop, type UpdateState, type UpdatesBridge } from '../desktop.ts'
import { Icon } from './Icons.tsx'

/** 「稍后」 hides the card until the app starts again. */
const LATER_KEY = 'adg.update.later'

/** @returns undefined while loading, null when this build does not update itself. */
export function useUpdates(): { bridge: UpdatesBridge | undefined; state: UpdateState | null | undefined } {
  const bridge = desktop()?.updates
  const [state, setState] = useState<UpdateState | null | undefined>(bridge === undefined ? null : undefined)
  useEffect(() => {
    if (bridge === undefined) return
    let live = true
    bridge.state().then(s => { if (live) setState(s) }, () => { if (live) setState(null) })
    const off = bridge.onChange(s => { if (live) setState(s) })
    return () => { live = false; off() }
  }, [bridge])
  return { bridge, state }
}

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Download, then 「退出并安装」; the progress and errors in between. */
export function UpdateActions({ bridge, state, extra }: { bridge: UpdatesBridge; state: UpdateState; extra?: ReactNode }) {
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const latest = state.latest
  if (latest === undefined) return null
  const download = state.download?.version === latest.version ? state.download : undefined
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch(e => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
  }
  return (
    <div className="update-actions">
      {download?.state === 'downloading' && (
        <div className="update-progress">
          <div className="progress" role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={download.total} aria-valuenow={download.received}>
            <span style={{ width: `${download.total > 0 ? Math.min(100, (download.received / download.total) * 100) : 0}%` }} />
          </div>
          <small className="muted">正在下载 {formatSize(download.received)} / {formatSize(download.total)}</small>
        </div>
      )}
      {download?.state === 'ready' && <p className="muted small">安装时程序会退出，正在跑的脚本会被中断；装好后自动重新打开，数据和定时任务都在。</p>}
      {download?.state === 'failed' && <p className="error small">{download.error}</p>}
      {error !== null && <p className="error small">{error}</p>}
      <div className="update-buttons">
        {extra}
        {download?.state === 'ready'
          ? <button className="primary small-button" disabled={installing} onClick={() => { setInstalling(true); run(() => bridge.install().finally(() => setInstalling(false))) }}>{installing ? '正在启动安装…' : '退出并安装'}</button>
          : <button className="primary small-button" disabled={download?.state === 'downloading'} onClick={() => run(() => bridge.download())}>
              {download?.state === 'failed' ? '重新下载' : download?.state === 'downloading' ? '正在下载…' : `下载更新（${formatSize(latest.size)}）`}
            </button>}
      </div>
    </div>
  )
}

/** The dock's card: shown for a newer version not skipped, until 「稍后」. */
export function UpdateCard() {
  const { bridge, state } = useUpdates()
  const [later, setLater] = useState(() => { try { return sessionStorage.getItem(LATER_KEY) } catch { return null } })
  const latest = state?.latest
  if (bridge === undefined || state == null || latest === undefined) return null
  const active = state.download?.version === latest.version && state.download.state !== 'failed'
  if (!active && (latest.version === state.skipped || latest.version === later)) return null
  const postpone = () => {
    try { sessionStorage.setItem(LATER_KEY, latest.version) } catch { /* only for this window then */ }
    setLater(latest.version)
  }
  return (
    <div className="approval-card update-card" role="status">
      <div className="approval-head">
        <Icon name="download" />
        <div className="approval-text">
          <span className="approval-title">MultiGameAssistant {latest.version} 可以更新了</span>
          <span className="approval-tool">
            当前 {state.current}{latest.prerelease ? ' · 预发布版' : ''} · <a href={latest.notesUrl} target="_blank" rel="noreferrer">查看更新内容</a>
          </span>
        </div>
        {!active && <button className="ghost icon-button update-close" aria-label="稍后提醒" title="稍后（下次启动再提醒）" onClick={postpone}><Icon name="close" /></button>}
      </div>
      <UpdateActions bridge={bridge} state={state} extra={!active && <button className="ghost small-button" onClick={() => void bridge.skip(latest.version)}>跳过这个版本</button>} />
    </div>
  )
}
