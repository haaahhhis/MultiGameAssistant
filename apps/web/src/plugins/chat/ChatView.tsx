import { memo, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { buildChat, type ChatItem } from '@adg/client-core'
import { prettyJson } from '@adg/trajectory'
import { isQuiet, parseRelay, parseTask, splitSlash, summarizeToolArgs } from '@adg/protocol'
import { MAIN, agentIdOf, useHandOffs, useRoles } from '../../agents.ts'
import { DelegationCard, DELEGATE_TOOL, HandOffStrip, HandOffsOf, RelayMessage, TaskMessage } from './Delegation.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { useStore } from '../../hooks.ts'
import { Icon, AdgMark } from '../../components/Icons.tsx'
import { ImageClient, StoredImage } from '../../components/StoredImage.tsx'
import type { SessionViewProps } from '../../plugins.ts'
import { SkillOffer } from './SkillOffer.tsx'

/** Pixels from the bottom within which new output keeps the view pinned. */
const STICK_THRESHOLD = 80

type ToolItem = Extract<ChatItem, { kind: 'tool' }>
/**
 * A rendered row: one chat item, a run of consecutive tool calls, or the
 * steps a turn took before its reply, folded into one line (`process`).
 */
type Row =
  | { readonly kind: 'item'; readonly item: ChatItem; readonly header: TurnHeader | null }
  | { readonly kind: 'tools'; readonly id: string; readonly tools: readonly ToolItem[]; readonly header: TurnHeader | null }
  | { readonly kind: 'process'; readonly id: string; readonly items: readonly ChatItem[]; readonly header: TurnHeader | null }
  /** Work 助手 handed to another agent (agent_delegate): what it asked and what came back, never folded. */
  | { readonly kind: 'delegation'; readonly item: ToolItem; readonly header: TurnHeader | null }
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
  const roles = useRoles(client)
  const item = useStore(client.sessions).items.find(i => i.id === session.id)
  const agentName = roles.find(r => r.id === (item === undefined ? undefined : agentIdOf(item, roles)))?.name ?? MAIN.name
  // Work handed on from here, and to here (Delegation.tsx); the app's own still going shows at the end.
  const handOffs = useHandOffs(client, session.id)
  const appWork = handOffs.filter(h => h.fromSession === session.id && h.callId === undefined && h.state === 'running')
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
    <HandOffsOf.Provider value={handOffs}>
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
        {rows.map((row, index) => row.kind === 'tools'
          ? <Turn key={row.id} name={agentName} header={row.header}><ToolGroup tools={row.tools} /></Turn>
          : row.kind === 'delegation'
            ? <Turn key={row.item.id} name={agentName} header={row.header}><DelegationCard client={client} item={row.item} handOffs={handOffs} /></Turn>
          : row.kind === 'process'
            ? <Turn key={row.id} name={agentName} header={row.header}><ProcessGroup items={row.items} active={state.running && index === rows.length - 1} onDismiss={id => session.dismissPending(id)} /></Turn>
            : <Turn key={row.item.id} name={agentName} header={row.header}><ChatRow item={row.item} onDismiss={id => session.dismissPending(id)} /></Turn>)}
        {appWork.map(h => <HandOffStrip key={h.id} client={client} handOff={h} />)}
        {state.running && state.live === null && <div className="thinking"><span className="dot-pulse"><i /><i /><i /></span>正在处理…</div>}
        {!state.running && state.queue.length === 0 && <SkillOffer session={session} title={state.title} items={items} />}
      </div>
    </div>
    </HandOffsOf.Provider>
    </ImageClient.Provider>
  )
}

/**
 * Lay out the chat by turns (each starts at a user message): the steps an
 * agent took before its reply — tool calls and what it said between them —
 * fold into one `process` row, so the reply leads. Still on view: a step
 * waiting for your approval, work handed to another agent, notices, and a
 * turn's steps with no tool call.
 * The first agent row of each turn carries the turn header.
 */
function groupRows(items: readonly ChatItem[]): Row[] {
  const rows: Row[] = []
  let start = 0
  for (let i = 0; i <= items.length; i++) {
    if (i < items.length && items[i]!.kind !== 'user') continue
    turnRows(items.slice(start, i), rows)
    if (i < items.length) rows.push({ kind: 'item', item: items[i]!, header: null })
    start = i + 1
  }
  return rows
}

function turnRows(turn: readonly ChatItem[], rows: Row[]): void {
  let headed = false
  const model = turn.find(item => item.kind === 'assistant' && item.model !== undefined)
  const header = (): TurnHeader | null => {
    if (headed) return null
    headed = true
    return { model: model?.kind === 'assistant' ? model.model : undefined }
  }
  const plain = (item: ChatItem) => {
    if (item.kind === 'tool' && item.name === DELEGATE_TOOL) rows.push({ kind: 'delegation', item, header: header() })
    else if (item.kind === 'tool') {
      const last = rows.at(-1)
      if (last?.kind === 'tools') rows[rows.length - 1] = { ...last, tools: [...last.tools, item] }
      else rows.push({ kind: 'tools', id: `tools-${item.id}`, tools: [item], header: header() })
    } else rows.push({ kind: 'item', item, header: item.kind === 'assistant' ? header() : null })
  }
  let steps: ChatItem[] = []
  const fold = () => {
    if (steps.some(item => item.kind === 'tool')) rows.push({ kind: 'process', id: `process-${steps[0]!.id}`, items: steps, header: header() })
    else for (const item of steps) plain(item)
    steps = []
  }
  // The reply: the turn's last agent message with text. None yet: all of it is steps.
  let reply = turn.length
  for (let i = turn.length - 1; i >= 0; i--) {
    const item = turn[i]!
    if (item.kind === 'assistant' && item.text.trim() !== '') { reply = i; break }
  }
  for (let i = 0; i < reply; i++) {
    const item = turn[i]!
    if (item.kind === 'notice' || item.kind === 'context' || (item.kind === 'tool' && (item.approval === 'asked' || item.name === DELEGATE_TOOL))) {
      fold()
      plain(item)
    } else steps.push(item)
  }
  fold()
  for (let i = reply; i < turn.length; i++) plain(turn[i]!)
}

