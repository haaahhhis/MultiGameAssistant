/**
 * How the agent reaches the built-in browser: dsh runs in a process of its
 * own, the browser in this one. A loopback HTTP endpoint with a random token,
 * handed to dsh as ADG_BROWSER_URL / ADG_BROWSER_TOKEN (packages/browser
 * calls it); nothing else learns the token, and only 127.0.0.1 listens.
 * One request per call: `POST /call` with `{ method, params }`, answered
 * `{ ok: true, result }` or `{ ok: false, error }`.
 */
import { createServer } from 'node:http'
import { randomBytes, timingSafeEqual } from 'node:crypto'

const MAX_BODY = 1024 * 1024

/**
 * @param {import('./browser.mjs').AgentBrowser} browser
 * @returns {Promise<{ url: string, token: string, close(): void }>}
 */
export async function startBrowserBridge(browser) {
  const token = randomBytes(24).toString('base64url')
  const expected = Buffer.from(`Bearer ${token}`)
  const methods = {
    navigate: p => browser.navigate(p),
    snapshot: p => browser.snapshot(p),
    click: p => browser.click(p),
    type: p => browser.type(p),
    press: p => browser.press(p),
    scroll: p => browser.scroll(p),
    text: p => browser.text(p),
    tabs: p => browser.tabs(p),
    screenshot: async p => {
      const shot = await browser.screenshot(p)
      return { ...shot, png: shot.png.toString('base64') }
    },
  }
  const server = createServer((request, response) => {
    const answer = (status, body) => {
      response.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      response.end(JSON.stringify(body))
    }
    const given = Buffer.from(request.headers.authorization ?? '')
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return answer(401, { ok: false, error: 'unauthorized' })
    if (request.method !== 'POST' || request.url !== '/call') return answer(404, { ok: false, error: 'not found' })
    const chunks = []
    let size = 0
    request.on('data', chunk => {
      size += chunk.length
      if (size > MAX_BODY) request.destroy()
      else chunks.push(chunk)
    })
    request.on('end', async () => {
      let call
      try {
        call = JSON.parse(Buffer.concat(chunks).toString('utf8'))
      } catch {
        return answer(400, { ok: false, error: 'bad request' })
      }
      const method = Object.hasOwn(methods, call?.method) ? methods[call.method] : undefined
      if (method === undefined) return answer(404, { ok: false, error: `no method ${String(call?.method)}` })
      try {
        answer(200, { ok: true, result: await method(typeof call.params === 'object' && call.params !== null ? call.params : {}) })
      } catch (error) {
        answer(200, { ok: false, error: error instanceof Error ? error.message : String(error) })
      }
    })
  })
  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(0, '127.0.0.1', () => resolve(undefined))
  })
  const { port } = /** @type {import('node:net').AddressInfo} */ (server.address())
  return { url: `http://127.0.0.1:${port}`, token, close: () => server.close() }
}
