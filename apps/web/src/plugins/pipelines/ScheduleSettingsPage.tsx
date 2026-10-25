import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { RequestResult } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

type Status = RequestResult<'schedule/status'>

const clock = (at: number) => new Date(at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', weekday: 'short', hour: '2-digit', minute: '2-digit' })

const OUTCOME: Readonly<Record<string, [string, string]>> = {
  fired: ['ok', '已运行'], missed: ['warn', '错过'], skipped: ['', '跳过'], failed: ['warn', '没能运行'],
}

/** Starting at logon, what runs after it, power (timed wake, keeping awake), upcoming times, and what the scheduler did. */
export function ScheduleSettingsPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [data, setData] = useState<Status | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => client.connection.on('schedule/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => client.connection.on('pipelines/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => client.connection.on('schedule/power', power => setData(d => (d === null ? d : { ...d, power }))), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('schedule/status', {}).then(s => { if (live) setData(s) }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, revision])

  const set = async (patch: Parameters<typeof client.connection.call<'schedule/settings/set'>>[1]) => {
    setBusy(true)
    setError(null)
    try {
      setData(await client.connection.call('schedule/settings/set', patch))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const settings = data?.settings
  return (
    <div className="settings-page">
      <h2>定时与自启</h2>
      <p>每条流水线的运行时间和结束后做什么（关游戏、关模拟器、睡眠或关机）在「编排」页里设置。这里设置电脑开机登录后是否自动启动 MultiGameAssistant，以及电脑睡着时要不要按时醒来。关掉窗口后程序在托盘里继续运行，定时照常执行。</p>

      {data !== null && settings !== undefined && (
        <section className="card">
          <div className="card-head">
            <div><h3>开机自启</h3><p className="muted small">{data.autostart.detail ?? (data.autostart.registered ? '已在 Windows 任务计划程序中注册（登录后启动，最小化到托盘）' : '登录 Windows 后自动启动并最小化到托盘')}</p></div>
            <span className={`badge ${data.autostart.registered ? 'ok' : ''}`}>{data.autostart.registered ? '已开启' : '未开启'}</span>
          </div>
          <label className="check-label"><input type="checkbox" checked={settings.autostart} disabled={busy || !data.autostart.available} onChange={e => void set({ autostart: e.target.checked })} />登录 Windows 后自动启动</label>
          <div className="notice info left small"><Icon name="info" /><span>软件启动时运行哪些流水线、是否只在每天第一次启动时运行，在「编排」页每条流水线的「定时与失败」里设置。{settings.autostartPipelines.length > 0 ? `现在有 ${settings.autostartPipelines.length} 条。` : ''}</span></div>
          <label className="field-label" htmlFor="autostart-delay">开机自启后等待多少秒再运行流水线（等网络、桌面和显卡驱动就绪）</label>
          <input id="autostart-delay" className="text-input plain" type="number" min={0} max={1800} defaultValue={settings.autostartDelaySeconds}
            onBlur={e => void set({ autostartDelaySeconds: Math.max(0, Math.min(1800, Math.round(Number(e.target.value) || 0))) })} />
          {data.autostarted && <div className="notice info left small"><Icon name="info" /><span>这次是开机自动启动的。</span></div>}
        </section>
      )}

      {data !== null && settings !== undefined && (
        <section className="card">
          <div className="card-head">
            <div><h3>定时唤醒</h3><p className="muted small">{data.wake.detail ?? (data.wake.registered && data.wake.next !== undefined ? `已在 Windows 任务计划程序中注册，下次在 ${clock(data.wake.next)} 唤醒` : '电脑睡眠（或休眠）时，在定时任务开始前 2 分钟把它唤醒')}</p></div>
            <span className={`badge ${data.wake.registered ? 'ok' : ''}`}>{data.wake.registered ? '已开启' : '未开启'}</span>
          </div>
          <label className="check-label"><input type="checkbox" checked={settings.wakeToRun} disabled={busy || !data.wake.available} onChange={e => void set({ wakeToRun: e.target.checked })} />睡眠时按定时唤醒电脑</label>
          <p className="muted small">关机后不能唤醒。程序没开着时，唤醒会顺便把它在托盘里打开（不运行「软件启动时运行」的流水线）。要在 Windows 电源选项里允许唤醒定时器：控制面板 → 电源选项 → 更改计划设置 → 更改高级电源设置 → 睡眠 → 允许使用唤醒定时器 → 启用（笔记本的「使用电池」也要改）。</p>
          <h3>运行时防睡眠</h3>
          <p className="muted small">流水线或脚本运行时，电脑不会自己睡眠；前台脚本（用鼠标键盘的）运行时屏幕也保持亮着。全部结束后恢复 Windows 自己的设置。{data.power.awake ? '现在正在防睡眠。' : ''}</p>
          <label className="field-label" htmlFor="power-countdown">流水线结束后睡眠、休眠或关机前倒计时多少秒（这段时间里可以取消）</label>
          <input id="power-countdown" className="text-input plain" type="number" min={10} max={600} defaultValue={settings.powerCountdownSeconds}
            onBlur={e => void set({ powerCountdownSeconds: Math.max(10, Math.min(600, Math.round(Number(e.target.value) || 60))) })} />
        </section>
      )}

      {data !== null && (
        <section className="card">
          <h3>接下来</h3>
          {data.upcoming.length === 0 && <div className="muted small">没有开启定时的流水线。</div>}
          <ul className="version-list">
            {data.upcoming.map((u, i) => (
              <li key={i}><span className="version-name">{clock(u.at)}</span><span>{u.pipelineName}</span></li>
            ))}
          </ul>
        </section>
      )}

      {data !== null && data.history.length > 0 && (
        <section className="card">
          <h3>最近的定时记录</h3>
          <ul className="version-list">
            {data.history.map((h, i) => (
              <li key={i}>
                <span className={`badge ${OUTCOME[h.outcome]?.[0] ?? ''}`}>{OUTCOME[h.outcome]?.[1] ?? h.outcome}</span>
                <span>{h.pipelineName}</span>
                <span className="muted small">{h.slot}{h.detail === undefined ? '' : ` · ${h.detail}`}</span>
                <span className="spacer" />
                <span className="session-time">{relativeTime(h.at, now)}</span>
              </li>
            ))}
          </ul>
        </section>
      )}

      <section className="card">
        <h3>无人值守检查清单</h3>
        <ul className="guide-steps">
          <li>前台脚本（如三月七）需要已登录、没有锁屏的桌面：在 Windows 里设置自动登录（运行 <code>netplwiz</code>），关闭屏幕保护程序；睡眠唤醒后不要求登录（设置 → 帐户 → 登录选项 →「需要登录」选「从不」）。</li>
          <li>模拟器脚本（如 MAA）不受锁屏影响。</li>
          <li>运行期间程序会阻止电脑睡眠；想让睡着的电脑按时醒来跑定时任务，打开上面的「定时唤醒」。关机后的电脑不能被唤醒，可以在主板 BIOS 里设置定时开机，再配合开机自启。</li>
          <li>没接显示器时，游戏可能以很小的分辨率启动；可以接一个 HDMI 假负载（显卡欺骗器）。</li>
          <li>想在手机上收到结果，先在「设置 → 飞书」接好飞书。</li>
        </ul>
      </section>
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}
