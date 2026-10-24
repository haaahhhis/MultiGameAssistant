import { memo, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { buildChat, type ChatItem } from '@adg/client-core'
import { prettyJson } from '@adg/trajectory'
import { summarizeToolArgs } from '@adg/protocol'
import { Markdown } from '../../components/Markdown.tsx'
import { Icon, AdgMark } from '../../components/Icons.tsx'
import { ImageClient, StoredImage } from '../../components/StoredImage.tsx'
import type { SessionViewProps } from '../../plugins.ts'
import { SkillOffer } from './SkillOffer.tsx'

/** Pixels from the bottom within which new output keeps the view pinned. */
const STICK_THRESHOLD = 80

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
/** A rendered row: one chat item, or a run of consecutive tool calls. */
type Row =
  | { readonly kind: 'item'; readonly item: ChatItem; readonly header: TurnHeader | null }
  | { readonly kind: 'tools'; readonly id: string; readonly tools: readonly ToolItem[]; readonly header: TurnHeader | null }
/** Shown above the first agent output of each turn. */
type TurnHeader = { readonly model: string | undefined }

export function ChatView({ client, session, state }: SessionViewProps) {
  const items = useMemo(
    () => buildChat(state.events, state.live, state.pending),
    // `version` covers in-place live delta appends.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [state.events, state.live, state.pending, state.version],
  )
  const rows = useMemo(() => groupRows(items), [items])
  const scroller = useRef<HTMLDivElement>(null)
  const stick = useRef(true)

  const onScroll = () => {
    const el = scroller.current
    if (el === null) return
    stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < STICK_THRESHOLD
    if (el.scrollTop < 40 && state.hasMore && !state.loadingOlder) void session.loadOlder()
  }

  useLayoutEffect(() => {
    const el = scroller.current
    if (el !== null && stick.current) el.scrollTop = el.scrollHeight
  }, [items])

  // Keep the scroll position stable when older history is prepended.
  const firstSeq = state.events[0]?.seq
  const previousHeight = useRef(0)
  useLayoutEffect(() => {
    const el = scroller.current
    if (el === null) return
    if (previousHeight.current !== 0 && !stick.current) el.scrollTop += el.scrollHeight - previousHeight.current
    previousHeight.current = el.scrollHeight
  }, [firstSeq])

  return (
    <ImageClient.Provider value={client}>
    <div className="chat" ref={scroller} onScroll={onScroll}>
      <div className="chat-inner">
        {state.hasMore && (
          <button className="link-button load-older" disabled={state.loadingOlder} onClick={() => void session.loadOlder()}>
            {state.loadingOlder ? '加载中…' : '加载更早的消息'}
          </button>
        )}
        {state.status === 'opening' && items.length === 0 && <div className="empty">正在打开会话…</div>}
        {state.status !== 'opening' && items.length === 0 && (
          <div className="empty chat-empty">
            <AdgMark size="lg" />
            <h2>今天，我们一起完成什么？</h2>
            <p>一个问题、一段代码，或一个还不成熟的想法。<br />在下方写下来，让对话开始。</p>
          </div>
        )}
        {rows.map(row => row.kind === 'tools'
          ? <Turn key={row.id} header={row.header}><ToolGroup tools={row.tools} /></Turn>
          : <Turn key={row.item.id} header={row.header}><ChatRow item={row.item} onDismiss={id => session.dismissPending(id)} /></Turn>)}
        {state.running && state.live === null && <div className="thinking"><span className="dot-pulse"><i /><i /><i /></span>正在处理…</div>}
        {!state.running && state.queue.length === 0 && <SkillOffer session={session} title={state.title} items={items} />}
      </div>
    </div>
    </ImageClient.Provider>
  )
}

/** Merge consecutive tool calls, and mark where each turn's agent output starts. */
function groupRows(items: readonly ChatItem[]): Row[] {
  const rows: Row[] = []
  let headed = false
  const header = (from: number): TurnHeader | null => {
    if (headed) return null
    headed = true
    for (let i = from; i < items.length && items[i]!.kind !== 'user'; i++) {
      const item = items[i]!
      if (item.kind === 'assistant' && item.model !== undefined) return { model: item.model }
    }
    return { model: undefined }
  }
  for (let i = 0; i < items.length; i++) {
    const item = items[i]!
    if (item.kind === 'user') {
      headed = false
      rows.push({ kind: 'item', item, header: null })
    } else if (item.kind === 'tool') {
      const last = rows.at(-1)
      if (last?.kind === 'tools') rows[rows.length - 1] = { ...last, tools: [...last.tools, item] }
      else rows.push({ kind: 'tools', id: `tools-${item.id}`, tools: [item], header: header(i) })
    } else if (item.kind === 'assistant') {
      rows.push({ kind: 'item', item, header: header(i) })
    } else {
      rows.push({ kind: 'item', item, header: null })
    }
  }
  return rows
}

function Turn({ header, children }: { header: TurnHeader | null; children: ReactNode }) {
  if (header === null) return <>{children}</>
  return (
    <>
      <div className="turn-header">
        <AdgMark size="sm" />
        <span className="turn-name">agent</span>
        {header.model !== undefined && <span className="turn-model">{header.model}</span>}
      </div>
      {children}
    </>
  )
}

const ChatRow = memo(function ChatRow({ item, onDismiss }: { item: ChatItem; onDismiss: (requestId: string) => void }) {
  switch (item.kind) {
    case 'user':
      return (
        <div className={`msg user ${item.pending === undefined ? '' : 'pending'}`}>
          <div className="bubble">
            {item.text}
            {item.imageRefs.length > 0 && <div className="chat-images">{item.imageRefs.map(image => <StoredImage key={image.attachmentId} image={image} />)}</div>}
            {(item.images > item.imageRefs.length || item.files > 0) && (
              <div className="attachments">
                {item.images > item.imageRefs.length && <span><Icon name="image" />{item.images - item.imageRefs.length} 张图片</span>}
                {item.files > 0 && <span><Icon name="paperclip" />{item.files} 个文件</span>}
              </div>
            )}
          </div>
          {item.pending?.failed !== undefined && (
            <div className="send-failed">
              发送失败：{item.pending.failed}
              <button className="link-button" onClick={() => onDismiss(item.pending!.requestId)}>移除</button>
            </div>
          )}
        </div>
      )
    case 'assistant':
      return (
        <div className={`msg assistant ${item.live ? 'live' : ''}`}>
          {item.reasoning.trim() !== '' && (
            <details className="reasoning" open={item.live && item.text === ''}>
              <summary><Icon name="chevron" />{item.live && item.text === '' ? <span className="shimmer">正在思考…</span> : '思考过程'}</summary>
              <Markdown text={item.reasoning} />
            </details>
          )}
          {item.text !== '' && <Markdown text={item.text} />}
          {item.live && <span className="cursor" />}
          {item.interrupted && <div className="muted small">（已中断）</div>}
        </div>
      )
    case 'tool':
      return <ToolGroup tools={[item]} />
    case 'context':
      return (
        <details className="context-row">
          <summary><Icon name="info" />{item.summary !== '' ? item.summary : item.title}</summary>
          <pre>{item.text}</pre>
        </details>
      )
    case 'notice':
      return <div className={`notice ${item.tone}`}>{item.tone === 'error' && <Icon name="alert" />}{item.text}</div>
  }
})

/** A run of tool calls as one quiet timeline card. */
function ToolGroup({ tools }: { tools: readonly ToolItem[] }) {
  const running = tools.filter(t => t.status === 'running').length
  const failed = tools.filter(t => t.status === 'error').length
  const [open, setOpen] = useState<boolean | null>(null)
  const expanded = open ?? (running > 0 || failed > 0 || tools.length <= 4)
  return (
    <div className="tool-group">
      <button className="tool-group-head" onClick={() => setOpen(!expanded)} aria-expanded={expanded}>
        <Icon name="terminal" />
        <span className="tool-group-title">{tools.length === 1 ? '执行了 1 个步骤' : `执行了 ${tools.length} 个步骤`}</span>
        <span className="tool-group-meta">
          {running > 0 && <span className="tone-running">{running} 个进行中</span>}
          {failed > 0 && <span className="tone-failed">{failed} 个失败</span>}
        </span>
        <Icon name="chevron-down" className={`chevron-icon ${expanded ? 'open' : ''}`} />
      </button>
      {expanded && tools.map(tool => <ToolRow key={tool.id} item={tool} />)}
    </div>
  )
}

const STATUS_LABEL: Record<string, string> = { running: '运行中', ok: '完成', error: '失败', interrupted: '已中断' }

function ToolRow({ item }: { item: ToolItem }) {
  const [open, setOpen] = useState(false)
  const summary = useMemo(() => summarizeToolArgs(item.arguments), [item.arguments])
  useEffect(() => {
    if (item.status === 'error') setOpen(true)
  }, [item.status])
  return (
    <div className={`tool ${item.status}`}>
      <button className="tool-head" onClick={() => setOpen(o => !o)} aria-expanded={open}>
        <ToolStatusIcon status={item.status} />
        <span className="tool-name">{item.name}</span>
        <span className="tool-summary">{summary}</span>
        {item.approval !== undefined && <span className={`badge approval-${item.approval}`}>{approvalLabel(item.approval)}</span>}
        <span className="tool-status">{STATUS_LABEL[item.status]}</span>
      </button>
      {item.images !== undefined && <div className="chat-images tool-images">{item.images.map(image => <StoredImage key={image.attachmentId} image={image} />)}</div>}
      {open && (
        <div className="tool-body">
          <div className="label">参数</div>
          <pre>{prettyJson(item.arguments)}</pre>
          {item.result !== undefined && (
            <>
              <div className="label">结果{item.error !== undefined ? ` · ${item.error}` : ''}</div>
              <pre>{item.result}</pre>
            </>
          )}
        </div>
      )}
    </div>
  )
}

function ToolStatusIcon({ status }: { status: string }) {
  if (status === 'running') return <span className="tool-spinner" role="img" aria-label="运行中" />
  if (status === 'ok') return <span className="tool-icon ok" role="img" aria-label="完成"><Icon name="check" /></span>
  if (status === 'error') return <span className="tool-icon error" role="img" aria-label="失败"><Icon name="close" /></span>
  return <span className="tool-icon" role="img" aria-label={STATUS_LABEL[status] ?? status}><Icon name="info" /></span>
}

function approvalLabel(state: string): string {
  switch (state) {
    case 'asked': return '等待审批'
    case 'allowed-once': return '已允许'
    case 'rejected': return '已拒绝'
    case 'cancelled': return '已撤回'
    default: return state
  }
}

/** One-line digest of the most telling argument (command, path, query…). */
