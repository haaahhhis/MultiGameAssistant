/**
 * The desktop app's browser bridge (apps/desktop/browser-bridge.mjs): one
 * `POST /call` per operation, with the token the app handed dsh.
 */

export interface BrowserEndpoint {
  readonly url: string
  readonly token: string
}

/** What every page action answers: where the page is and what it shows. */
export interface PageView {
  readonly tab: string
  readonly url: string
  readonly title: string
  readonly loading?: boolean
  readonly snapshot: string
}

export interface Shot {
  readonly tab: string
  readonly url: string
  readonly title: string
  readonly width: number
  readonly height: number
  /** Base64 PNG. */
  readonly png: string
}

export type BrowserCall = (method: string, params: Record<string, unknown>, signal?: AbortSignal) => Promise<unknown>

/** The longest one operation may take (a slow page loading, then reading it). */
const CALL_TIMEOUT_MS = 60_000

export function browserClient(endpoint: BrowserEndpoint, fetchImpl: typeof fetch = fetch): BrowserCall {
  return async (method, params, signal) => {
    let response: Response
    try {
      response = await fetchImpl(`${endpoint.url}/call`, {
        method: 'POST',
        headers: { authorization: `Bearer ${endpoint.token}`, 'content-type': 'application/json' },
        body: JSON.stringify({ method, params }),
        signal: signal === undefined ? AbortSignal.timeout(CALL_TIMEOUT_MS) : AbortSignal.any([signal, AbortSignal.timeout(CALL_TIMEOUT_MS)]),
      })
    } catch (error) {
      if (signal?.aborted === true) throw error
      throw new Error(`连不上内置浏览器（多游戏助手的桌面程序）：${error instanceof Error ? error.message : String(error)}`)
    }
    const body = await response.json().catch(() => undefined) as { ok?: boolean; result?: unknown; error?: string } | undefined
    if (body?.ok === true) return body.result
    throw new Error(body?.error ?? `内置浏览器没有回答（HTTP ${response.status}）`)
  }
}
