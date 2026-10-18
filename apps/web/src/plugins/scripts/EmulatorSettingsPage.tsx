import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { RequestResult } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useStore } from '../../hooks.ts'
import { errorText } from './data.ts'

type Status = RequestResult<'emulators/status'>

/** Which emulator ADB tasks use: detected MuMu installs and instances, or a manual address. */
export function EmulatorSettingsPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const [data, setData] = useState<Status | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [manual, setManual] = useState('')

  useEffect(() => client.connection.on('emulators/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('emulators/status', { refresh: revision === 0 }).then(s => {
      if (!live) return
      setData(s)
      setManual(s.settings.manualAddress ?? '')
    }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, revision])

  const act = async (name: string, fn: () => Promise<unknown>) => {
    setBusy(name)
    setError(null)
    try {
      await fn()
      setRevision(r => r + 1)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }
  const set = (patch: Parameters<typeof client.connection.call<'emulators/settings/set'>>[1]) => act('settings', () => client.connection.call('emulators/settings/set', patch))

  return (
    <div className="settings-page">
      <h2>模拟器</h2>
      <p>需要安卓模拟器的任务（如 MAA）运行前，会自动启动这里选定的实例并取得 ADB 地址。分辨率请设为 16:9（如 1280×720）。</p>

      <section className="card">
        <div className="card-head">
          <div><h3>当前使用</h3><p className="muted small">{data?.selection.label ?? '…'}</p></div>
          <button className="small-button" disabled={busy !== null} onClick={() => void act('refresh', () => client.connection.call('emulators/status', { refresh: true }))}>重新检测</button>
        </div>
        {data?.selection.problem !== undefined && <div className="notice info left small"><Icon name="info" /><span>{data.selection.problem}。可以对 agent 说「安装 MuMu 模拟器」，或在下面填写手动 ADB 地址。</span></div>}
      </section>

      {data?.providers.map(provider => (
        <section key={provider.manager} className="card">
          <div className="card-head">
            <div><h3>{provider.name}{provider.version === undefined ? '' : ` ${provider.version}`}</h3><p className="muted small">{provider.manager}</p></div>
            {data.settings.mumuManager === provider.manager && <span className="badge ok">已指定</span>}
          </div>
          {provider.error !== undefined && <div className="notice error left small"><Icon name="alert" /><span>{provider.error}</span></div>}
          <ul className="version-list">
            {provider.instances.map(instance => (
              <li key={instance.index} className={instance.index === data.settings.instance ? 'current' : ''}>
                <span className="version-name">{instance.index}</span>
                <span>{instance.name}</span>
                <span className={`badge ${instance.ready ? 'ok' : ''}`}>{instance.ready ? '已启动' : instance.running ? '启动中' : '未运行'}</span>
                {instance.adb !== undefined && <span className="muted small">{instance.adb}</span>}
                <span className="spacer" />
                {instance.index !== data.settings.instance && <button className="small-button" disabled={busy !== null} onClick={() => void set({ instance: instance.index })}>任务用这个</button>}
                {instance.ready
                  ? <button className="small-button" disabled={busy !== null} onClick={() => void act(`stop-${instance.index}`, () => client.connection.call('emulators/stop', { index: instance.index }))}>关闭</button>
                  : <button className="small-button" disabled={busy !== null} onClick={() => void act(`start-${instance.index}`, () => client.connection.call('emulators/start', { index: instance.index }))}>{busy === `start-${instance.index}` ? '启动中…' : '启动'}</button>}
              </li>
            ))}
          </ul>
        </section>
      ))}

      {data !== null && (
        <section className="card">
          <h3>设置</h3>
          <label className="check-label"><input type="checkbox" checked={data.settings.autoStart} onChange={e => void set({ autoStart: e.target.checked })} />任务需要时自动启动模拟器</label>
          <label className="field-label" htmlFor="manual-adb">手动 ADB 地址（其他模拟器或真机，可选）</label>
          <div className="key-input">
            <input id="manual-adb" className="text-input plain" value={manual} onChange={e => setManual(e.target.value)} placeholder="例如 127.0.0.1:5555；填写后不再管理 MuMu" spellCheck={false} />
            <button className="small-button" disabled={busy !== null} onClick={() => void set({ manualAddress: manual.trim() === '' ? null : manual.trim() })}>保存</button>
          </div>
          <label className="field-label" htmlFor="boot-timeout">等待安卓启动的最长时间（秒）</label>
          <input id="boot-timeout" className="text-input plain" type="number" min={30} max={900} defaultValue={data.settings.bootTimeoutSeconds}
            onBlur={e => void set({ bootTimeoutSeconds: Math.max(30, Math.min(900, Number(e.target.value) || 180)) })} />
        </section>
      )}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}
