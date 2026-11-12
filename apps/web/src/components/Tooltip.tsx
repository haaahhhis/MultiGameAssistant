/**
 * Hover hints drawn by the app instead of the system's: every `title="…"` in
 * the UI shows as a small themed tip (like the slash menu's), so no component
 * has to change. While the pointer rests on an element with a title, the
 * title is set aside (so the system's own tip does not show as well) and put
 * back when the pointer leaves, a key or button is pressed, or the page
 * scrolls. Mounted once at the app's root (main.tsx).
 */
import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'

const DELAY = 450
const GAP = 6
const EDGE = 8
const HELD = 'data-tip'

interface Tip { readonly text: string; readonly anchor: DOMRect }

export function TooltipHost() {
  const [tip, setTip] = useState<Tip | null>(null)
  const box = useRef<HTMLDivElement>(null)
  const [place, setPlace] = useState<{ left: number; top: number; below: boolean } | null>(null)

  useEffect(() => {
    let target: HTMLElement | null = null
    let timer: number | undefined

    const release = () => {
      window.clearTimeout(timer)
      timer = undefined
      if (target !== null) {
        const held = target.getAttribute(HELD)
        target.removeAttribute(HELD)
        // React may have written a new title meanwhile; keep that one.
        if (held !== null && !target.hasAttribute('title')) target.setAttribute('title', held)
      }
      target = null
      setTip(null)
    }

    const over = (e: PointerEvent) => {
      if (e.pointerType === 'touch') return
      // Still inside the element whose title is set aside (its own title is gone, so `closest` would miss it).
      if (target !== null && target.contains(e.target as Node)) {
        const inner = (e.target as Element).closest?.<HTMLElement>('[title]')
        if (inner === null || inner === undefined || !target.contains(inner)) return
      }
      const el = (e.target as Element | null)?.closest?.<HTMLElement>('[title]') ?? null
      if (el === target) return
      release()
      if (el === null) return
      const text = el.getAttribute('title') ?? ''
      if (text.trim() === '') return
      target = el
      el.setAttribute(HELD, text)
      el.removeAttribute('title')
      timer = window.setTimeout(() => {
        if (target === el && el.isConnected) setTip({ text, anchor: el.getBoundingClientRect() })
      }, DELAY)
    }
    const out = (e: PointerEvent) => {
      if (target === null) return
      const to = e.relatedTarget as Node | null
      if (to === null || !target.contains(to)) release()
    }

    document.addEventListener('pointerover', over, true)
    document.addEventListener('pointerout', out, true)
    document.addEventListener('pointerdown', release, true)
    document.addEventListener('keydown', release, true)
    window.addEventListener('scroll', release, true)
    window.addEventListener('blur', release)
    return () => {
      release()
      document.removeEventListener('pointerover', over, true)
      document.removeEventListener('pointerout', out, true)
      document.removeEventListener('pointerdown', release, true)
      document.removeEventListener('keydown', release, true)
      window.removeEventListener('scroll', release, true)
      window.removeEventListener('blur', release)
    }
  }, [])

  // Above the element (below when there is no room), centred on it, kept on screen.
  useLayoutEffect(() => {
    if (tip === null || box.current === null) { setPlace(null); return }
    const { width, height } = box.current.getBoundingClientRect()
    const a = tip.anchor
    const below = a.top - GAP - height < EDGE
    const left = Math.max(EDGE, Math.min(a.left + a.width / 2 - width / 2, window.innerWidth - width - EDGE))
    setPlace({ left, top: below ? a.bottom + GAP : a.top - GAP - height, below })
  }, [tip])

  if (tip === null) return null
  return createPortal(
    <div ref={box} className={`app-tooltip ${place?.below === true ? 'below' : ''}`} role="tooltip"
      style={place === null ? { left: 0, top: 0, visibility: 'hidden' } : { left: place.left, top: place.top }}>
      {tip.text}
    </div>,
    document.body,
  )
}
