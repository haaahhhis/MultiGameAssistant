/** Trajectory view model: turns → steps → records, plus whole-window totals. */
import type { ContentPart, Failure, MessageOrigin, TokenUsage, TurnEndReason } from '@adg/protocol'

export type RecordStatus = 'ok' | 'error' | 'running' | 'interrupted'

interface RecordBase {
  /** Stable key across rebuilds and appended events. */
  readonly id: string
  /** Durable seq anchoring the record's position (live records use their afterSeq). */
  readonly seq: number
  /** Owning turn; null for records outside any turn (between-turn compaction). */
  readonly turn: number | null
  readonly step: number | null
  /** Epoch ms when the record's activity began. */
  readonly start: number
  /** Epoch ms when it ended; null while running or for instantaneous records. */
  readonly end: number | null
  readonly status: RecordStatus
  /** One-line label for the ledger. */
  readonly title: string
  /** One-line content preview. */
  readonly preview: string
}

export interface UserRecord extends RecordBase {
  readonly kind: 'user' | 'context'
  readonly content: readonly ContentPart[]
  readonly origin: MessageOrigin
  readonly imageCount: number
  readonly fileCount: number
}

export interface SystemRecord extends RecordBase {
  readonly kind: 'system'
  readonly text: string
}

/** Facts about the model request that produced an assistant record. */
export interface RequestFacts {
  /** 1-based request number within the loaded window. */
  readonly index: number
  readonly provider?: string
  readonly model?: string
  readonly reasoningEffort?: string
  readonly toolCount?: number
  /** Step start → first output token, across retries; undefined when unknown. */
  readonly ttftMs?: number
  /** First → last token chunk of the settled attempt. */
  readonly decodeMs?: number
  /** Output tokens per second over the decode span, when usage is known. */
  readonly tokensPerSecond?: number
  readonly usage?: TokenUsage
  /** Failed attempts that preceded this one in the same step. */
  readonly retries: number
  readonly lastRetryError?: Failure
}

export interface AssistantRecord extends RecordBase {
  readonly kind: 'assistant'
  readonly content: readonly ContentPart[]
  readonly request: RequestFacts
  /** True while the record is projected from live frames. */
  readonly live: boolean
  readonly interrupted: boolean
}

export interface AttemptRecord extends RecordBase {
  readonly kind: 'attempt'
  readonly error?: Failure
}

export interface ToolRecord extends RecordBase {
  readonly kind: 'tool'
  readonly name: string
  readonly callId: string
  readonly arguments: string
  readonly result?: readonly ContentPart[]
  readonly isError: boolean
  readonly error?: Failure
  readonly approval?: { readonly approvalId: string; readonly outcome?: string; readonly reason?: string }
}

export interface CompactionRecord extends RecordBase {
  readonly kind: 'compaction'
  readonly compactionId: string
  readonly shadowedTokenCount?: number
  readonly usage?: TokenUsage
  readonly error?: string
}

export type TrajectoryRecord =
  | UserRecord
  | SystemRecord
  | AssistantRecord
  | AttemptRecord
  | ToolRecord
  | CompactionRecord

export type RecordKind = TrajectoryRecord['kind']

export interface TrajectoryStep {
  readonly turn: number
  readonly step: number
  readonly start: number
  readonly end: number | null
  readonly records: readonly TrajectoryRecord[]
}

/** One turn, or one "between turns" group when `turn` is null. */
export interface TrajectoryGroup {
  readonly key: string
  readonly turn: number | null
  readonly start: number
  readonly end: number | null
  /** The turn opened before the loaded window; its start is the first loaded event. */
  readonly partialStart: boolean
  readonly reason?: TurnEndReason
  readonly steps: readonly TrajectoryStep[]
  /** Every record of the group in log order, including those outside steps. */
  readonly records: readonly TrajectoryRecord[]
}

export interface TrajectoryTotals {
  readonly requests: number
  readonly toolCalls: number
  readonly errors: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly cacheReadTokens: number
  readonly cacheWriteTokens: number
  readonly reasoningTokens: number
}

export interface TrajectoryModel {
  readonly groups: readonly TrajectoryGroup[]
  /** Every record in log order. */
  readonly records: readonly TrajectoryRecord[]
  readonly totals: TrajectoryTotals
  /** Earliest start and latest known instant over all records; null when empty. */
  readonly span: { readonly start: number; readonly end: number } | null
}
