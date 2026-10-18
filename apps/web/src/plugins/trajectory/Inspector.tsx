/** Record inspector: per-kind tabs mirroring the official view (概述 / 原始输出 / 用量 / 计时 …). */
import { useState, type ReactNode } from 'react'
import type { ContentPart } from '@adg/protocol'
import {
  formatClock, formatDuration, formatTokens, prettyJson,
  type AssistantRecord, type TrajectoryRecord, type TrajectoryTotals,
} from '@adg/trajectory'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { KIND_LABEL, STATUS_LABEL, durationOf, promptTokens, toolCallCount } from './labels.ts'

interface Tab {
  readonly id: string
  readonly label: string
  readonly render: () => ReactNode
}

export function Inspector({ record, totals, onClose }: { record: TrajectoryRecord; totals: TrajectoryTotals; onClose: () => void }) {
  const tabs = tabsFor(record, totals)
  const [tabId, setTabId] = useState(tabs[0]!.id)
  const active = tabs.find(t => t.id === tabId) ?? tabs[0]!
  return (
    <aside className="inspector" aria-label="事件详情">
      <header className="inspector-head">
        <span className={`kind-badge kind-${record.kind}`}>{KIND_LABEL[record.kind]}</span>
        <span className="inspector-title" title={record.title}>{inspectorTitle(record)}</span>
        <button className="ghost icon" onClick={onClose} aria-label="关闭详情"><Icon name="close" /></button>
      </header>
      <nav className="inspector-tabs" role="tablist">
        {tabs.map(tab => (
          <button key={tab.id} role="tab" aria-selected={tab.id === active.id} className={tab.id === active.id ? 'active' : ''} onClick={() => setTabId(tab.id)}>
            {tab.label}
          </button>
        ))}
      </nav>
      <div className="inspector-body">{active.render()}</div>
    </aside>
  )
}

/** Localized heading; the projection's own titles are locale-neutral English. */
function inspectorTitle(record: TrajectoryRecord): string {
  switch (record.kind) {
    case 'assistant': return `请求 #${record.request.index}${record.request.model === undefined ? '' : ` · ${record.request.model}`}`
    case 'tool': return record.name
    case 'context': return record.title === 'Compacted history' ? '已压缩的历史' : `上下文 · ${record.origin.kind}`
    case 'system': return '系统提示词'
    case 'attempt': return '失败的模型尝试'
    default: return KIND_LABEL[record.kind]
  }
}

