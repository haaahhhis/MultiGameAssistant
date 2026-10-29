/**
 * Chat view model: the transcript a conversation UI renders, derived purely
 * from protocol events, the streaming attempt, and local prompt echoes.
 */
import type { ContentPart, SessionEvent } from '@adg/protocol'
import type { LiveAttemptView } from '@adg/trajectory'
import type { PendingPrompt } from './session.ts'

export type ToolStatus = 'running' | 'ok' | 'error' | 'interrupted'

/** A stored image the UI can fetch with `attachments/image`. */
export interface ChatImage {
  readonly attachmentId: string
  readonly mediaType: string
  readonly bytes: number
  readonly width: number
  readonly height: number
  readonly name?: string
}

export type ChatItem =
  | {
    readonly kind: 'user'
    readonly id: string
    readonly text: string
    readonly images: number
    /** The images that can be shown (stored ones). */
    readonly imageRefs: readonly ChatImage[]
    readonly files: number
    readonly time: number
    /** Local echo not yet in the log; `failed` carries the send error. */
    readonly pending?: { readonly requestId: string; readonly failed?: string }
  }
  | {
    readonly kind: 'context'
    readonly id: string
    readonly title: string
    readonly summary: string
    readonly text: string
  }
  | {
    readonly kind: 'assistant'
    readonly id: string
    readonly text: string
    readonly reasoning: string
    readonly live: boolean
    readonly interrupted: boolean
    readonly model?: string
    readonly time: number
  }
  | {
    readonly kind: 'tool'
    readonly id: string
    readonly callId: string
    readonly name: string
    readonly arguments: string
    readonly result?: string
    /** Images in the result (a screenshot). */
    readonly images?: readonly ChatImage[]
    readonly status: ToolStatus
    readonly error?: string
    readonly approval?: string
    readonly time: number
  }
  | { readonly kind: 'notice'; readonly id: string; readonly tone: 'error' | 'info'; readonly text: string }

type Mutable<T> = { -readonly [K in keyof T]: T[K] }
type ToolItem = Mutable<Extract<ChatItem, { kind: 'tool' }>>

const joinText = (content: readonly ContentPart[], type: 'text' | 'reasoning'): string =>
  content.map(p => (p.type === type ? p.text : '')).join('')

const imagesOf = (content: readonly ContentPart[]): ChatImage[] =>
  content.flatMap(p => p.type === 'image' && p.attachmentId !== undefined && p.mediaType !== undefined && p.bytes !== undefined && p.width !== undefined && p.height !== undefined
    ? [{ attachmentId: p.attachmentId, mediaType: p.mediaType, bytes: p.bytes, width: p.width, height: p.height, ...(p.name === undefined ? {} : { name: p.name }) }]
    : [])

const resultText = (content: readonly ContentPart[]): string =>
  content.map(p => (p.type === 'text' ? p.text : p.type === 'image' ? '[image]' : p.type === 'file' ? `[file ${p.name ?? ''}]` : '')).join('')

/**
 * Build the transcript.
 * @param events - loaded protocol events, ascending by seq.
 * @param live - the streaming attempt, or null.
 * @param pending - local prompt echoes not yet in the log.
 */
