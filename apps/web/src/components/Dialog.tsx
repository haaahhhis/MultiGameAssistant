/**
 * The app's own confirm and alert boxes, in place of the system's
 * window.confirm / window.alert (which look like the browser, not the app,
 * and do not exist in some desktop shells). Called from anywhere:
 *
 *   if (!await confirm({ title: '删除流水线？', confirmLabel: '删除', danger: true })) return
 *
 * One box at a time, over a dimmed page; later calls wait their turn. Esc or a
 * click on the dimmed page cancels. Focus starts on a button (取消 when the
 * action is dangerous, so a stray Enter does nothing harmful), Tab stays in the
 * box, and focus goes back to where it was when the box closes. `<DialogHost />`
 * is mounted once at the app's root (main.tsx).
 */
import { useEffect, useRef, useSyncExternalStore, type ReactNode } from 'react'
import { Icon, type IconName } from './Icons.tsx'

export interface ConfirmOptions {
  readonly title: string
  /**
   * The words under the title. A string is split into paragraphs at blank
   * lines, and a paragraph whose lines all start with "· " is shown as a list.
   */
  readonly message?: ReactNode
  /** The thing being acted on (a memory, a name), quoted in a box. */
  readonly quote?: string | undefined
  /** Default 确定. */
  readonly confirmLabel?: string | undefined
  /** Default 取消. */
  readonly cancelLabel?: string | undefined
  /** Cannot be undone or breaks something: the button is red and 取消 has focus. */
  readonly danger?: boolean | undefined
  readonly icon?: IconName | undefined
}

interface Pending extends ConfirmOptions {
  readonly id: number
  /** An alert: one button, nothing to decide. */
  readonly single: boolean
  readonly settle: (ok: boolean) => void
}

let queue: readonly Pending[] = []
let nextId = 1
const listeners = new Set<() => void>()
const emit = () => { for (const l of listeners) l() }
const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l) } }
const snapshot = () => queue[0]

function open(options: ConfirmOptions, single: boolean): Promise<boolean> {
  return new Promise(resolve => {
    const id = nextId++
    queue = [...queue, { ...options, id, single, settle: ok => {
      queue = queue.filter(p => p.id !== id)
      emit()
      resolve(ok)
    } }]
    emit()
  })
}

/** Asks before doing something. @returns true when the user chose the confirm button. */
export function confirm(options: ConfirmOptions): Promise<boolean> {
  return open(options, false)
}

/** Tells the user something that needs reading; resolves when the box is closed. */
export async function alert(options: Omit<ConfirmOptions, 'cancelLabel' | 'danger'>): Promise<void> {
  await open({ confirmLabel: '知道了', ...options }, true)
}

/** Where the boxes are drawn; mount once. */
export function DialogHost() {
  const current = useSyncExternalStore(subscribe, snapshot)
  return current === undefined ? null : <ConfirmBox key={current.id} pending={current} />
}

function ConfirmBox({ pending }: { pending: Pending }) {
  const { title, message, quote, confirmLabel = '确定', cancelLabel = '取消', danger = false, icon, single, settle } = pending
  const frame = useRef<HTMLDivElement>(null)
  const ok = useRef<HTMLButtonElement>(null)
  const cancel = useRef<HTMLButtonElement>(null)
  const titleId = `confirm-title-${pending.id}`
  const bodyId = `confirm-body-${pending.id}`

  // Focus a button now, and give it back to the opener afterwards.
  useEffect(() => {
    const opener = document.activeElement
    ;(danger && !single ? cancel : ok).current?.focus({ preventScroll: true })
    return () => { if (opener instanceof HTMLElement && opener.isConnected) opener.focus({ preventScroll: true }) }
  }, [danger, single])

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault()
        e.stopPropagation()
        settle(false)
        return
      }
      if (e.key !== 'Tab' || frame.current === null) return
      // Tab goes round the box's buttons: the page behind is out of reach while it is open.
      const stops = [...frame.current.querySelectorAll<HTMLElement>('button:not(:disabled)')]
      const at = stops.indexOf(document.activeElement as HTMLElement)
      e.preventDefault()
      const next = stops[(at + (e.shiftKey ? -1 : 1) + stops.length) % stops.length]
      next?.focus()
    }
    // Capture, so an Esc here does not also close a panel or dialog underneath.
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [settle])

  return (
    <div className="dialog-backdrop confirm-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) settle(false) }}>
      <div ref={frame} className={`dialog confirm-dialog ${danger ? 'danger' : ''}`} role={single ? 'dialog' : 'alertdialog'} aria-modal="true"
        aria-labelledby={titleId} aria-describedby={message === undefined && quote === undefined ? undefined : bodyId}>
        <h3 id={titleId}>{(icon !== undefined || danger) && <Icon name={icon ?? 'alert'} />}{title}</h3>
        {(message !== undefined || quote !== undefined) && (
          <div id={bodyId} className="confirm-body">
            {typeof message === 'string' ? <Words text={message} /> : message}
            {quote !== undefined && <blockquote className="confirm-quote">{quote}</blockquote>}
          </div>
        )}
        <div className="confirm-actions">
          {!single && <button ref={cancel} type="button" onClick={() => settle(false)}>{cancelLabel}</button>}
          <button ref={ok} type="button" className={danger ? 'danger' : 'primary'} onClick={() => settle(true)}>{confirmLabel}</button>
        </div>
      </div>
    </div>
  )
}

/** Paragraphs at blank lines; a paragraph of "· " lines is a list. */
function Words({ text }: { text: string }) {
  return (
    <>
      {text.split(/\n\s*\n/).map((para, i) => {
        const lines = para.split('\n').filter(l => l.trim() !== '')
        return lines.length > 0 && lines.every(l => l.startsWith('· '))
          ? <ul key={i}>{lines.map((l, j) => <li key={j}>{l.slice(2)}</li>)}</ul>
          : <p key={i}>{para}</p>
      })}
    </>
  )
}
