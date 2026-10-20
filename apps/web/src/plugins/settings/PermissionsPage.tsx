import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { PermissionMode, PermissionsState } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

const MODES: readonly { mode: PermissionMode; title: string; text: string }[] = [
  { mode: 'ask', title: '每次确认（推荐）', text: 'agent 的命令在沙箱里运行；安装陌生仓库、操作屏幕、沙箱外的命令、修改脚本文件等，都先问你。' },
  { mode: 'full', title: '完全访问', text: '不用沙箱，所有需要确认的操作都自动允许，也可以修改脚本文件：agent 想改什么就改什么，不再问你。' },
]

/** 设置 → 权限: whether the agent asks before acting, and what full access allowed. */
export function PermissionsPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [state, setState] = useState<PermissionsState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => client.connection.on('permissions/changed', next => setState(next)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('permissions/get', {}).then(s => { if (live) setState(s) }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state])

  const choose = async (mode: PermissionMode) => {
    if (state?.mode === mode) return
    if (mode === 'full' && !window.confirm('打开「完全访问」后，agent 可以不经确认运行任何命令、修改或删除任何文件（包括脚本文件）、操作屏幕、安装软件。只在你信任当前模型、并且需要它自己完成整件事时打开。\n\n确定打开吗？')) return
    setBusy(true)
    setError(null)
    try { setState(await client.connection.call('permissions/set', { mode })) } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  return (
    <div className="settings-page">
      <h2>权限</h2>
      <p>决定 agent 做事之前要不要先问你。对所有会话都有效，包括飞书里的对话、异常处理和流水线里的 agent 步骤。</p>
      <section className="card">
        <div className="permission-options" role="radiogroup" aria-label="权限">
          {MODES.map(m => (
            <button key={m.mode} role="radio" aria-checked={state?.mode === m.mode} disabled={busy || state === null}
              className={`permission-option ${m.mode} ${state?.mode === m.mode ? 'active' : ''}`} onClick={() => void choose(m.mode)}>
              <span className="permission-dot" aria-hidden="true" />
              <span className="permission-text"><strong>{m.title}</strong><span>{m.text}</span></span>
            </button>
          ))}
        </div>
        {state?.mode === 'full' && (
          <div className="notice warn-note left small"><Icon name="alert" /><span>完全访问已打开{state.since === undefined ? '' : `（${relativeTime(state.since, now)}）`}。agent 不会再请求确认；它仍然不会替你输入密码、验证码或付款。用完记得改回「每次确认」。</span></div>
        )}
        {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
      </section>
      {state !== null && state.recent.length > 0 && (
        <section className="card">
          <h3>完全访问自动允许的操作</h3>
          <p className="muted small">程序这次启动以来，最近 {state.recent.length} 条。</p>
          <ul className="version-list">
            {state.recent.map((r, i) => (
              <li key={i}>
                <span className="badge">{r.toolName}</span>
                <span className="permission-reason">{r.reason ?? '（没有说明）'}</span>
                <span className="spacer" />
                <span className="session-time">{relativeTime(r.at, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
