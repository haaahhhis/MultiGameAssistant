/**
 * Trajectory tab: toolbar, pinned time overview, turn-grouped event ledger and
 * record inspector — the layout of dsh's own Trajectory view, driven by the
 * framework-free projection in @adg/trajectory.
 */
import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent } from 'react'
import { useVirtualizer } from '@tanstack/react-virtual'
import {
  activeIn, buildTrajectory, formatDuration, formatTokens, searchRecords,
  type TrajectoryGroup, type TrajectoryModel, type TrajectoryRecord,
} from '@adg/trajectory'
import type { SessionViewProps } from '../../plugins.ts'
import { Inspector } from './Inspector.tsx'
import { KIND_LABEL, STATUS_LABEL, durationOf, groupTitle, promptTokens, reasonLabel, toolCallCount } from './labels.ts'
import { Overview, type Brush, type OverviewMode } from './Overview.tsx'

type Row =
  | { readonly type: 'group'; readonly key: string; readonly group: TrajectoryGroup; readonly collapsed: boolean; readonly matches: number }
  | { readonly type: 'record'; readonly key: string; readonly record: TrajectoryRecord; readonly stepStart: number | null }

const ROW_HEIGHT = 32
const GROUP_HEIGHT = 34
const STICK_THRESHOLD = 60

