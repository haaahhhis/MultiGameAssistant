import { createContext, useContext, useState, type ReactNode } from 'react'
import { readDraft } from '../drafts.ts'
import { CopyButton } from './CopyButton.tsx'
import { Icon } from './Icons.tsx'

export interface MessageQuote {
  author: '用户' | '助手'
  id: string
  text: string
}

/** The same readable quote travels with the prompt through history, steering and the queue. */
export function withQuote(body: string, quote: MessageQuote | null): string {
  if (!quote) return body
  const lines = quote.text.replace(/\r\n?/g, '\n').split('\n').map(line => '> ' + line)
  return `引用${quote.author}消息（${quote.id}）\n${lines.join('\n')}\n\n${body}`
}

export function readQuote(text: string): { body: string; quote: MessageQuote | null } {
  const header = /^引用(用户|助手)消息（([au]:\d+)）\n/.exec(text)
  const end = header ? text.indexOf('\n\n', header[0].length) : -1
  if (header && end >= 0) {
    const lines = text.slice(header[0].length, end).split('\n')
    if (lines.every(line => line.startsWith('> '))) {
      const author = header[1] === '用户' ? '用户' : '助手'
      return { body: text.slice(end + 2), quote: { author, id: header[2]!, text: lines.map(line => line.slice(2)).join('\n') } }
    }
  }
  return { body: text, quote: null }
}

export const ReplyDraft = createContext<{ quote: MessageQuote | null; select: (quote: MessageQuote | null) => void } | null>(null)

export function ReplyProvider({ sessionId, children }: { sessionId: string; children: ReactNode }) {
  const [quote, select] = useState(() => readQuote(readDraft(sessionId)).quote)
  return <ReplyDraft.Provider value={{ quote, select }}>{children}</ReplyDraft.Provider>
}

export function QuotePreview({ quote, onRemove }: { quote: MessageQuote; onRemove?: () => void }) {
  return (
    <div className="message-quote">
      <blockquote><strong>回复{quote.author}</strong><span title={quote.text}>{quote.text}</span></blockquote>
      {onRemove && <button type="button" className="msg-action" aria-label="取消引用" title="取消引用" onClick={onRemove}><Icon name="close" /></button>}
    </div>
  )
}

export function MessageActions({ text, author, id, canReply = true }: MessageQuote & { canReply?: boolean }) {
  const draft = useContext(ReplyDraft)
  return (
    <div className="msg-actions">
      <CopyButton text={text} />
      {draft && canReply && <button type="button" className="msg-action" aria-label="引用回复" title="引用回复，可先选中一句话"
        onMouseDown={e => e.preventDefault()}
        onClick={e => {
          const body = e.currentTarget.closest('.message-line')?.querySelector('[data-reply-text]')
          const selection = window.getSelection()
          const selected = selection && body?.contains(selection.anchorNode) && body.contains(selection.focusNode) ? selection.toString().trim() : ''
          draft.select({ id, author, text: selected || text })
        }}><Icon name="reply" /></button>}
    </div>
  )
}
