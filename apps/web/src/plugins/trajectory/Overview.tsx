/**
 * Time overview pinned above the ledger.
 *
 * Two modes, like the official view: equal-width operations (each record one
 * slot, readable at any scale) or actual time (bars at their real start and
 * duration; assistant bars split into waiting-for-first-token and decoding).
 * Drag selects a range that filters the ledger; right-click clears it;
 * in actual-time mode the wheel zooms around the cursor and a right-drag pans.
 */
import { memo, useMemo, useRef, useState, type MouseEvent, type WheelEvent } from 'react'
import {
  formatClock, formatDuration, LANES, panRange, timelineBars, zoomRange,
  type TimeRange, type TrajectoryModel, type TrajectoryRecord,
} from '@adg/trajectory'
import { KIND_LABEL } from './labels.ts'

export type OverviewMode = 'equal' | 'actual'

/** A brushed selection: a time range (actual mode) or a record-index range (equal mode). */
export type Brush =
  | { readonly mode: 'actual'; readonly range: TimeRange }
  | { readonly mode: 'equal'; readonly from: number; readonly to: number }

interface Props {
  readonly model: TrajectoryModel
  readonly mode: OverviewMode
  readonly brush: Brush | null
  readonly selectedId: string | null
  readonly onBrush: (brush: Brush | null) => void
  readonly onSelect: (record: TrajectoryRecord) => void
}

const LANE_HEIGHT = 14

