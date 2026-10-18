/**
 * Minimal JSON-RPC client for development scripts talking to a running gateway.
 * (The real client is @adg/client-core; scripts stay dependency-free.)
 */
import { setTimeout as delay } from 'node:timers/promises'

export const FAKE_PROVIDER = 'adg-fake'
export const FAKE_MODEL = 'fake-vision'

/**
 * Connect and initialize.
 * @returns `{ call, waitFor, close, capabilities }`
 */
export async function connectGateway({
  port = process.env.ADG_GATEWAY_PORT ?? '3290',
  token = process.env.ADG_GATEWAY_TOKEN ?? 'dev-token',
  name = 'adg-script',
} = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/rpc?token=${encodeURIComponent(token)}`)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true })
    ws.addEventListener('error', () => reject(new Error(`cannot reach the gateway on port ${port}; is pnpm dev:host running?`)), { once: true })
  })

  let nextId = 1
  const pending = new Map()
  const waiters = []
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data))
    if ('id' in message && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if ('error' in message) reject(Object.assign(new Error(message.error.message), { data: message.error.data }))
      else resolve(message.result)
      return
    }
    if (!('method' in message)) return
    for (const waiter of [...waiters]) {
      if (!waiter.match(message)) continue
      waiters.splice(waiters.indexOf(waiter), 1)
      waiter.resolve(message.params)
    }
  })

  const call = (method, params) => new Promise((resolve, reject) => {
    const id = nextId++
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
  })
  /** Resolve with the params of the first notification `match` accepts. */
  const waitFor = (match, what, ms = 60_000) => Promise.race([
    new Promise(resolve => waiters.push({ match, resolve })),
    delay(ms).then(() => { throw new Error(`timed out waiting for ${what}`) }),
  ])

  const init = await call('initialize', { protocolVersion: 1, client: { name, version: '0' } })
  return { call, waitFor, close: () => ws.close(), capabilities: init.capabilities.map(c => c.id) }
}

/** Create or update the fake provider route pointing at `baseURL`. */
export async function saveFakeProvider(call, baseURL) {
  const route = { api: 'openai-completions', baseURL, models: [{ id: FAKE_MODEL, input: ['text', 'image'] }], apiKey: 'fake-key' }
  const current = await call('providers/list', {})
  const exists = current.providers.some(p => p.id === FAKE_PROVIDER)
  await call('providers/save', {
    id: FAKE_PROVIDER, create: !exists, displayName: 'ADG 模拟模型', ...route, expectedRevision: current.revision,
  })
}

/** Remove the fake provider route and its key, if present. */
export async function removeFakeProvider(call) {
  const current = await call('providers/list', {}).catch(() => undefined)
  if (current?.providers.some(p => p.id === FAKE_PROVIDER)) {
    await call('providers/remove', { id: FAKE_PROVIDER, removeKey: true, expectedRevision: current.revision }).catch(() => {})
  }
}