function Turn({ name, header, children }: { name: string; header: TurnHeader | null; children: ReactNode }) {
  if (header === null) return <>{children}</>
  return (
    <>
      <div className="turn-header">
        <AdgMark size="sm" />
        <span className="turn-name">{name}</span>
        {header.model !== undefined && <span className="turn-model">{header.model}</span>}
      </div>
      {children}
    </>
  )
}

/** A slash command shows as typed; the instruction it carried folds away below. */
function UserText({ text }: { text: string }) {
  const slash = splitSlash(text)
  if (slash === undefined) return <>{text}</>
  return (
    <>
      {slash.typed}
      <details className="slash-expansion"><summary>发给 agent 的完整指令</summary>{slash.expansion}</details>
    </>
  )
}

/** Notes the app puts before a person's message for the agent (packages/notify notify.ts): where it came from, how long since the last. */
const CHANNEL_NOTE = /^（这条消息来自([^。）]+)。[^\n]*）\n/
const IDLE_NOTE = /^（距离这个对话的上一条消息已经过了[^\n]*）\n/

function personText(text: string): { text: string; channel?: string } {
  const channel = CHANNEL_NOTE.exec(text)
  const rest = (channel === null ? text : text.slice(channel[0].length)).replace(IDLE_NOTE, '')
  return channel === null ? { text: rest } : { text: rest, channel: channel[1]! }
}

const ChatRow = memo(function ChatRow({ item, onDismiss }: { item: ChatItem; onDismiss: (requestId: string) => void }) {
  const client = useContext(ImageClient)
  const handOffs = useContext(HandOffsOf)
  switch (item.kind) {
    case 'user': {
      // Not the person's words: a reply another agent sent back, or work handed here (Delegation.tsx).
      const relay = item.pending === undefined ? parseRelay(item.text) : undefined
      if (relay !== undefined && client !== null) return <RelayMessage client={client} note={relay} handOffs={handOffs} />
      const task = item.pending === undefined ? parseTask(item.text) : undefined
      if (task !== undefined) return <TaskMessage note={task} />
      const said = personText(item.text)
      return (
        <div className={`msg user ${item.pending === undefined ? '' : 'pending'}`}>
          {said.channel !== undefined && <div className="msg-from">来自{said.channel}</div>}
          <div className="bubble">
            <UserText text={said.text} />
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
    }
    case 'assistant':
      // 助手 read a reply that came back and found nothing the person needs to hear.
      if (!item.live && isQuiet(item.text)) return <div className="quiet-reply"><Icon name="check" />看过了，没有要告诉你的</div>
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

/**
 * The steps a turn took before its reply, folded to one line: how many, how
 * many failed, and while the agent is still at it (`active`), what it is
 * doing now. Open, it shows them in order.
 */
function ProcessGroup({ items, active, onDismiss }: { items: readonly ChatItem[]; active: boolean; onDismiss: (requestId: string) => void }) {
  const tools = items.filter((item): item is ToolItem => item.kind === 'tool')
  const running = tools.filter(t => t.status === 'running').length
  const failed = tools.filter(t => t.status === 'error').length
  const [open, setOpen] = useState(false)
  const now = active && !open ? activity(items.at(-1)!) : undefined
  return (
    <div className="tool-group process-group">
      <button className="tool-group-head" onClick={() => setOpen(!open)} aria-expanded={open}>
        <Icon name="terminal" />
        <span className="tool-group-title">{`执行了 ${tools.length} 个步骤`}</span>
        {now !== undefined && now !== '' && <span className="process-now">{now}</span>}
        <span className="tool-group-meta">
          {running > 0 && <span className="tone-running">{running} 个进行中</span>}
          {failed > 0 && <span className="tone-failed">{failed} 个失败</span>}
        </span>
        <Icon name="chevron-down" className={`chevron-icon ${open ? 'open' : ''}`} />
      </button>
      {open && items.map(item => item.kind === 'tool'
        ? <ToolRow key={item.id} item={item} />
        : <div key={item.id} className="process-note"><ChatRow item={item} onDismiss={onDismiss} /></div>)}
    </div>
  )
}

/** What a step is doing, in a line: the tool and its argument, or what the agent said. */
function activity(item: ChatItem): string {
  if (item.kind === 'tool') return `${item.name} ${summarizeToolArgs(item.arguments)}`.trim()
  if (item.kind === 'assistant') return item.text.trim().split('\n')[0] || '正在思考…'
  return ''
}

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
