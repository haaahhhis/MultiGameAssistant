/**
 * A dropdown drawn by the app instead of the system's <select>, so its open
 * list follows the theme: rounded panel, hint lines under options, groups,
 * dark mode. The list is rendered into <body> with fixed positioning, so a
 * scrolling card or panel never clips it; it opens upward when there is no
 * room below. Keyboard: arrows, Home / End, Enter or Space to choose, Esc to
 * close, a letter jumps to the next option starting with it.
 */
import { useEffect, useId, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent } from 'react'
import { createPortal } from 'react-dom'
import { Icon } from './Icons.tsx'

export interface SelectOption {
  readonly value: string
  readonly label: string
  /** A grey line under the label. */
  readonly hint?: string | undefined
  readonly disabled?: boolean | undefined
  /** Options with the same group are listed under its name (keep them together). */
  readonly group?: string | undefined
}

const LIST_MAX = 320
const GAP = 4

export function Select({ value, options, onChange, id, disabled, placeholder = '请选择', inline, className, ...aria }: {
  value: string
  options: readonly SelectOption[]
  onChange: (value: string) => void
  id?: string | undefined
  disabled?: boolean | undefined
  /** Shown when no option has `value`. */
  placeholder?: string | undefined
  /** Sized to its text, for use inside a sentence. */
  inline?: boolean | undefined
  className?: string | undefined
  'aria-label'?: string | undefined
}) {
  const listId = useId()
  const button = useRef<HTMLButtonElement>(null)
  const list = useRef<HTMLUListElement>(null)
  const [open, setOpen] = useState(false)
  const [active, setActive] = useState(-1)
  const [place, setPlace] = useState<CSSProperties>({})
  const selected = options.findIndex(o => o.value === value)
  const current = selected === -1 ? undefined : options[selected]

  const enabled = (i: number) => options[i] !== undefined && options[i]!.disabled !== true
  const step = (from: number, by: 1 | -1) => {
    for (let i = from + by; i >= 0 && i < options.length; i += by) if (enabled(i)) return i
    return from
  }
  const show = (at = selected) => {
    if (disabled === true) return
    setActive(enabled(at) ? at : step(-1, 1))
    setOpen(true)
  }
  const close = (refocus = true) => {
    setOpen(false)
    if (refocus) button.current?.focus()
  }
  const choose = (i: number) => {
    if (!enabled(i)) return
    if (options[i]!.value !== value) onChange(options[i]!.value)
    close()
  }

  // Under the button (or above it when there is no room), at least as wide as it.
  useLayoutEffect(() => {
    if (!open) return
    const position = () => {
      const r = button.current?.getBoundingClientRect()
      if (r === undefined) return
      const below = window.innerHeight - r.bottom - GAP - 8
      const above = r.top - GAP - 8
      const up = below < Math.min(LIST_MAX, list.current?.scrollHeight ?? LIST_MAX) && above > below
      const width = Math.max(r.width, 180)
      setPlace({
        left: Math.max(8, Math.min(r.left, window.innerWidth - width - 8)), minWidth: width, maxWidth: Math.max(width, Math.min(520, window.innerWidth - 16)),
        maxHeight: Math.min(LIST_MAX, up ? above : below),
        ...(up ? { bottom: window.innerHeight - r.top + GAP } : { top: r.bottom + GAP }),
      })
    }
    position()
    window.addEventListener('resize', position)
    window.addEventListener('scroll', position, true)
    return () => { window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true) }
  }, [open])

  // Keys go to the list while it is open; a click anywhere else closes it.
  useEffect(() => {
    if (!open) return
    list.current?.focus({ preventScroll: true })
    const outside = (e: PointerEvent) => {
      const target = e.target as Node
      if (!list.current?.contains(target) && !button.current?.contains(target)) close(false)
    }
    document.addEventListener('pointerdown', outside, true)
    return () => document.removeEventListener('pointerdown', outside, true)
  }, [open])
  useEffect(() => {
    if (open && active >= 0) list.current?.querySelector(`[data-index="${active}"]`)?.scrollIntoView({ block: 'nearest' })
  }, [open, active])

  const onButtonKey = (e: KeyboardEvent) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === ' ') {
      e.preventDefault()
      show()
    }
  }
  const onListKey = (e: KeyboardEvent) => {
    const keys: Record<string, () => void> = {
      ArrowDown: () => setActive(a => step(a, 1)),
      ArrowUp: () => setActive(a => step(a, -1)),
      Home: () => setActive(step(-1, 1)),
      End: () => setActive(step(options.length, -1)),
      Enter: () => choose(active),
      ' ': () => choose(active),
      Escape: () => close(),
      Tab: () => close(),
    }
    const handler = keys[e.key]
    if (handler !== undefined) {
      if (e.key !== 'Tab') e.preventDefault()
      handler()
      return
    }
    // Type-ahead: the next option whose label starts with the key.
    if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      const key = e.key.toLowerCase()
      for (let n = 1; n <= options.length; n++) {
        const i = (active + n) % options.length
        if (enabled(i) && options[i]!.label.toLowerCase().startsWith(key)) { setActive(i); break }
      }
    }
  }

  return (
    <>
      <button ref={button} id={id} type="button" disabled={disabled}
        className={`select-trigger text-input plain ${inline === true ? 'inline' : ''} ${open ? 'open' : ''} ${className ?? ''}`}
        aria-haspopup="listbox" aria-expanded={open} aria-controls={open ? listId : undefined} aria-label={aria['aria-label']}
        onClick={() => (open ? close() : show())} onKeyDown={onButtonKey}>
        <span className={`select-value ${current === undefined ? 'placeholder' : ''}`}>{current?.label ?? placeholder}</span>
      </button>
      {open && createPortal(
        <ul ref={list} id={listId} role="listbox" tabIndex={-1} className="select-list" style={place}
          aria-label={aria['aria-label']} aria-activedescendant={active >= 0 ? `${listId}-${active}` : undefined} onKeyDown={onListKey}>
          {options.map((o, i) => (
            <li key={`${o.group ?? ''}\u0000${o.value}`} role="presentation">
              {o.group !== undefined && o.group !== options[i - 1]?.group && <div className="select-group">{o.group}</div>}
              <div id={`${listId}-${i}`} data-index={i} role="option" aria-selected={i === selected} aria-disabled={o.disabled === true}
                className={`select-option ${i === active ? 'active' : ''} ${i === selected ? 'selected' : ''} ${o.disabled === true ? 'disabled' : ''}`}
                onPointerMove={() => { if (enabled(i) && i !== active) setActive(i) }}
                onClick={() => choose(i)}>
                <span className="select-text"><span>{o.label}</span>{o.hint !== undefined && <span className="select-hint">{o.hint}</span>}</span>
                {i === selected && <Icon name="check" className="select-check" />}
              </div>
            </li>
          ))}
          {options.length === 0 && <li role="presentation" className="select-empty">没有可选的</li>}
        </ul>,
        document.body,
      )}
    </>
  )
}