function tabsFor(record: TrajectoryRecord, totals: TrajectoryTotals): Tab[] {
  switch (record.kind) {
    case 'assistant':
      return [
        { id: 'summary', label: '概述', render: () => <AssistantSummary record={record} /> },
        { id: 'raw', label: '原始输出', render: () => <RawContent content={record.content} /> },
        { id: 'usage', label: '用量', render: () => <Usage record={record} totals={totals} /> },
        { id: 'timing', label: '计时', render: () => <Timing record={record} /> },
      ]
    case 'tool':
      return [
        {
          id: 'summary', label: '概述', render: () => (
            <Facts rows={[
              ['状态', <Status record={record} />],
              ['工具', <code>{record.name}</code>],
              ['调用 ID', <code>{record.callId}</code>],
              ['开始时间', formatClock(record.start)],
              ['时长', record.end === null ? '运行中' : formatDuration(durationOf(record))],
              ['审批', record.approval === undefined ? '无需审批' : record.approval.outcome ?? '等待中'],
              ['错误', record.error === undefined ? undefined : `${record.error.message}${record.error.code === undefined ? '' : ` (${record.error.code})`}`],
            ]} />
          ),
        },
        { id: 'payload', label: '参数', render: () => <pre className="payload">{record.arguments === '' ? '未捕获参数' : prettyJson(record.arguments)}</pre> },
        { id: 'result', label: '结果', render: () => record.result === undefined ? <p className="muted">未捕获结果</p> : <RawContent content={record.result} /> },
      ]
    case 'user':
    case 'context':
      return [
        {
          id: 'summary', label: '概述', render: () => (
            <>
              <Facts rows={[
                ['来源', record.origin.human ? '用户' : record.origin.kind],
                ['时间', formatClock(record.start)],
                ['附件', record.imageCount + record.fileCount === 0 ? undefined : `图片 ×${record.imageCount} · 文件 ×${record.fileCount}`],
              ]} />
              <div className="label">预览</div>
              <RawContent content={record.content} />
            </>
          ),
        },
        { id: 'raw', label: '原始内容', render: () => <pre className="payload">{JSON.stringify(record.content, null, 2)}</pre> },
      ]
    case 'system':
      return [{ id: 'prompt', label: '系统提示词', render: () => <pre className="payload">{record.text}</pre> }]
    case 'attempt':
      return [{
        id: 'summary', label: '概述', render: () => (
          <Facts rows={[
            ['状态', <Status record={record} />],
            ['开始时间', formatClock(record.start)],
            ['时长', formatDuration(durationOf(record))],
            ['错误', record.error === undefined ? '尝试在没有输出的情况下结束' : `${record.error.message}${record.error.code === undefined ? '' : ` (${record.error.code})`}`],
          ]} />
        ),
      }]
    case 'compaction':
      return [{
        id: 'summary', label: '概述', render: () => (
          <Facts rows={[
            ['状态', <Status record={record} />],
            ['开始时间', formatClock(record.start)],
            ['时长', record.end === null ? '运行中' : formatDuration(durationOf(record))],
            ['已压缩', record.shadowedTokenCount === undefined ? undefined : `${formatTokens(record.shadowedTokenCount)} tok`],
            ['输入 / 输出', record.usage === undefined ? undefined : `${formatTokens(record.usage.inputTokens)} / ${formatTokens(record.usage.outputTokens)} tok`],
            ['错误', record.error],
          ]} />
        ),
      }]
  }
}

function Status({ record }: { record: TrajectoryRecord }) {
  return <span className={`status-text status-${record.status}`}>{STATUS_LABEL[record.status]}</span>
}

function Facts({ rows }: { rows: [string, ReactNode | undefined][] }) {
  return (
    <dl className="facts">
      {rows.filter(([, value]) => value !== undefined && value !== '').map(([label, value]) => (
        <div key={label} className="fact"><dt>{label}</dt><dd>{value}</dd></div>
      ))}
    </dl>
  )
}

function AssistantSummary({ record }: { record: AssistantRecord }) {
  const r = record.request
  const text = record.content.filter(p => p.type === 'text').map(p => (p.type === 'text' ? p.text : '')).join('')
  const calls = record.content.filter((p): p is Extract<ContentPart, { type: 'tool-call' }> => p.type === 'tool-call')
  return (
    <>
      <Facts rows={[
        ['状态', <Status record={record} />],
        ['请求', `#${r.index}`],
        ['提供方', r.provider],
        ['模型', r.model],
        ['推理强度', r.reasoningEffort],
        ['可用工具', r.toolCount === undefined ? undefined : String(r.toolCount)],
        ['工具调用', calls.length === 0 ? undefined : String(calls.length)],
        ['重试', r.retries === 0 ? undefined : String(r.retries)],
        ['上次尝试错误', r.lastRetryError === undefined ? undefined : `${r.lastRetryError.message}${r.lastRetryError.code === undefined ? '' : ` (${r.lastRetryError.code})`}`],
      ]} />
      {text.trim() !== '' && <><div className="label">助手消息</div><Markdown text={text} className="inspector-markdown" /></>}
      {text.trim() === '' && calls.length > 0 && <p className="muted small">（仅工具调用）</p>}
      {calls.length > 0 && (
        <>
          <div className="label">工具调用</div>
          <ul className="call-list">
            {calls.map(call => <li key={call.callId}><code>{call.name}</code> <span className="muted">{call.arguments.slice(0, 120)}</span></li>)}
          </ul>
        </>
      )}
    </>
  )
}

