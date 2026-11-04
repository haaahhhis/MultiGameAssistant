import { useRef, type RefObject, type UIEvent, type WheelEvent } from 'react'

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
  readonly following: RefObject<boolean>
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
