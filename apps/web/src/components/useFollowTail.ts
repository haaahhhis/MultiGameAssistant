import { useLayoutEffect, useRef, type RefObject, type UIEvent, type WheelEvent } from 'react'

/**
 * Keeps a scrolling list at its bottom while it follows the tail, whatever
 * changes its size after it was put there: an image that loaded, a card that
 * fetched its details, the composer growing under it. Resize observers report
 * before the frame is painted, so the view never shows the older part first.
 * Growth right after a click or key in the list is the person opening
 * something to read: that stops following instead, so it stays in view.
 * Watches the list and its direct children (the content wrapper).
 */
export function useStayAtBottom(scroller: RefObject<HTMLElement | null>, following: { current: boolean }): void {
  useLayoutEffect(() => {
    const el = scroller.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    let input = -Infinity
    const touched = () => { input = performance.now() }
    const observer = new ResizeObserver(() => {
      // Already there: new messages were put at the bottom as they rendered.
      if (!following.current || el.scrollHeight - el.scrollTop - el.clientHeight <= 2) return
      if (performance.now() - input < OWN_CHANGE_MS) following.current = false
      else el.scrollTop = el.scrollHeight
    })
    observer.observe(el)
    for (const child of el.children) observer.observe(child)
    el.addEventListener('pointerdown', touched, true)
    el.addEventListener('keydown', touched, true)
    return () => {
      observer.disconnect()
      el.removeEventListener('pointerdown', touched, true)
      el.removeEventListener('keydown', touched, true)
    }
  }, [scroller, following])
}

/** How soon after a click or key a change in size counts as the person's own. */
const OWN_CHANGE_MS = 400

/**
 * Following the newest output at the bottom of a scrolling list while it
 * grows (a reply streaming in). Any move up — the wheel, the scrollbar, keys,
 * a touchpad, however small — stops following at once, so new output never
 * pulls the view back down while you read; following starts again when you
 * come back to the bottom.
 * @param threshold - how close to the bottom, scrolling down, counts as back.
 */
export function useFollowTail(threshold: number): {
  /** Whether to keep the view at the bottom as output arrives. */
  readonly following: { current: boolean }
  readonly onScroll: (event: UIEvent<HTMLElement>) => void
  readonly onWheel: (event: WheelEvent<HTMLElement>) => void
} {
  const following = useRef(true)
  const lastTop = useRef(0)
  return {
    following,
    onScroll: event => {
      const el = event.currentTarget
      const distance = el.scrollHeight - el.scrollTop - el.clientHeight
      const up = el.scrollTop < lastTop.current - 1
      lastTop.current = el.scrollTop
      // At the very bottom (also when the content got shorter under it): follow.
      if (distance <= 2) following.current = true
      else if (up) following.current = false
      else if (distance < threshold) following.current = true
    },
    // The wheel says "up" before the scroll lands, and output may arrive in between.
    onWheel: event => { if (event.deltaY < 0) following.current = false },
  }
}