export function TrajectoryView({ session, state }: SessionViewProps) {
  const model = useMemo(
    () => buildTrajectory(state.events, state.live, { now: Date.now() }),
    // `version` covers in-place live delta appends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.events, state.live, state.version],
  )
  const [mode, setMode] = useState<OverviewMode>('equal')
  const [brush, setBrush] = useState<Brush | null>(null)
  const [query, setQuery] = useState('')
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [showCalls, setShowCalls] = useState(true)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const selected = model.records.find(r => r.id === selectedId) ?? null

  const rows = useMemo(() => flatten(model, { brush, query, collapsed, showCalls }), [model, brush, query, collapsed, showCalls])
  const visibleRecords = useMemo(() => rows.flatMap(r => (r.type === 'record' ? [r.record] : [])), [rows])

  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroller.current,
    estimateSize: index => (rows[index]?.type === 'group' ? GROUP_HEIGHT : ROW_HEIGHT),
    getItemKey: index => rows[index]?.key ?? index,
    overscan: 12,
  })

  // Follow the tail while the user stays at the bottom; scrolling up pauses it.
  useLayoutEffect(() => {
    if (stick.current && rows.length > 0) virtualizer.scrollToIndex(rows.length - 1, { align: 'end' })
  }, [rows.length, state.version, virtualizer])

  const onScroll = () => {
    const el = scroller.current
    if (el === null) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
  }

  // Bring a record selected from the overview into view.
  useEffect(() => {
    if (selectedId === null) return
    const index = rows.findIndex(r => r.type === 'record' && r.record.id === selectedId)
    if (index !== -1) virtualizer.scrollToIndex(index, { align: 'auto' })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedId])

  const toggleGroup = (key: string) => setCollapsed(set => {
    const next = new Set(set)
    if (next.has(key)) next.delete(key)
    else next.add(key)
    return next
  })
  const allCollapsed = model.groups.length > 0 && model.groups.every(g => collapsed.has(g.key))

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key !== 'ArrowDown' && e.key !== 'ArrowUp' && e.key !== 'Escape') return
    e.preventDefault()
    if (e.key === 'Escape') { setSelectedId(null); return }
    const at = visibleRecords.findIndex(r => r.id === selectedId)
    const next = visibleRecords[e.key === 'ArrowDown' ? Math.min(visibleRecords.length - 1, at + 1) : Math.max(0, at - 1)]
    if (next !== undefined) setSelectedId(next.id)
  }

  const t = model.totals
  return (
    <div className="trajectory">
      <div className="traj-toolbar" role="toolbar" aria-label="轨迹工具栏">
        <button className={`toggle ${mode === 'actual' ? 'on' : ''}`} onClick={() => { setMode(m => (m === 'equal' ? 'actual' : 'equal')); setBrush(null) }}
          title={mode === 'equal' ? '使用实际时长' : '使用等宽操作'}>
          ⏱ {mode === 'equal' ? '等宽' : '实际时间'}
        </button>
        <button className="toggle" onClick={() => setCollapsed(allCollapsed ? new Set() : new Set(model.groups.map(g => g.key)))}>
          ⊟ {allCollapsed ? '展开所有轮次' : '收起所有轮次'}
        </button>
        <button className={`toggle ${showCalls ? '' : 'on'}`} onClick={() => setShowCalls(s => !s)}>
          ⊟ {showCalls ? '收起所有调用' : '展开所有调用'}
        </button>
        <input className="traj-search" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索轨迹" aria-label="搜索轨迹" />
        <span className="traj-totals muted small" title="已加载窗口内的累计">
          {t.requests} 次请求 · 输入 {formatTokens(t.inputTokens + t.cacheReadTokens + t.cacheWriteTokens)} · 输出 {formatTokens(t.outputTokens)} · {t.toolCalls} 次工具调用{t.errors > 0 ? ` · ${t.errors} 个错误` : ''}
        </span>
      </div>

      <Overview model={model} mode={mode} brush={brush} selectedId={selectedId} onBrush={setBrush} onSelect={r => setSelectedId(r.id)} />
      {brush !== null && (
        <div className="brush-note small">
          已按时间区间筛选，显示 {visibleRecords.length} 条记录 <button className="link-button" onClick={() => setBrush(null)}>清除</button>
        </div>
      )}

      <div className="traj-main">
        <div className="ledger" ref={scroller} onScroll={onScroll} tabIndex={0} onKeyDown={onKeyDown} role="grid" aria-label="轨迹事件表">
          <div className="ledger-head" role="row">
            <span /><span>类型</span><span>内容</span>
            <span className="num">输入</span><span className="num">输出</span><span className="num">思考</span>
            <span className="num">时间</span><span>模型</span><span className="num">工具</span>
          </div>
          {state.hasMore && (
            <button className="link-button load-older" disabled={state.loadingOlder} onClick={() => void session.loadOlder()}>
              {state.loadingOlder ? '正在加载更早的历史…' : '加载更早的历史'}
            </button>
          )}
          {rows.length === 0 && <div className="empty">{state.status === 'opening' ? '正在加载轨迹…' : query !== '' ? '没有匹配的记录' : '还没有记录'}</div>}
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(item => {
              const row = rows[item.index]!
              return (
                <div key={item.key} className="vrow" style={{ transform: `translateY(${item.start}px)`, height: item.size }}>
                  {row.type === 'group'
                    ? <GroupRow row={row} onToggle={() => toggleGroup(row.group.key)} />
                    : <RecordRow row={row} selected={row.record.id === selectedId} onSelect={() => setSelectedId(id => (id === row.record.id ? null : row.record.id))} />}
                </div>
              )
            })}
          </div>
        </div>
        {selected !== null && <Inspector key={selected.id} record={selected} totals={model.totals} onClose={() => setSelectedId(null)} />}
      </div>
    </div>
  )
}

