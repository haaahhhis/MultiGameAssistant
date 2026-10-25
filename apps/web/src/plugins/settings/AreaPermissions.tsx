import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { AGENT_AREAS, type AreaPolicy, type MonitorSettings, type PermissionsState } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

const POLICIES: readonly { policy: AreaPolicy; label: string; hint: string }[] = [
  { policy: 'default', label: '默认', hint: '跟着上面的模式走' },
  { policy: 'allow', label: '允许', hint: '不问你，直接做' },
  { policy: 'ask', label: '先问我', hint: '每次都先问你，「完全访问」时也问' },
  { policy: 'deny', label: '不允许', hint: 'agent 不能做，会告诉你被关掉了' },
]

const INTERVENE: readonly { value: MonitorSettings['intervene']; label: string }[] = [
  { value: 'act', label: '诊断并处理' },
  { value: 'diagnose', label: '只诊断' },
  { value: 'off', label: '不干预' },
]

/**
 * 设置 → 权限, by area: everything the agent can do on its own, each allowed
 * without asking, asked every time, or not allowed — on top of the mode above.
 * 主动干预 is the monitor's own setting (what happens when a script fails).
 */
export function AreaPermissions({ client, state, onState }: { client: AdgClient; state: PermissionsState; onState: (next: PermissionsState) => void }) {
  const capabilities = useStore(client.capabilities)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [monitor, setMonitor] = useState<MonitorSettings | null>(null)
  const hasMonitor = capabilities.has('monitor')
  useEffect(() => {
    if (!hasMonitor) return
    let live = true
    client.connection.call('monitor/settings', {}).then(s => { if (live) setMonitor(s) }).catch(() => {})
    return () => { live = false }
  }, [client, hasMonitor])

  const set = async (area: string, policy: AreaPolicy) => {
    setBusy(area)
    setError(null)
    try { onState(await client.connection.call('permissions/area/set', { area, policy })) } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }
  const setIntervene = async (value: MonitorSettings['intervene']) => {
    setBusy('intervene')
    setError(null)
    try { setMonitor(await client.connection.call('monitor/settings/set', { intervene: value })) } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>按范围设置</h3>
          <p className="muted small">agent 能自己做的事，一项一项决定：{POLICIES.map(p => `「${p.label}」${p.hint}`).join('；')}。</p>
        </div>
      </div>
      <div className="area-list">
        {hasMonitor && monitor !== null && (
          <div className="area-row">
            <div className="area-text">
              <strong>主动干预出问题的脚本</strong>
              <span className="muted small">脚本卡住、报错，自动处理解决不了时交给 agent：「诊断并处理」会暂停脚本、看屏幕、点击输入来解决；「只诊断」只说明原因由你决定。</span>
            </div>
            <div className="segmented-control area-choice" role="radiogroup" aria-label="主动干预">
              {INTERVENE.map(o => (
                <button key={o.value} role="radio" aria-checked={monitor.intervene === o.value} className={monitor.intervene === o.value ? 'active' : ''} disabled={busy !== null} onClick={() => void setIntervene(o.value)}>{o.label}</button>
              ))}
            </div>
          </div>
        )}
        {AGENT_AREAS.map(area => {
          const current = state.areas[area.id] ?? 'default'
          return (
            <div key={area.id} className="area-row">
              <div className="area-text">
                <strong>{area.title}</strong>
                <span className="muted small">{area.description}</span>
              </div>
              <div className="segmented-control area-choice" role="radiogroup" aria-label={area.title}>
                {POLICIES.map(p => (
                  <button key={p.policy} role="radio" aria-checked={current === p.policy} title={p.hint}
                    className={`${current === p.policy ? 'active' : ''} ${p.policy}`} disabled={busy !== null} onClick={() => void set(area.id, p.policy)}>{p.label}</button>
                ))}
              </div>
            </div>
          )
        })}
      </div>
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}
