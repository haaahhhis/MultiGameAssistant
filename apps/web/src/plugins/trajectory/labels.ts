import type { RecordKind, RecordStatus, TrajectoryGroup, TrajectoryRecord } from '@adg/trajectory'

export const KIND_LABEL: Record<RecordKind, string> = {
  user: '用户',
  context: '上下文',
  system: '系统',
  assistant: '助手',
  attempt: '失败尝试',
  tool: '工具',
  compaction: '压缩',
}

export const STATUS_LABEL: Record<RecordStatus, string> = {
  ok: '已完成',
  error: '失败',
  running: '运行中',
  interrupted: '已中断',
}

const REASON_LABEL: Record<string, string> = {
  completed: '已完成',
  aborted: '已停止',
  error: '失败',
  blocked: '已阻止',
  'max-tokens': '达到输出上限',
  interrupted: '已中断',
  forked: '已分叉',
}

export function groupTitle(group: TrajectoryGroup): string {
  return group.turn === null ? '轮次之间' : `第 ${group.turn} 轮`
}

export function reasonLabel(group: TrajectoryGroup): string {
  if (group.end === null) return '进行中'
  return group.reason === undefined ? '' : REASON_LABEL[group.reason.kind] ?? group.reason.kind
}

/** Prompt-side tokens actually billed for one request (uncached + cache read + cache write). */
export function promptTokens(record: TrajectoryRecord): number | undefined {
  if (record.kind !== 'assistant' || record.request.usage === undefined) return undefined
  const u = record.request.usage
  return u.inputTokens + (u.cacheReadTokens ?? 0) + (u.cacheWriteTokens ?? 0)
}

export function durationOf(record: TrajectoryRecord): number | undefined {
  return record.end === null || record.end < record.start ? undefined : record.end - record.start
}

export function toolCallCount(record: TrajectoryRecord): number {
  return record.kind === 'assistant' ? record.content.filter(p => p.type === 'tool-call').length : 0
}