export function buildChat(
  events: readonly SessionEvent[],
  live: LiveAttemptView | null,
  pending: readonly PendingPrompt[] = [],
): ChatItem[] {
  const items: ChatItem[] = []
  const tools = new Map<string, ToolItem>()
  const committed = new Set<string>()
  /** callId → approval state ('asked' or the decided outcome). */
  const approvals = new Map<string, string>()
  const approvalCalls = new Map<string, string>()

  for (const event of events) {
    switch (event.type) {
      case 'user/message': {
        const text = joinText(event.content, 'text')
        if (event.origin.human) {
          items.push({
            kind: 'user', id: `u:${event.seq}`, text, time: event.time,
            images: event.content.filter(p => p.type === 'image').length,
            imageRefs: imagesOf(event.content),
            files: event.content.filter(p => p.type === 'file').length,
          })
        } else if (event.replacesHistory === true) {
          items.push({ kind: 'context', id: `c:${event.seq}`, title: '较早的对话已压缩成摘要（agent 只记得摘要里的内容）', summary: '', text })
        } else if (event.origin.summary !== undefined) {
          items.push({ kind: 'context', id: `c:${event.seq}`, title: event.origin.kind, summary: event.origin.summary, text })
        }
        break
      }
      case 'assistant/message': {
        committed.add(`${event.turn}:${event.step}`)
        const text = joinText(event.content, 'text')
        const reasoning = joinText(event.content, 'reasoning')
        if (text.trim() !== '' || reasoning.trim() !== '') {
          items.push({
            kind: 'assistant', id: `a:${event.seq}`, text, reasoning, live: false,
            interrupted: event.interrupted === true, time: event.time,
            ...(event.model === undefined ? {} : { model: event.model }),
          })
        }
        break
      }
      case 'tool/call': {
        const item: ToolItem = {
          kind: 'tool', id: `t:${event.callId}`, callId: event.callId, name: event.name,
          arguments: event.arguments, status: 'running', time: event.time,
        }
        const approval = approvals.get(event.callId)
        if (approval !== undefined) item.approval = approval
        tools.set(event.callId, item)
        items.push(item)
        break
      }
      case 'tool/result': {
        const item = tools.get(event.callId)
        if (item === undefined) break
        item.result = resultText(event.content)
        const images = imagesOf(event.content)
        if (images.length > 0) item.images = images
        item.status = event.isError ? 'error' : 'ok'
        if (event.error !== undefined) item.error = event.error.message
        break
      }
      case 'approval/asked':
        if (event.callId !== undefined) {
          approvalCalls.set(event.approvalId, event.callId)
          approvals.set(event.callId, 'asked')
          const item = tools.get(event.callId)
          if (item !== undefined) item.approval = 'asked'
        }
        break
      case 'approval/decided': {
        const callId = approvalCalls.get(event.approvalId)
        if (callId === undefined) break
        approvals.set(callId, event.outcome)
        const item = tools.get(callId)
        if (item !== undefined) item.approval = event.outcome
        break
      }
      case 'turn/end':
        for (const item of tools.values()) {
          if (item.status === 'running') item.status = 'interrupted'
        }
        if (event.reason.kind === 'error') {
          items.push({ kind: 'notice', id: `e:${event.seq}`, tone: 'error', text: event.reason.message ?? '这一轮出错了' })
        } else if (event.reason.kind === 'aborted') {
          items.push({ kind: 'notice', id: `e:${event.seq}`, tone: 'info', text: '已停止' })
        } else if (event.reason.kind === 'max-tokens') {
          items.push({ kind: 'notice', id: `e:${event.seq}`, tone: 'info', text: '回复太长，达到了输出上限' })
        }
        break
      case 'compaction/end':
        items.push({
          kind: 'notice', id: `k:${event.seq}`, tone: event.error === undefined ? 'info' : 'error',
          text: event.error === undefined ? '对话太长，较早的内容已压缩成摘要' : `压缩对话历史失败：${event.error}`,
        })
        break
      default:
        break
    }
  }

  if (live !== null && !committed.has(`${live.turn}:${live.step}`)) {
    let text = ''
    let reasoning = ''
    for (const delta of live.deltas) {
      if (delta.kind === 'text') text += delta.text
      else if (delta.kind === 'reasoning') reasoning += delta.text
    }
    items.push({
      kind: 'assistant', id: `live:${live.attemptId}`, text, reasoning, live: true, interrupted: false,
      time: live.deltas[0]?.time ?? Date.now(),
    })
  }

  for (const echo of pending) {
    items.push({
      kind: 'user', id: `p:${echo.requestId}`, text: echo.text, images: echo.images ?? 0, imageRefs: [], files: 0, time: echo.sentAt,
      pending: { requestId: echo.requestId, ...(echo.failed === undefined ? {} : { failed: echo.failed }) },
    })
  }
  return items
}
