import { useSyncExternalStore } from 'react'

/**
 * Whether agents show their 「以前的对话」 tab; kept per browser, like the theme.
 * Off until turned on (设置 → 对话压缩), even with earlier conversations there;
 * a new key, so the old 'adg.showEarlier' (on by default) no longer counts.
 */
const SHOW_EARLIER_KEY = 'adg.showEarlierTab'
const listeners = new Set<() => void>()

function readShowEarlier(): boolean {
  try { return localStorage.getItem(SHOW_EARLIER_KEY) === '1' } catch { return false }
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
