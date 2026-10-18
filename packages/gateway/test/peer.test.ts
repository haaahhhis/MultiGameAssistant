import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { ErrorCode } from '@adg/protocol'
import { ApprovalBroker } from '../src/approvals.ts'
import { CANCEL_REQUEST, Peer } from '../src/peer.ts'
import { CapabilityRegistry } from '../src/registry.ts'

function harness(registry = new CapabilityRegistry()) {
  const sent: any[] = []
  const peer = new Peer({ send: text => sent.push(JSON.parse(text)), close() {} }, {
    registry,
    validateResults: false,
    log: { warn() {} },
    onInitialized() {},
  })
  const settle = () => new Promise(resolve => setTimeout(resolve, 0))
  return { peer, sent, settle, registry }
}

const init = { protocolVersion: 1, client: { name: 'test', version: '0' } }

function withInitialize(registry: CapabilityRegistry) {
  registry.register({
    id: '$core', version: 1,
    methods: { initialize: () => ({ protocolVersion: 1, server: { name: 's', version: '0' }, capabilities: registry.list() }) },
  })
  return registry
}

test('requests before initialize are rejected', async () => {
  const { peer, sent, settle } = harness(withInitialize(new CapabilityRegistry()))
  peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'sessions/list', params: {} }))
  await settle()
  assert.equal(sent[0].error.code, ErrorCode.NotInitialized)
})

test('params are validated against the protocol schema', async () => {
  const registry = withInitialize(new CapabilityRegistry())
  registry.register({ id: 'chat', version: 1, methods: { 'session/prompt': () => ({ accepted: true }) } })
  const { peer, sent, settle } = harness(registry)
  peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init }))
  await settle()
  peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'session/prompt', params: { sessionId: 's' } }))
  await settle()
  assert.equal(sent[1].error.code, ErrorCode.InvalidParams)
})

test('unknown methods and malformed frames get JSON-RPC errors', async () => {
  const { peer, sent, settle } = harness(withInitialize(new CapabilityRegistry()))
  peer.receive('not json')
  peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init }))
  await settle()
  peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'nope' }))
  await settle()
  assert.equal(sent[0].error.code, ErrorCode.ParseError)
  assert.equal(sent[2].error.code, ErrorCode.MethodNotFound)
})

test('$/cancelRequest aborts the in-flight handler', async () => {
  const registry = withInitialize(new CapabilityRegistry())
  let aborted = false
  registry.register({
    id: 'slow', version: 1,
    methods: {
      'slow/wait': (_params, call) => new Promise((_resolve, reject) => {
        call.signal.addEventListener('abort', () => { aborted = true; reject(new Error('aborted')) })
      }),
    },
  })
  const { peer, sent, settle } = harness(registry)
  peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init }))
  await settle()
  peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'slow/wait' }))
  peer.receive(JSON.stringify({ jsonrpc: '2.0', method: CANCEL_REQUEST, params: { id: 7 } }))
  await settle()
  assert.equal(aborted, true)
  assert.equal(sent.at(-1).id, 7)
  assert.equal(sent.at(-1).error.code, ErrorCode.InternalError)
})

test('afterResponse tasks run after the response is written', async () => {
  const registry = withInitialize(new CapabilityRegistry())
  registry.register({
    id: 'x', version: 1,
    methods: { 'x/open': (_p, call) => { call.afterResponse(() => call.peer.notify('session/closed', { subscriptionId: 's', reason: 'r' })); return { ok: 1 } } },
  })
  const { peer, sent, settle } = harness(registry)
  peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: init }))
  await settle()
  peer.receive(JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'x/open' }))
  await settle()
  assert.deepEqual(sent.slice(1).map(f => f.id ?? f.method), [2, 'session/closed'])
})

test('registry rejects duplicate methods and unregisters cleanly', () => {
  const registry = new CapabilityRegistry()
  const dispose = registry.register({ id: 'a', version: 1, methods: { 'a/x': () => 1 } })
  assert.throws(() => registry.register({ id: 'b', version: 1, methods: { 'a/x': () => 2 } }))
  dispose()
  assert.equal(registry.method('a/x'), undefined)
  assert.deepEqual(registry.list(), [])
})

test('approval broker: first answer wins, abort withdraws', async () => {
  const resolved: [string, string][] = []
  const broker = new ApprovalBroker({ broadcastRequested() {}, broadcastResolved: (id, outcome) => resolved.push([id, outcome]) })
  const pending = broker.ask({ sessionId: 's', toolName: 'bash' })
  const [request] = broker.open()
  assert.ok(request)
  assert.equal(broker.respond(request.approvalId, 'allow-once'), true)
  assert.equal(broker.respond(request.approvalId, 'reject'), false)
  assert.equal(await pending, 'allowed-once')

  const controller = new AbortController()
  const withdrawn = broker.ask({ sessionId: 's', toolName: 'bash', signal: controller.signal })
  controller.abort()
  assert.equal(await withdrawn, 'cancelled')
  assert.deepEqual(resolved.map(r => r[1]), ['allowed-once', 'cancelled'])
})