function RawContent({ content }: { content: readonly ContentPart[] }) {
  if (content.length === 0) return <p className="muted">无内容</p>
  return (
    <div className="raw-blocks">
      {content.map((part, index) => {
        switch (part.type) {
          case 'reasoning':
            return (
              <details key={index} className="raw-block reasoning-block">
                <summary>思考</summary>
                <Markdown text={part.text} className="inspector-markdown" />
              </details>
            )
          case 'text':
            return <pre key={index} className="payload">{part.text}</pre>
          case 'tool-call':
            return (
              <div key={index} className="raw-block">
                <div className="label">工具调用 · <code>{part.name}</code></div>
                <pre className="payload">{prettyJson(part.arguments)}</pre>
              </div>
            )
          case 'image':
            return <div key={index} className="raw-block muted small">🖼 {part.name ?? `图片 ${index + 1}`} {part.width !== undefined ? `${part.width}×${part.height}` : ''}</div>
          case 'file':
            return <div key={index} className="raw-block muted small">📎 {part.name ?? '文件'} {part.size === undefined ? '' : `${formatTokens(part.size)}B`}</div>
          default:
            return <div key={index} className="raw-block muted small">[{part.kind}]</div>
        }
      })}
    </div>
  )
}

function Usage({ record, totals }: { record: AssistantRecord; totals: TrajectoryTotals }) {
  const u = record.request.usage
  return (
    <>
      <h4 className="usage-heading">本次请求</h4>
      {u === undefined
        ? <p className="muted">未报告用量</p>
        : (
          <Facts rows={[
            ['输入（未缓存）', `${formatTokens(u.inputTokens)} tok`],
            ['缓存读取', u.cacheReadTokens === undefined ? undefined : `${formatTokens(u.cacheReadTokens)} tok`],
            ['缓存写入', u.cacheWriteTokens === undefined ? undefined : `${formatTokens(u.cacheWriteTokens)} tok`],
            ['输入合计', `${formatTokens(promptTokens(record))} tok`],
            ['输出', `${formatTokens(u.outputTokens)} tok`],
            ['其中推理', u.reasoningTokens === undefined ? undefined : `${formatTokens(u.reasoningTokens)} tok`],
            ['总计', u.totalTokens === undefined ? undefined : `${formatTokens(u.totalTokens)} tok`],
          ]} />
        )}
      <h4 className="usage-heading">已加载窗口累计</h4>
      <Facts rows={[
        ['请求数', String(totals.requests)],
        ['输入（未缓存）', `${formatTokens(totals.inputTokens)} tok`],
        ['缓存读取', `${formatTokens(totals.cacheReadTokens)} tok`],
        ['输出', `${formatTokens(totals.outputTokens)} tok`],
        ['其中推理', `${formatTokens(totals.reasoningTokens)} tok`],
      ]} />
    </>
  )
}

function Timing({ record }: { record: AssistantRecord }) {
  const [unix, setUnix] = useState(false)
  const r = record.request
  return (
    <Facts rows={[
      ['开始时间', <button className="link-button" onClick={() => setUnix(u => !u)} title={unix ? '显示本地时间' : '显示 Unix 时间戳'}>{unix ? String(record.start) : formatClock(record.start)}</button>],
      ['总时长', record.end === null ? '运行中' : formatDuration(durationOf(record))],
      ['首 token 延迟', r.ttftMs === undefined ? '不可用（步骤开始时间或首 token 不在已加载范围内）' : formatDuration(r.ttftMs)],
      ['生成', r.decodeMs === undefined ? (record.live ? '运行中' : '不可用') : formatDuration(r.decodeMs)],
      ['吞吐量', r.tokensPerSecond === undefined ? (r.usage === undefined ? '用量不可用' : '时长过短') : `${r.tokensPerSecond.toFixed(1)} tok/s`],
      ['工具调用', toolCallCount(record) === 0 ? undefined : String(toolCallCount(record))],
      ['计时来源', record.live ? '会话时间戳（运行中）' : '会话时间戳'],
    ]} />
  )
}
