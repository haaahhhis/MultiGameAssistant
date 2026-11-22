/**
 * 设置 → 对话压缩 (compaction@1): whether dsh compacts a long conversation by
 * itself, and how full the model's context gets first. What compacting costs
 * is said up front: the agent keeps only the summary. dsh reads the settings
 * when the agent service starts, so a change waits for a restart; the desktop
 * app can restart the service from here. Low-context mode (the last 12 hours
 * kept, older compacted once a task is over) and its archiving (summaries of
 * conversation older than some days leave the context too) are read each
 * time: they need no restart. Which model writes the summaries (the
 * conversation's own, or one picked here) is read at start too.
 */
import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { ARCHIVE_DAYS_CHOICES, DEFAULT_COMPACTION_THRESHOLD, LOW_COMPACTION_THRESHOLD, MAX_COMPACTION_THRESHOLD, MIN_COMPACTION_THRESHOLD, type CompactionSettings } from '@adg/protocol'
import { confirm } from '../../components/Dialog.tsx'
import { Icon } from '../../components/Icons.tsx'
import { Select } from '../../components/Select.tsx'
import { desktop } from '../../desktop.ts'
import { useModelCatalog, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

type State = { settings: CompactionSettings; applied: CompactionSettings }

type Summarizer = CompactionSettings['summarizer']
const sameSummarizer = (a: Summarizer, b: Summarizer) => (a === null || b === null) ? a === b : a.provider === b.provider && a.model === b.model
const same = (a: CompactionSettings, b: CompactionSettings) => a.auto === b.auto && a.threshold === b.threshold && sameSummarizer(a.summarizer, b.summarizer)
/** A Select value for a model ('' is the conversation's own). */
const SEP = '\u0000'
const keyOf = (s: Summarizer) => s === null ? '' : `${s.provider}${SEP}${s.model}`

export function CompactionPage({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const [state, setState] = useState<State | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  /** The slider while it moves; saved once it rests. */
  const [threshold, setThreshold] = useState<number | null>(null)
  const restartService = desktop()?.restartService
  const { catalog } = useModelCatalog(client)
  /** A model's name as the model list gives it, with its service. */
  const modelName = (s: Summarizer) => {
    if (s === null) return '对话自己的模型'
    const group = catalog?.groups.find(g => g.id === s.provider)
    const model = group?.models.find(m => m.id === s.model)
    return model === undefined ? `${s.provider} / ${s.model}` : `${group!.name} · ${model.name}`
  }

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
    if (!settings.auto && state?.settings.auto === true && !await confirm({
      title: '关掉自动压缩？', message: '关掉后，对话超过模型的上下文长度时会直接出错，要手动压缩或开新对话才能继续。', confirmLabel: '关掉', danger: true,
    })) return
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
    if (restartService === undefined || !await confirm({
      title: '现在重启 agent 服务？', message: '正在进行的对话和正在跑的脚本、流水线会被中断，大约需要半分钟。', confirmLabel: '重启', danger: true, icon: 'refresh',
    })) return
    await restartService()
  }

  const picked = state?.settings.summarizer ?? null
  const missing = picked !== null && catalog !== null && !catalog.groups.some(g => g.id === picked.provider && g.models.some(m => m.id === picked.model))

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
            <span className="muted small">调低：压缩得早，回复快、花费少，但记得的细节少；调高：记得的多，但更可能临时压缩一大段。100% 是到上下文快满时才压缩（会留出回复的空间）。</span>
            {(threshold ?? state.settings.threshold) < LOW_COMPACTION_THRESHOLD && state.settings.auto && (
              <span className="notice warn-box left small compaction-warn"><Icon name="alert" /><span>这么低时，光是系统提示和工具说明就可能接近这个用量，几乎每一步都会压缩一次，每次都要调用模型写摘要。想让上下文保持很短，用下面的「低上下文模式」更合适。</span></span>
            )}
          </label>
          <label className="field compaction-summarizer">
            <span className="field-title">写摘要的模型</span>
            <Select aria-label="写摘要的模型" value={keyOf(state.settings.summarizer)} disabled={busy || catalog === null}
              onChange={value => {
                const [provider = '', model = ''] = value.split(SEP)
                void save({ ...state.settings, summarizer: value === '' ? null : { provider, model } })
              }}
              options={[
                { value: '', label: '和对话用同一个模型（默认）', hint: '能用上对话的提示缓存' },
                ...(catalog?.groups ?? []).flatMap(g => g.models.map(m => ({ value: `${g.id}${SEP}${m.id}`, label: m.name, hint: g.name }))),
                ...(missing ? [{ value: keyOf(state.settings.summarizer), label: `${state.settings.summarizer!.provider} / ${state.settings.summarizer!.model}`, hint: '已不在模型列表里' }] : []),
              ]} />
            <span className="muted small">自动压缩、手动压缩和低上下文模式都由它读一遍要压缩的那段对话，写出摘要。默认用对话自己的模型，这段对话大多能命中它的提示缓存；换成别的模型时整段按没命中缓存计费，而且它的上下文要装得下这一段，装不下时压缩会失败。</span>
            {missing && (
              <span className="notice warn-box left small compaction-warn"><Icon name="alert" /><span>「{state.settings.summarizer!.provider} / {state.settings.summarizer!.model}」已经不在模型列表里了（服务被删掉或没有 Key），压缩会失败：换一个，或改回和对话用同一个模型。</span></span>
            )}
          </label>
          {!same(state.settings, state.applied) && (
            <div className="notice left">
              <Icon name="info" />
              <span>改动要重启 agent 服务才生效（现在还是：{state.applied.auto ? `自动压缩，${state.applied.threshold}%` : '不自动压缩'}；摘要由{modelName(state.applied.summarizer)}写）。{restartService === undefined ? '重启 MultiGameAssistant（或 dsh）后生效。' : ''}</span>
              {restartService !== undefined && <button className="small-button" onClick={() => void restart()}>重启 agent 服务</button>}
            </div>
          )}
          {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
        </section>
      )}
      {state !== null && (
        <section className="card">
          <label className="check-label">
            <input type="checkbox" checked={state.settings.lowContext} disabled={busy} onChange={e => void save({ ...state.settings, lowContext: e.target.checked })} />
            低上下文模式
          </label>
          <p className="muted small">只保留最近 12 小时的对话，更早的在任务做完后压缩成摘要；对话安静超过 4 小时后再来新消息，会先把之前的内容压成摘要再开始，agent 从摘要起步、需要时再查原文。任务做完时，过长的工具输出（日志、运行记录）也会截成头尾。</p>
          <label className="check-label compaction-archive">
            <input type="checkbox" checked={state.settings.archiveDays !== null} disabled={busy || !state.settings.lowContext}
              onChange={e => void save({ ...state.settings, archiveDays: e.target.checked ? 7 : null })} />
            摘要也归档
          </label>
          {state.settings.archiveDays !== null && (
            <label className="field compaction-archive-days">
              <span className="field-title">对话过了多久，它的摘要就移出上下文</span>
              <Select aria-label="多久以后归档" value={String(state.settings.archiveDays)} disabled={busy || !state.settings.lowContext}
                onChange={value => void save({ ...state.settings, archiveDays: Number(value) })}
                options={[...new Set<number>([...ARCHIVE_DAYS_CHOICES, state.settings.archiveDays])].sort((a, b) => a - b).map(days => ({ value: String(days), label: `${days} 天` }))} />
            </label>
          )}
          <p className="muted small">{state.settings.lowContext
            ? '打开后，每一段较早的对话单独写一份摘要（攒到大约一天写一次，不会把摘要再压成摘要）；对话过了上面的天数，它的摘要也移出上下文，只留一行说明。做过的事在「记忆」的日记里，agent 需要细节时会去查归档的摘要和原话。上下文最短，但 agent 要靠查才想得起来以前的事。'
            : '要先打开低上下文模式。'}</p>
        </section>
      )}
      {state !== null && (
        <section className="card">
          <label className="check-label">
            <input type="checkbox" checked={state.settings.ptcSubagents} disabled={busy} onChange={e => void save({ ...state.settings, ptcSubagents: e.target.checked })} />
            子 agent 用代码调用工具
          </label>
          <p className="muted small">子 agent 写一小段程序来调用工具：等脚本跑完、翻日志、查运行记录都在程序里做，只把结果交回对话，不用每一步都把整段日志重新发给模型，用量少很多。关掉后子 agent 一次调用一个工具。各个 agent 自己的对话不受影响。不是「完全访问」时程序在沙箱里运行，如果子 agent 说代码执行环境起不来（Windows 文件权限挡住了），先关掉这个开关。</p>
          {state.settings.ptcSubagents !== state.applied.ptcSubagents && (
            <div className="notice left">
              <Icon name="info" />
              <span>改动要重启 agent 服务才生效（现在还是：{state.applied.ptcSubagents ? '用代码调用工具' : '一次调用一个工具'}）。{restartService === undefined ? '重启 MultiGameAssistant（或 dsh）后生效。' : ''}</span>
              {restartService !== undefined && <button className="small-button" onClick={() => void restart()}>重启 agent 服务</button>}
            </div>
          )}
        </section>
      )}
      <section className="card">
        <h3>手动压缩</h3>
        <p className="muted small">在对话框里输入 <kbd>/压缩</kbd>，会先说明代价再确认。对话框旁边的小圆圈显示上下文用了多少，点开能看到各部分占多少。对话变慢、或报上下文超长时用；agent 正在工作时不能压缩。</p>
      </section>
      {state === null && error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}
