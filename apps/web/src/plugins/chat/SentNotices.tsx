/**
 * What the app told the person through the chat apps (`notify/notices`: an
 * incident, a pipeline's message or question, the daily report, 「脚本包要不要
 * 跟着改」) is part of 助手's conversation: shown there, between its turns,
 * with the same buttons; what was picked anywhere shows under it.
 */
import { useEffect, useState } from 'react'
import type { AdgClient, ChatItem } from '@adg/client-core'
import type { ChatNotice } from '@adg/protocol'
import { useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'
import { Icon } from '../../components/Icons.tsx'

/** A notice, placed in the conversation. */
export type SentItem = { readonly kind: 'sent'; readonly id: string; readonly notice: ChatNotice }

/** The notices, oldest first, kept current; none when `enabled` is false (not 助手's conversation). */
export function useSentNotices(client: AdgClient, enabled: boolean): readonly ChatNotice[] {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const [items, setItems] = useState<readonly ChatNotice[]>([])
  const on = enabled && capabilities.has('notify')
  useEffect(() => {
    if (!on || status.state !== 'open') return
    let live = true
    client.connection.call('notify/notices', {}).then(r => { if (live) setItems(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, on, status.state])
  useEffect(() => {
    if (!on) return
    return client.connection.on('notify/notice', ({ item }) => setItems(list => {
      const at = list.findIndex(n => n.id === item.id)
      return at < 0 ? [...list, item] : list.map(n => (n.id === item.id ? item : n))
    }))
  }, [client, on])
  return on ? items : []
}

/**
 * The conversation with the notices in it: each before the first turn that started after it was sent
 * (one sent during a turn comes after that turn), the latest at the end. `from`: older ones are not
 * shown (history not loaded that far).
 */
export function withNotices(items: readonly ChatItem[], notices: readonly ChatNotice[], from: number, startsTurn: (item: ChatItem) => boolean): (ChatItem | SentItem)[] {
  const shown = notices.filter(n => n.at >= from)
  if (shown.length === 0) return [...items]
  // When each turn started: its first item with a time (a reminder's line has none).
  const startAt: number[] = new Array(items.length)
  let next = Infinity
  for (let i = items.length - 1; i >= 0; i--) {
    const item = items[i]!
    if ('time' in item && typeof item.time === 'number') next = item.time
    startAt[i] = next
  }
  const out: (ChatItem | SentItem)[] = []
  let n = 0
  items.forEach((item, i) => {
    if (startsTurn(item)) while (n < shown.length && shown[n]!.at < startAt[i]!) out.push(sentItem(shown[n++]!))
    out.push(item)
  })
  while (n < shown.length) out.push(sentItem(shown[n++]!))
  return out
}

function sentItem(notice: ChatNotice): SentItem {
  return { kind: 'sent', id: `sent:${notice.id}`, notice }
}

const ICON = { info: 'send', success: 'check', warning: 'alert', error: 'alert' } as const

export function SentNotice({ client, notice }: { client: AdgClient; notice: ChatNotice }) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const open = notice.acted === undefined && notice.done === undefined && notice.actions.length > 0
  const act = (actionId: string) => {
    setBusy(actionId)
    setError(null)
    client.connection.call('notify/act', { noticeId: notice.id, actionId })
      .catch(e => setError(errorText(e)))
      .finally(() => setBusy(null))
  }
  const time = new Date(notice.at).toLocaleString('zh-CN', { hour12: false, month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
  return (
    <div className={`sent-notice ${notice.severity}`}>
      <div className="sent-notice-head">
        <Icon name={ICON[notice.severity]} />
        <span className="sent-notice-title">{notice.title}</span>
        <span className="spacer" />
        <span className="muted small">{notice.channels.length > 0 ? `发到${notice.channels.join('、')}` : '只在软件里'} · {time}</span>
      </div>
      <div className="sent-notice-text">{notice.text}</div>
      {notice.image === true && <div className="muted small">（附了一张截图，在聊天软件里看）</div>}
      {open && (
        <div className="sent-notice-actions">
          {notice.actions.map(a => (
            <button key={a.id} className={`small-button ${a.style === 'primary' ? 'primary' : a.style === 'danger' ? 'danger-outline' : ''}`} disabled={busy !== null} onClick={() => act(a.id)}>
              {busy === a.id ? <><span className="tool-spinner" aria-hidden />{a.label}</> : a.label}
            </button>
          ))}
          <span className="muted small">也可以直接跟助手说</span>
        </div>
      )}
      {notice.acted !== undefined && <div className="sent-notice-result"><Icon name="check" />{notice.acted.by}选了「{notice.acted.label}」——{notice.acted.result}</div>}
      {notice.acted === undefined && notice.done !== undefined && <div className="sent-notice-result"><Icon name="check" />{notice.done}</div>}
      {error !== null && <div className="error small">{error}</div>}
    </div>
  )
}