function flatten(model: TrajectoryModel, opts: { brush: Brush | null; query: string; collapsed: ReadonlySet<string>; showCalls: boolean }): Row[] {
  const allowed = new Set<string>()
  let pool: readonly TrajectoryRecord[] = model.records
  if (opts.brush !== null) {
    const brush = opts.brush
    pool = brush.mode === 'equal' ? pool.slice(brush.from, brush.to + 1) : pool.filter(r => activeIn(r, brush.range))
  }
  for (const r of searchRecords(pool, opts.query)) allowed.add(r.id)
  const filtering = opts.brush !== null || opts.query.trim() !== ''

  const rows: Row[] = []
  for (const group of model.groups) {
    const records = group.records.filter(r => allowed.has(r.id) && (opts.showCalls || r.kind !== 'tool'))
    if (filtering && records.length === 0) continue
    const collapsed = opts.collapsed.has(group.key)
    rows.push({ type: 'group', key: `g:${group.key}`, group, collapsed, matches: records.length })
    if (collapsed) continue
    let lastStep: number | null = null
    for (const record of records) {
      const stepStart = record.step !== null && record.step !== lastStep ? record.step : null
      if (record.step !== null) lastStep = record.step
      rows.push({ type: 'record', key: record.id, record, stepStart })
    }
  }
  return rows
}

const GroupRow = memo(function GroupRow({ row, onToggle }: { row: Extract<Row, { type: 'group' }>; onToggle: () => void }) {
  const g = row.group
  const tools = g.records.filter(r => r.kind === 'tool').length
  const duration = g.end === null ? null : g.end - g.start
  const reason = reasonLabel(g)
  return (
    <button className={`group-row ${g.end === null ? 'open' : ''} reason-${g.reason?.kind ?? 'none'}`} onClick={onToggle} aria-expanded={!row.collapsed}>
      <span className="chevron">{row.collapsed ? '▸' : '▾'}</span>
      <span className="group-title">{groupTitle(g)}</span>
      <span className="muted small">
        {g.steps.length > 0 && `${g.steps.length} 个步骤`}
        {tools > 0 && ` · ${tools} 个工具调用`}
        {duration !== null && ` · ${formatDuration(duration)}`}
        {g.partialStart && ' · 开头在已加载范围之外'}
      </span>
      {reason !== '' && <span className={`group-reason reason-${g.end === null ? 'running' : g.reason?.kind ?? 'none'}`}>{reason}</span>}
    </button>
  )
})

const RecordRow = memo(function RecordRow({ row, selected, onSelect }: { row: Extract<Row, { type: 'record' }>; selected: boolean; onSelect: () => void }) {
  const r = row.record
  const isAssistant = r.kind === 'assistant'
  const duration = durationOf(r)
  return (
    <div
      className={`record-row kind-${r.kind} status-${r.status} ${selected ? 'selected' : ''} ${row.stepStart !== null ? 'step-start' : ''}`}
      onClick={onSelect}
      role="row"
      aria-selected={selected}
    >
      <span className="gutter muted">{row.stepStart !== null ? `第 ${row.stepStart} 步` : ''}</span>
      <span><span className={`kind-badge kind-${r.kind}`}>{isAssistant ? `#${r.request.index}` : KIND_LABEL[r.kind]}</span></span>
      <span className="record-content" title={r.preview}>
        {r.status === 'running' && <span className="running-dot" />}
        {r.status === 'error' && <span className="status-text status-error">{STATUS_LABEL.error} · </span>}
        {r.kind === 'tool' ? <><code className="tool-name-inline">{r.name}</code> <span className="muted">{r.preview}</span></> : r.preview || <span className="muted">（无内容）</span>}
      </span>
      <span className="num">{isAssistant ? formatTokens(promptTokens(r)) : ''}</span>
      <span className="num">{isAssistant && r.request.usage !== undefined ? formatTokens(r.request.usage.outputTokens) : ''}</span>
      <span className="num">{isAssistant && r.request.usage?.reasoningTokens !== undefined ? formatTokens(r.request.usage.reasoningTokens) : ''}</span>
      <span className="num">{r.status === 'running' ? '…' : duration !== undefined && (isAssistant || r.kind === 'tool' || r.kind === 'compaction' || r.kind === 'attempt') ? formatDuration(duration) : ''}</span>
      <span className="model-cell">{isAssistant ? r.request.model ?? '' : ''}</span>
      <span className="num">{isAssistant && toolCallCount(r) > 0 ? toolCallCount(r) : ''}</span>
    </div>
  )
})
