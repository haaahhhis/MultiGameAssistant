import { useSyncExternalStore } from 'react'
import { desktop } from './desktop.ts'

/** Light, dark, or whatever the OS prefers; kept per browser in localStorage. */
export type ThemePreference = 'system' | 'light' | 'dark'

const THEME_KEY = 'adg.theme'
const listeners = new Set<() => void>()
let current: ThemePreference = read()

function read(): ThemePreference {
  try {
    const value = localStorage.getItem(THEME_KEY)
    return value === 'light' || value === 'dark' ? value : 'system'
  } catch {
    return 'system'
  }
}

/** `system` leaves the attribute off, so the stylesheet's media query decides. */
export function applyTheme(): void {
  if (current === 'system') delete document.documentElement.dataset['theme']
  else document.documentElement.dataset['theme'] = current
  void desktop()?.setTheme?.(current).catch(() => {})
}

export function setTheme(theme: ThemePreference): void {
  current = theme
  try { localStorage.setItem(THEME_KEY, theme) } catch { /* storage unavailable */ }
  applyTheme()
  for (const listener of listeners) listener()
}

export function useTheme(): ThemePreference {
  return useSyncExternalStore(
    listener => { listeners.add(listener); return () => listeners.delete(listener) },
    () => current,
  )
}
