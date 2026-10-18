/** Locale-neutral formatting for trajectory figures. */

/** `850 ms`, `4.2 s`, `3m 05s`, `1h 02m`. */
export function formatDuration(ms: number | undefined | null): string {
  if (ms === undefined || ms === null || !Number.isFinite(ms)) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 2 : 1)} s`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ${String(Math.floor(seconds % 60)).padStart(2, '0')}s`
  return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, '0')}m`
}

/** `987`, `12.3k`, `4.56M`. */
export function formatTokens(count: number | undefined | null): string {
  if (count === undefined || count === null) return '—'
  if (count < 1000) return String(count)
  if (count < 1_000_000) return `${(count / 1000).toFixed(count < 10_000 ? 2 : 1)}k`
  return `${(count / 1_000_000).toFixed(2)}M`
}

/** `HH:MM:SS.mmm` in local time. */
export function formatClock(epochMs: number): string {
  const d = new Date(epochMs)
  const pad = (n: number, w = 2) => String(n).padStart(w, '0')
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}.${pad(d.getMilliseconds(), 3)}`
}

/** Pretty-print a JSON string when it parses, else return it unchanged. */
export function prettyJson(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2)
  } catch {
    return text
  }
}
