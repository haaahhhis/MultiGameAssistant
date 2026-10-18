#!/usr/bin/env node
/**
 * End-to-end protocol check against a running gateway.
 *
 *   ADG_GATEWAY_TOKEN=dev-token node scripts/smoke.mjs [--prompt "text"]
 *
 * Verifies auth rejection, initialize, sessions/list|create, session/open,
 * models/catalog, and (with --prompt) one prompt with its streamed events.
 */
const port = process.env.ADG_GATEWAY_PORT ?? '3290'
const token = process.env.ADG_GATEWAY_TOKEN ?? 'dev-token'
const promptIndex = process.argv.indexOf('--prompt')
const promptText = promptIndex === -1 ? undefined : process.argv[promptIndex + 1]
const base = `ws://127.0.0.1:${port}/rpc`

function connect(url) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url)
    ws.addEventListener('open', () => resolve(ws), { once: true })
    ws.addEventListener('error', () => reject(new Error('connect failed')), { once: true })
  })
}

function client(ws) {
  let nextId = 1
  const pending = new Map()
  const notifications = []
  const listeners = new Set()
  ws.addEventListener('message', ({ data }) => {
    const message = JSON.parse(String(data))
    if ('id' in message && pending.has(message.id)) {
      const { resolve, reject } = pending.get(message.id)
      pending.delete(message.id)
      if ('error' in message) reject(Object.assign(new Error(message.error.message), message.error))
      else resolve(message.result)
    } else if ('method' in message) {
      notifications.push(message)
      for (const listener of listeners) listener(message)
    }
  })
  return {
    notifications,
    on: listener => listeners.add(listener),
    call(method, params = {}) {
      const id = nextId++
      ws.send(JSON.stringify({ jsonrpc: '2.0', id, method, params }))
      return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
    },
  }
}

const check = (label, ok, detail = '') => {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${detail ? `  — ${detail}` : ''}`)
  if (!ok) process.exitCode = 1
}

// 1. A wrong token must not open a socket.
try {
  const bad = await connect(`${base}?token=wrong`)
  bad.close()
  check('rejects a wrong token', false)
} catch {
  check('rejects a wrong token', true)
}

const ws = await connect(`${base}?token=${encodeURIComponent(token)}`)
const rpc = client(ws)

// 2. Calls before initialize are refused.
try {
  await rpc.call('sessions/list')
  check('requires initialize first', false)
} catch (error) {
  check('requires initialize first', error.code === -32002, error.message)
}

const init = await rpc.call('initialize', { protocolVersion: 1, client: { name: 'smoke', version: '0' } })
check('initialize', init.protocolVersion === 1, `capabilities: ${init.capabilities.map(c => `${c.id}@${c.version}`).join(', ')}`)

const before = await rpc.call('sessions/list')
check('sessions/list', Array.isArray(before.items), `${before.items.length} session(s)`)

const created = await rpc.call('sessions/create', {})
check('sessions/create', typeof created.sessionId === 'string', created.sessionId)

const opened = await rpc.call('session/open', { sessionId: created.sessionId })
check('session/open', typeof opened.subscriptionId === 'string',
  `cursor=${opened.cursor} events=${opened.events.length} hasMore=${opened.hasMore} cwd=${opened.header.cwd ?? '-'}`)

try {
  const catalog = await rpc.call('models/catalog')
  check('models/catalog', Array.isArray(catalog.groups),
    `default ${catalog.default.provider}/${catalog.default.model}; ${catalog.groups.length} group(s), ${catalog.failures.length} failure(s)`)
} catch (error) {
  check('models/catalog', false, `${error.message} ${JSON.stringify(error.data ?? {})}`)
}

try {
  await rpc.call('session/prompt', { sessionId: created.sessionId })
  check('rejects invalid params', false)
} catch (error) {
  check('rejects invalid params', error.code === -32602)
}

if (promptText !== undefined) {
  const done = new Promise(resolve => {
    rpc.on(message => {
      if (message.method === 'session/event' && message.params.event.type === 'turn/end') resolve(message.params.event)
    })
    setTimeout(() => resolve(null), 120_000)
  })
  try {
    await rpc.call('session/prompt', { sessionId: created.sessionId, requestId: crypto.randomUUID(), text: promptText, mode: 'queue' })
    check('session/prompt accepted', true)
  } catch (error) {
    check('session/prompt accepted', false, `${error.message} ${JSON.stringify(error.data ?? {})}`)
  }
  const end = await done
  const events = rpc.notifications.filter(n => n.method === 'session/event').map(n => n.params.event.type)
  const live = rpc.notifications.filter(n => n.method === 'session/live').length
  check('turn completed', end !== null, end === null ? 'timed out' : `reason=${JSON.stringify(end.reason)}; events: ${events.join(' ')}; live frames: ${live}`)
}

await rpc.call('session/close', { subscriptionId: opened.subscriptionId })
check('session/close', true)
const changed = rpc.notifications.filter(n => n.method === 'sessions/changed').length
console.log(`notifications received: ${rpc.notifications.length} (sessions/changed: ${changed})`)
ws.close()
