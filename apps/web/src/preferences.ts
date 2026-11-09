import { useSyncExternalStore } from 'react'

/** Whether agents show their 「以前的对话」 tab; kept per browser, like the theme. */
const SHOW_EARLIER_KEY = 'adg.showEarlier'
const listeners = new Set<() => void>()

function readShowEarlier(): boolean {
  try { return localStorage.getItem(SHOW_EARLIER_KEY) !== '0' } catch { return true }
}

let showEarlier = readShowEarlier()

export function setShowEarlier(show: boolean): void {
  showEarlier = show
  try { localStorage.setItem(SHOW_EARLIER_KEY, show ? '1' : '0') } catch { /* storage unavailable: lasts until reload */ }
  for (const listener of listeners) listener()
}

export function useShowEarlier(): boolean {
  return useSyncExternalStore(listener => { listeners.add(listener); return () => { listeners.delete(listener) } }, () => showEarlier)
}
