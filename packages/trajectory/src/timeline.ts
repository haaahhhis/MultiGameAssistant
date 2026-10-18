/** Time-axis helpers for the overview: bars, brushing, zoom and search. */
import type { RecordKind, TrajectoryModel, TrajectoryRecord } from './model.ts'

/** A closed epoch-ms interval. */
export interface TimeRange {
  readonly start: number
  readonly end: number
}

export interface TimelineBar {
  readonly record: TrajectoryRecord
  /** Lane index: one lane per record kind family, so bars of a kind never overlap others. */
  readonly lane: number
  readonly start: number
  /** Bar end; equals start for instants and running records (start marker only). */
  readonly end: number
  /** Assistant bars split at the first token: [start, firstToken) waiting, [firstToken, end] decoding. */
  readonly firstTokenAt?: number
  readonly instant: boolean
}

export const LANES: readonly { readonly id: string; readonly kinds: readonly RecordKind[]; readonly label: string }[] = [
  { id: 'input', kinds: ['user', 'context', 'system'], label: 'Input' },
  { id: 'model', kinds: ['assistant', 'attempt'], label: 'Model' },
  { id: 'tool', kinds: ['tool'], label: 'Tools' },
  { id: 'compaction', kinds: ['compaction'], label: 'Compaction' },
]

const laneOf = new Map<RecordKind, number>(LANES.flatMap((lane, i) => lane.kinds.map(kind => [kind, i] as const)))

/**
 * Project records onto lanes. Running records keep only their start marker:
 * no live span is invented.
 */
export function timelineBars(model: TrajectoryModel): TimelineBar[] {
  return model.records.map(record => {
    const instant = record.end === null || record.end <= record.start
    const bar: TimelineBar = {
      record,
      lane: laneOf.get(record.kind) ?? 0,
      start: record.start,
      end: record.end === null ? record.start : Math.max(record.start, record.end),
      instant,
    }
    if (record.kind === 'assistant' && record.request.ttftMs !== undefined && record.end !== null) {
      return { ...bar, firstTokenAt: record.start + record.request.ttftMs }
    }
    return bar
  })
}

/** Whether a record was active at any instant of the closed range. */
export function activeIn(record: TrajectoryRecord, range: TimeRange): boolean {
  const end = record.end ?? record.start
  return record.start <= range.end && end >= range.start
}

/** Records active at any instant of `range`, in log order. */
export function recordsActiveIn(model: TrajectoryModel, range: TimeRange | null): readonly TrajectoryRecord[] {
  return range === null ? model.records : model.records.filter(r => activeIn(r, range))
}

/**
 * Zoom `view` around `anchor` by `factor` (<1 zooms in), clamped to `bounds`.
 * @returns the new visible range.
 */
export function zoomRange(view: TimeRange, anchor: number, factor: number, bounds: TimeRange): TimeRange {
  const minSpan = 10
  const span = Math.max(minSpan, (view.end - view.start) * factor)
  const ratio = view.end === view.start ? 0.5 : (anchor - view.start) / (view.end - view.start)
  let start = anchor - span * ratio
  let end = start + span
  if (end - start >= bounds.end - bounds.start) return bounds
  if (start < bounds.start) { end += bounds.start - start; start = bounds.start }
  if (end > bounds.end) { start -= end - bounds.end; end = bounds.end }
  return { start, end }
}

/** Shift `view` by `delta` ms without leaving `bounds`. */
export function panRange(view: TimeRange, delta: number, bounds: TimeRange): TimeRange {
  const span = view.end - view.start
  const start = Math.min(Math.max(bounds.start, view.start + delta), bounds.end - span)
  return { start, end: start + span }
}

/** Case-insensitive substring search over titles, previews and tool arguments. */
export function searchRecords(records: readonly TrajectoryRecord[], query: string): readonly TrajectoryRecord[] {
  const needle = query.trim().toLowerCase()
  if (needle === '') return records
  return records.filter(record => {
    if (record.title.toLowerCase().includes(needle) || record.preview.toLowerCase().includes(needle)) return true
    if (record.kind === 'tool') return record.arguments.toLowerCase().includes(needle)
    return false
  })
}
