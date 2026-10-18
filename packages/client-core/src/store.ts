/**
 * Minimal observable value, shaped for React's `useSyncExternalStore` and
 * equally usable from Vue, Svelte, a TUI, or plain callbacks.
 *
 * Listener calls are coalesced into one microtask, so a burst of streamed
 * deltas produces one notification per tick rather than one per delta.
 */
export type Listener = () => void

export class Store<T> {
  #value: T
  #listeners = new Set<Listener>()
  #scheduled = false

  constructor(initial: T) {
    this.#value = initial
  }

  /** Current value; stable identity until the next `set`. */
  get = (): T => this.#value

  subscribe = (listener: Listener): (() => void) => {
    this.#listeners.add(listener)
    return () => {
      this.#listeners.delete(listener)
    }
  }

  set(next: T | ((previous: T) => T)): void {
    const value = typeof next === 'function' ? (next as (previous: T) => T)(this.#value) : next
    if (Object.is(value, this.#value)) return
    this.#value = value
    if (this.#scheduled) return
    this.#scheduled = true
    queueMicrotask(() => {
      this.#scheduled = false
      for (const listener of [...this.#listeners]) listener()
    })
  }
}
