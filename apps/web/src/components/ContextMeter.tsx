/**
 * How full the model's context is, beside the message box, as dsh's own web
 * UI shows it (its composer ContextMeter): a ring and the percentage; a click
 * opens what the context is made of (system prompt, tool definitions,
 * conversation; an estimate) and how to compact. Nothing until a request has
 * reported its usage.
 */
import { useEffect, useRef, useState } from 'react'
import type { SessionContext } from '@adg/protocol'

const RADIUS = 5.5
const CIRCUMFERENCE = 2 * Math.PI * RADIUS
const ROWS = [
  { key: 'systemTokens', label: '系统提示词', tone: 'system' },
  { key: 'toolsTokens', label: '工具定义', tone: 'tools' },
  { key: 'messageTokens', label: '对话消息', tone: 'messages' },
] as const

/** `950`, `12.3k`, `128k`, `1M`. */
export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${trim(n / 1_000_000)}M`
  if (n >= 1000) return `${trim(n / 1000)}k`
  return String(Math.round(n))
}
const trim = (n: number) => (n >= 100 ? Math.round(n).toString() : n.toFixed(1).replace(/\.0$/, ''))

export function ContextMeter({ context }: { context: SessionContext | null }) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  useEffect(() => {
    if (!open) return
    const away = (e: PointerEvent) => { if (!root.current?.contains(e.target as Node)) setOpen(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false) }
    document.addEventListener('pointerdown', away)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', away); document.removeEventListener('keydown', escape) }
  }, [open])
  if (context === null) return null

  const percent = Math.min(100, Math.round((context.usedTokens / context.contextWindow) * 100))
  const level = percent >= 90 ? 'high' : percent >= 70 ? 'raised' : 'normal'
  const parts = context.breakdown
  const total = parts === undefined ? 0 : parts.systemTokens + parts.toolsTokens + parts.messageTokens
  const segments = parts === undefined || total === 0
    ? [{ key: 'total', tone: 'messages', width: percent }]
    : ROWS.map(row => ({ key: row.key, tone: row.tone, width: (percent * parts[row.key]) / total })).filter(s => s.width > 0)
  const label = `上下文已用 ${percent}%`

  return (
    <span ref={root} className={`context-meter ${level}`}>
      <button type="button" className="context-trigger" title={label} aria-label={label} aria-haspopup="dialog" aria-expanded={open} onClick={() => setOpen(!open)}>
        <svg viewBox="0 0 14 14" width="14" height="14" aria-hidden="true">
          <circle className="context-track" cx="7" cy="7" r={RADIUS} />
          <circle className="context-fill" cx="7" cy="7" r={RADIUS} strokeDasharray={`${(CIRCUMFERENCE * percent) / 100} ${CIRCUMFERENCE}`} transform="rotate(-90 7 7)" />
        </svg>
        <span>{percent}%</span>
      </button>
      {open && (
        <div className="context-panel" role="dialog" aria-label="上下文用量">
          <div className="context-head">
            <span>上下文已用 <strong>{percent}%</strong></span>
            <span className="context-figures">~{formatTokens(context.usedTokens)} / {formatTokens(context.contextWindow)}</span>
          </div>
          <div className="context-bar">
            {segments.map(s => <span key={s.key} className={`context-segment ${s.tone}`} style={{ width: `${s.width}%` }} />)}
          </div>
          {parts !== undefined && (
            <dl className="context-rows">
              {ROWS.map(row => (
                <div key={row.key}><dt><span className={`context-swatch ${row.tone}`} aria-hidden="true" />{row.label}</dt><dd>~{formatTokens(parts[row.key])}</dd></div>
              ))}
            </dl>
          )}
          <p className="context-tip">快满时会自动压缩（「设置 → 对话压缩」）。也可以输入 <kbd>/压缩</kbd> 手动压缩：较早的部分换成摘要，agent 会忘掉其中的细节。</p>
        </div>
      )}
    </span>
  )
}