export const Overview = memo(function Overview({ model, mode, brush, selectedId, onBrush, onSelect }: Props) {
  const bars = useMemo(() => timelineBars(model), [model])
  const usedLanes = useMemo(() => LANES.map((lane, i) => ({ ...lane, index: i })).filter(lane => lane.id !== 'compaction' || bars.some(b => b.lane === lane.index)), [bars])
  const laneRow = new Map(usedLanes.map((lane, row) => [lane.index, row]))
  const bounds = model.span
  const [view, setView] = useState<TimeRange | null>(null)
  const range = mode === 'actual' && bounds !== null ? clampView(view, bounds) : null
  const track = useRef<HTMLDivElement>(null)
  const [drag, setDrag] = useState<{ x0: number; x1: number } | null>(null)
  const pan = useRef<{ x: number; view: TimeRange } | null>(null)

  const count = model.records.length
  const xOf = (index: number, time: number): number => {
    if (mode === 'equal') return count === 0 ? 0 : index / count
    if (range === null || range.end === range.start) return 0
    return (time - range.start) / (range.end - range.start)
  }

  const fraction = (clientX: number) => {
    const rect = track.current?.getBoundingClientRect()
    if (rect === undefined || rect.width === 0) return 0
    return Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
  }

  const onMouseDown = (e: MouseEvent) => {
    if (e.button === 2 && range !== null && bounds !== null && (range.start > bounds.start || range.end < bounds.end)) {
      pan.current = { x: e.clientX, view: range }
      return
    }
    if (e.button !== 0) return
    const f = fraction(e.clientX)
    setDrag({ x0: f, x1: f })
  }
  const onMouseMove = (e: MouseEvent) => {
    if (pan.current !== null && bounds !== null && track.current !== null) {
      const dx = (e.clientX - pan.current.x) / track.current.clientWidth
      const span = pan.current.view.end - pan.current.view.start
      setView(panRange(pan.current.view, -dx * span, bounds))
      return
    }
    if (drag !== null) setDrag({ ...drag, x1: fraction(e.clientX) })
  }
  const onMouseUp = () => {
    pan.current = null
    if (drag === null) return
    const [a, b] = drag.x0 < drag.x1 ? [drag.x0, drag.x1] : [drag.x1, drag.x0]
    setDrag(null)
    if (b - a < 0.005) return // a click, not a drag
    if (mode === 'equal') {
      onBrush({ mode: 'equal', from: Math.floor(a * count), to: Math.max(Math.floor(a * count), Math.ceil(b * count) - 1) })
    } else if (range !== null) {
      const span = range.end - range.start
      onBrush({ mode: 'actual', range: { start: range.start + a * span, end: range.start + b * span } })
    }
  }
  const onWheel = (e: WheelEvent) => {
    if (mode !== 'actual' || range === null || bounds === null) return
    const span = range.end - range.start
    setView(zoomRange(range, range.start + fraction(e.clientX) * span, e.deltaY > 0 ? 1.25 : 0.8, bounds))
  }

  if (count === 0 || bounds === null) {
    return <div className="overview empty-overview muted small">无计时数据</div>
  }

  const brushBox = brush === null ? null
    : brush.mode === 'equal'
      ? (mode === 'equal' ? { left: brush.from / count, right: (brush.to + 1) / count } : null)
      : (mode === 'actual' ? { left: xOf(0, brush.range.start), right: xOf(0, brush.range.end) } : null)

  return (
    <div className="overview" onContextMenu={e => { e.preventDefault(); if (pan.current === null) onBrush(null) }}>
      <div className="overview-lanes">
        {usedLanes.map(lane => <div key={lane.id} className="lane-label" style={{ height: LANE_HEIGHT }}>{laneLabel(lane.id)}</div>)}
      </div>
      <div
        className="overview-track"
        ref={track}
        style={{ height: usedLanes.length * (LANE_HEIGHT + 2) }}
        onMouseDown={onMouseDown}
        onMouseMove={onMouseMove}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseUp}
        onWheel={onWheel}
      >
        {bars.map((bar, index) => {
          const row = laneRow.get(bar.lane) ?? 0
          const left = xOf(index, bar.start)
          const right = mode === 'equal' ? (index + 1) / count : xOf(index, bar.end)
          if (right < 0 || left > 1) return null
          const record = bar.record
          const width = Math.max(0, Math.min(1, right) - Math.max(0, left))
          const firstToken = mode === 'actual' && bar.firstTokenAt !== undefined && bar.end > bar.start
            ? (bar.firstTokenAt - bar.start) / (bar.end - bar.start) : null
          return (
            <div
              key={record.id}
              className={`bar kind-${record.kind} status-${record.status} ${bar.instant && mode === 'actual' ? 'instant' : ''} ${record.id === selectedId ? 'selected' : ''}`}
              style={{
                left: `${Math.max(0, left) * 100}%`,
                width: mode === 'equal' ? `calc(${width * 100}% - 1px)` : `max(2px, ${width * 100}%)`,
                top: row * (LANE_HEIGHT + 2),
                height: LANE_HEIGHT,
                ...(firstToken === null ? {} : { ['--ttft' as string]: `${Math.min(100, Math.max(0, firstToken * 100))}%` }),
              }}
              title={barTitle(record, bar.firstTokenAt)}
              onMouseUp={e => { if (drag !== null && Math.abs(drag.x1 - drag.x0) < 0.005 && e.button === 0) onSelect(record) }}
            />
          )
        })}
        {brushBox !== null && (
          <div className="brush" style={{ left: `${Math.max(0, brushBox.left) * 100}%`, width: `${(Math.min(1, brushBox.right) - Math.max(0, brushBox.left)) * 100}%` }} />
        )}
        {drag !== null && (
          <div className="brush dragging" style={{ left: `${Math.min(drag.x0, drag.x1) * 100}%`, width: `${Math.abs(drag.x1 - drag.x0) * 100}%` }} />
        )}
      </div>
      <div className="overview-scale muted">
        {mode === 'actual' && range !== null
          ? <>
            <span>{formatClock(range.start)}</span>
            <span>总计 {formatDuration(bounds.end - bounds.start)}{view !== null ? ' · 已缩放' : ''}</span>
            <span>{formatClock(range.end)}</span>
          </>
          : <>
            <span>{count} 条记录（等宽）</span>
            <span>总计 {formatDuration(bounds.end - bounds.start)}</span>
            <span>拖动选择区间 · 右键清除</span>
          </>}
      </div>
    </div>
  )
})

function clampView(view: TimeRange | null, bounds: TimeRange): TimeRange {
  if (view === null) return bounds
  const start = Math.max(bounds.start, view.start)
  const end = Math.min(bounds.end, view.end)
  return end > start ? { start, end } : bounds
}

function laneLabel(id: string): string {
  return id === 'input' ? '输入' : id === 'model' ? '模型' : id === 'tool' ? '工具' : '压缩'
}

function barTitle(record: TrajectoryRecord, firstTokenAt: number | undefined): string {
  const lines = [`${KIND_LABEL[record.kind]} · ${record.title}`, `开始于 ${formatClock(record.start)}`]
  if (record.end === null) lines.push('进行中（只显示开始标记）')
  else lines.push(`总计 ${formatDuration(record.end - record.start)}`)
  if (record.kind === 'assistant' && firstTokenAt !== undefined && record.end !== null) {
    lines.push(`首 token ${formatDuration(firstTokenAt - record.start)} · 解码 ${formatDuration(record.end - firstTokenAt)}`)
  }
  return lines.join('\n')
}
