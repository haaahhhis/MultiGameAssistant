/**
 * 设置 → 对话压缩 (compaction@1): whether dsh compacts a long conversation by
 * itself, and how full the model's context gets first. What compacting costs
 * is said up front: the agent keeps only the summary. dsh reads the settings
 * when the agent service starts, so a change waits for a restart; the desktop
 * app can restart the service from here.
 */
import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { DEFAULT_COMPACTION_THRESHOLD, MAX_COMPACTION_THRESHOLD, MIN_COMPACTION_THRESHOLD, type CompactionSettings } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { desktop } from '../../desktop.ts'
import { useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

type State = { settings: CompactionSettings; applied: CompactionSettings }

const same = (a: CompactionSettings, b: CompactionSettings) => a.auto === b.auto && a.threshold === b.threshold

export function CompactionPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The slider while it moves; saved once it rests. */
  const [threshold, setThreshold] = useState<number | null>(null)
  const restartService = desktop()?.restartService

  useEffect(() => {
    if (threshold === null || state === null) return
    if (threshold === state.settings.threshold) { setThreshold(null); return }
    const timer = setTimeout(() => void save({ ...state.settings, threshold }).then(() => setThreshold(null)), 400)
    return () => clearTimeout(timer)
  }, [threshold, state])

  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('compaction/get', {}).then(r => { if (live) setState(r) }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state])

  const save = async (settings: CompactionSettings) => {
    if (!settings.auto && state?.settings.auto === true && !window.confirm('关掉自动压缩后，对话超过模型的上下文长度时会直接出错，要手动压缩或开新对话才能继续。\n\n确定关掉吗？')) return
    setBusy(true)
    setError(null)
    try {
      setState(await client.connection.call('compaction/set', { settings }))
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }
  const restart = async () => {
    if (restartService === undefined || !window.confirm('重启 agent 服务：正在进行的对话和正在跑的脚本、流水线会被中断，大约需要半分钟。\n\n确定现在重启吗？')) return
    await restartService()
  }

  return (
    <div className="settings-page compaction-page">
      <h2>对话压缩</h2>
      <p>对话很长时，模型一次看不下全部内容。压缩会把较早的部分换成一份由模型写的摘要，之后 agent 只能看到这份摘要：</p>
      <ul className="compaction-costs">
        <li><strong>会丢失记忆</strong>：早先的细节（具体的命令和输出、日志、截图、你说过的原话）agent 不再记得；</li>
        <li>摘要可能漏掉或写错内容，而且不能撤销；</li>
        <li>界面上的聊天记录还在，只是 agent 看不到了。</li>
      </ul>
      {state !== null && (
        <section className="card">
          <label className="check-label">
            <input type="checkbox" checked={state.settings.auto} disabled={busy} onChange={e => void save({ ...state.settings, auto: e.target.checked })} />
            对话太长时自动压缩
          </label>
          <p className="muted small">{state.settings.auto
            ? '关掉后不会自动压缩：对话超过模型的上下文长度时会出错，需要手动压缩或开新对话。'
            : '已关闭：对话超过模型的上下文长度时会出错，需要手动压缩或开新对话。'}</p>
          <label className="field compaction-threshold">
            <span className="field-title">占满上下文的多少时压缩：<strong>{threshold ?? state.settings.threshold}%</strong>{(threshold ?? state.settings.threshold) === DEFAULT_COMPACTION_THRESHOLD ? '（默认）' : ''}</span>
            <input type="range" min={MIN_COMPACTION_THRESHOLD} max={MAX_COMPACTION_THRESHOLD} step={5} value={threshold ?? state.settings.threshold} disabled={!state.settings.auto}
              aria-label="压缩阈值（百分比）" onChange={e => setThreshold(Number(e.target.value))} />
            <span className="muted small">调低：压缩得早，回复快、花费少，但记得的细节少；调高：记得的多，但更可能临时压缩一大段。</span>
          </label>
          {!same(state.settings, state.applied) && (
            <div className="notice left">
              <Icon name="info" />
              <span>改动要重启 agent 服务才生效（现在还是：{state.applied.auto ? `自动压缩，${state.applied.threshold}%` : '不自动压缩'}）。{restartService === undefined ? '重启 MultiGameAssistant（或 dsh）后生效。' : ''}</span>
              {restartService !== undefined && <button className="small-button" onClick={() => void restart()}>重启 agent 服务</button>}
            </div>
          )}
          {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
        </section>
      )}
      <section className="card">
        <h3>手动压缩</h3>
        <p className="muted small">在对话页右上角点「压缩对话」按钮（<Icon name="compress" />），会先说明代价再确认。对话变慢、或报上下文超长时用；agent 正在工作时不能压缩。</p>
      </section>
      {state === null && error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}
