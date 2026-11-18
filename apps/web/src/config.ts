/**
 * Where the gateway is. The UI is always served same-origin with the gateway
 * (by the gateway itself, by Electron loading the gateway URL, or through the
 * Vite dev proxy), so only the token varies. It arrives once as `?token=` and
 * is kept in sessionStorage, then removed from the address bar.
 *
 * The dsh plugin also serves it under dsh's own web server at `/adg/`
 * (`MOUNTED`): dsh's login covers the page and the socket, so there is no
 * token. Inside dsh desktop the page's own address is `dsh-app://app`, which
 * has no socket; dsh's page names where its streams go
 * (`__DSH_TRANSPORT__.streamBaseUrl`), and this page, shown in a frame of it,
 * uses the same.
 */
const TOKEN_KEY = 'adg.token'

/** Served under dsh's web server (the dsh plugin's sidebar entry), not by the gateway's own port. */
export const MOUNTED = /^\/adg(\/|$)/.test(location.pathname)

/** dsh's stream address, when this page is in (or is) a dsh page that names one. */
function dshStreamBase(): string | undefined {
  for (const candidate of [window, window.parent]) {
    try {
      const base = (candidate as { __DSH_TRANSPORT__?: { streamBaseUrl?: unknown } }).__DSH_TRANSPORT__?.streamBaseUrl
      if (typeof base === 'string' && base !== '') return base
    } catch {
      // another origin's frame
    }
  }
  return undefined
}

export function readToken(): string | null {
  const url = new URL(location.href)
  const fromUrl = url.searchParams.get('token')
  if (fromUrl !== null && fromUrl !== '') {
    try { sessionStorage.setItem(TOKEN_KEY, fromUrl) } catch { /* private mode */ }
    url.searchParams.delete('token')
    history.replaceState(history.state, '', url)
    return fromUrl
  }
  try { return sessionStorage.getItem(TOKEN_KEY) } catch { return null }
}

export function saveToken(token: string): void {
  try { sessionStorage.setItem(TOKEN_KEY, token) } catch { /* private mode */ }
}

export function gatewayUrl(token: string | null): string {
  if (MOUNTED) {
    const base = new URL(dshStreamBase() ?? location.origin)
    return `${base.protocol === 'https:' ? 'wss' : 'ws'}://${base.host}/adg/rpc`
  }
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/rpc?token=${encodeURIComponent(token ?? '')}`
}

/** What the main area shows; kept in the hash so a reload returns to it. */
export type Route =
  /** Just opened (no address): the games page when there is one, else the chat home. */
  | { readonly kind: 'start' }
  | { readonly kind: 'home' }
  | { readonly kind: 'session'; readonly id: string }
  /** An agent: its one conversation, or its earlier conversations. Its other tabs are pages it owns (`page`). */
  | { readonly kind: 'agent'; readonly id: string; readonly tab?: AgentTab | undefined }
  /** What two agents said to each other (Delegation.tsx HandOffPage). */
  | { readonly kind: 'handoff'; readonly id: string }
  /**
   * Every agent's timed tasks, reminders and the pipelines on a timetable, together: the one place they
   * are made and changed. `focus`: one timed task or reminder to show (an agent's link to what it just
   * set); `agent`: show only that agent's at first (an old `#/a/<agent>/schedule` link).
   */
  | { readonly kind: 'schedule'; readonly focus?: string | undefined; readonly agent?: string | undefined }
  | { readonly kind: 'settings'; readonly section?: string | undefined }
  | { readonly kind: 'page'; readonly id: string; readonly arg?: string | undefined }

/** An agent's own tabs besides its conversation (App.tsx AgentTabs). */
export type AgentTab = 'history'

export function readRoute(): Route {
  if (location.hash === '#/settings') return { kind: 'settings' }
  const section = /^#\/settings\/(.+)$/.exec(location.hash)
  if (section !== null) return { kind: 'settings', section: decodeURIComponent(section[1]!) }
  // The daily report was a tab of the game board; it is the 游戏 agent's 日报 page now.
  if (location.hash === '#/p/games/report') return { kind: 'page', id: 'daily-report' }
  const page = /^#\/p\/([^/]+)(?:\/(.+))?$/.exec(location.hash)
  if (page !== null) return { kind: 'page', id: decodeURIComponent(page[1]!), ...(page[2] === undefined ? {} : { arg: decodeURIComponent(page[2]) }) }
  if (location.hash === '#/chat') return { kind: 'home' }
  if (location.hash === '#/schedule') return { kind: 'schedule' }
  const focus = /^#\/schedule\/(.+)$/.exec(location.hash)
  if (focus !== null) return { kind: 'schedule', focus: decodeURIComponent(focus[1]!) }
  // Agents had a 定时 tab each; their timed tasks are all on 定时 now.
  const ownSchedule = /^#\/a\/(.+)\/schedule$/.exec(location.hash)
  if (ownSchedule !== null) return { kind: 'schedule', agent: decodeURIComponent(ownSchedule[1]!) }
  const handOff = /^#\/h\/(.+)$/.exec(location.hash)
  if (handOff !== null) return { kind: 'handoff', id: decodeURIComponent(handOff[1]!) }
  const tab = /^#\/a\/(.+)\/(history)$/.exec(location.hash)
  if (tab !== null) return { kind: 'agent', id: decodeURIComponent(tab[1]!), tab: tab[2] as AgentTab }
  const agent = /^#\/a\/(.+)$/.exec(location.hash)
  if (agent !== null) return { kind: 'agent', id: decodeURIComponent(agent[1]!) }
  const match = /^#\/s\/(.+)$/.exec(location.hash)
  return match === null ? { kind: 'start' } : { kind: 'session', id: decodeURIComponent(match[1]!) }
}

/**
 * Put the route in the address. A new page is a history entry, so the mouse's
 * back and forward buttons (and the browser's) move between pages; `replace`
 * for corrections nobody should go back to.
 */
export function writeRoute(route: Route, mode: 'push' | 'replace' = 'push'): void {
  const hash = route.kind === 'session' ? `#/s/${encodeURIComponent(route.id)}`
    : route.kind === 'agent' ? `#/a/${encodeURIComponent(route.id)}${route.tab === undefined ? '' : `/${route.tab}`}`
    : route.kind === 'handoff' ? `#/h/${encodeURIComponent(route.id)}`
    : route.kind === 'schedule' ? (route.focus === undefined ? '#/schedule' : `#/schedule/${encodeURIComponent(route.focus)}`)
    : route.kind === 'page' ? `#/p/${encodeURIComponent(route.id)}${route.arg === undefined ? '' : `/${encodeURIComponent(route.arg)}`}`
      : route.kind === 'settings' ? (route.section === undefined ? '#/settings' : `#/settings/${encodeURIComponent(route.section)}`)
        : route.kind === 'home' ? '#/chat' : ''
  if (location.hash === hash) return
  const url = `${location.pathname}${location.search}${hash}`
  if (mode === 'replace') history.replaceState(history.state, '', url)
  else history.pushState(null, '', url)
}
