/**
 * Where the gateway is. The UI is always served same-origin with the gateway
 * (by the gateway itself, by Electron loading the gateway URL, or through the
 * Vite dev proxy), so only the token varies. It arrives once as `?token=` and
 * is kept in sessionStorage, then removed from the address bar.
 */
const TOKEN_KEY = 'adg.token'

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

export function gatewayUrl(token: string): string {
  const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
  return `${scheme}://${location.host}/rpc?token=${encodeURIComponent(token)}`
}

/** What the main area shows; kept in the hash so a reload returns to it. */
export type Route =
  | { readonly kind: 'home' }
  | { readonly kind: 'session'; readonly id: string }
  | { readonly kind: 'settings'; readonly section?: string | undefined }
  | { readonly kind: 'page'; readonly id: string; readonly arg?: string | undefined }
  /** One session view alone, in a popped-out window. */
  | { readonly kind: 'window'; readonly view: string; readonly sessionId: string }

export function readRoute(): Route {
  if (location.hash === '#/settings') return { kind: 'settings' }
  const section = /^#\/settings\/(.+)$/.exec(location.hash)
  if (section !== null) return { kind: 'settings', section: decodeURIComponent(section[1]!) }
  const popped = /^#\/w\/([^/]+)\/(.+)$/.exec(location.hash)
  if (popped !== null) return { kind: 'window', view: decodeURIComponent(popped[1]!), sessionId: decodeURIComponent(popped[2]!) }
  const page = /^#\/p\/([^/]+)(?:\/(.+))?$/.exec(location.hash)
  if (page !== null) return { kind: 'page', id: decodeURIComponent(page[1]!), ...(page[2] === undefined ? {} : { arg: decodeURIComponent(page[2]) }) }
  const match = /^#\/s\/(.+)$/.exec(location.hash)
  return match === null ? { kind: 'home' } : { kind: 'session', id: decodeURIComponent(match[1]!) }
}

/**
 * Put the route in the address. A new page is a history entry, so the mouse's
 * back and forward buttons (and the browser's) move between pages; `replace`
 * for corrections nobody should go back to.
 */
export function writeRoute(route: Route, mode: 'push' | 'replace' = 'push'): void {
  const hash = route.kind === 'window' ? `#/w/${encodeURIComponent(route.view)}/${encodeURIComponent(route.sessionId)}`
    : route.kind === 'session' ? `#/s/${encodeURIComponent(route.id)}`
    : route.kind === 'page' ? `#/p/${encodeURIComponent(route.id)}${route.arg === undefined ? '' : `/${encodeURIComponent(route.arg)}`}`
      : route.kind === 'settings' ? (route.section === undefined ? '#/settings' : `#/settings/${encodeURIComponent(route.section)}`) : ''
  if (location.hash === hash) return
  const url = `${location.pathname}${location.search}${hash}`
  if (mode === 'replace') history.replaceState(history.state, '', url)
  else history.pushState(null, '', url)
}

/**
 * Address of a popped-out session view. The token rides along once, as on
 * first load, since a new window may not share this one's sessionStorage.
 */
export function popoutUrl(view: string, sessionId: string): string {
  const url = new URL(location.href)
  const token = readToken()
  if (token !== null) url.searchParams.set('token', token)
  url.hash = `#/w/${encodeURIComponent(view)}/${encodeURIComponent(sessionId)}`
  return url.href
}
