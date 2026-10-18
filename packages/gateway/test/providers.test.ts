import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { deriveKeyRef, providersCapability, toProviderModel, type ProvidersDeps } from '../src/providers.ts'
import type { MethodContext } from '../src/registry.ts'

type Ops = { op: 'set' | 'unset'; path: readonly string[]; value?: unknown }[]

/** In-memory stand-ins for the host's settings, LLM registry and credential services. */
function fakeHost(initial: Record<string, unknown> = {}, active: readonly string[] = []) {
  let user: Record<string, unknown> = structuredClone({ providers: initial })
  let revision = 1
  const writes: Ops[] = []
  const stored = new Map<string, string>()
  const unset: string[] = []
  const discoverCalls: unknown[] = []
  let changed = 0

  const setPath = (root: Record<string, unknown>, path: readonly string[], value: unknown) => {
    let node = root
    for (const key of path.slice(0, -1)) node = (node[key] ??= {}) as Record<string, unknown>
    if (value === undefined) delete node[path.at(-1)!]
    else node[path.at(-1)!] = structuredClone(value)
  }

  const deps: ProvidersDeps = {
    namespace: 'llm-pi-ai',
    settings: {
      writable: true,
      describe: () => [{ ns: 'llm-pi-ai', autoGenerate: false, schema: {}, value: structuredClone(user), user: structuredClone(user), revision, applies: 'live' }],
      mutate: async (_ns, ops, expected) => {
        if (expected !== undefined && expected !== revision) throw Object.assign(new Error('stale'), { code: 'SETTINGS_CONFLICT' })
        writes.push(ops as Ops)
        for (const op of ops) setPath(user, op.path, op.op === 'set' ? op.value : undefined)
        revision += 1
      },
    } as ProvidersDeps['settings'],
    llm: {
      listConfigurableProviders: () => [
        { provider: 'openai', displayName: 'OpenAI', settingsNs: 'llm-pi-ai', settingsPath: ['providers', 'openai'], declared: false },
        ...Object.keys((user.providers ?? {}) as object).map(provider => ({
          provider, displayName: provider, settingsNs: 'llm-pi-ai', settingsPath: ['providers', provider], declared: true,
        })),
      ],
      listProviders: () => [{ id: 'deepseek-official', name: 'DeepSeek' }, ...active.map(id => ({ id, name: id }))],
      discoverModels: async (_ns, request) => {
        discoverCalls.push(request)
        return [{ id: 'm1', name: 'm1', contextWindow: 128000, inputModalities: ['text', 'image'] }, { id: 'm2' }]
      },
    } as unknown as ProvidersDeps['llm'],
    credentials: () => ({
      describe: async (refs: string[]) => Object.fromEntries(refs.map(ref => [ref, { configured: stored.has(ref), writable: true, ...(stored.has(ref) ? { source: 'file' } : {}) }])),
      set: async (ref: string, value: string) => { stored.set(ref, value) },
      unset: async (ref: string) => { unset.push(ref); stored.delete(ref) },
    }) as never,
    changed: () => { changed += 1 },
    defaultModel: () => defaultModel,
  }
  let defaultModel: ReturnType<NonNullable<ProvidersDeps['defaultModel']>>
  const capability = providersCapability(deps)
  const call = (method: string, params: unknown) =>
    capability.methods[method]!(params, { signal: new AbortController().signal } as MethodContext) as Promise<any>
  return {
    call, writes, stored, unset, discoverCalls, user: () => user, changed: () => changed,
    setDefault: (value: typeof defaultModel) => { defaultModel = value },
  }
}

const draft = {
  id: 'acme',
  create: true,
  displayName: 'Acme',
  api: 'openai-completions',
  baseURL: 'https://gw.example/v1',
  models: [{ id: 'm1', contextWindow: 128000 }],
}

test('key reference derivation matches the official page', () => {
  assert.equal(deriveKeyRef('acme-gateway'), 'ACME_GATEWAY_API_KEY')
  assert.equal(deriveKeyRef('a1'), 'A1_API_KEY')
})

test('create writes one whole profile, then stores the key under its reference', async () => {
  const host = fakeHost()
  const result = await host.call('providers/save', { ...draft, apiKey: '  sk-test  ', expectedRevision: 1 })
  assert.deepEqual(host.writes, [[{
    op: 'set',
    path: ['providers', 'acme'],
    value: { displayName: 'Acme', apiKeyEnv: 'ACME_API_KEY', api: 'openai-completions', baseURL: 'https://gw.example/v1', models: [{ id: 'm1', contextWindow: 128000 }] },
  }]])
  assert.equal(host.stored.get('ACME_API_KEY'), 'sk-test')
  assert.deepEqual(result, { revision: 2, apiKeyRef: 'ACME_API_KEY' })
  assert.equal(host.changed(), 1)
})

test('a keyless route names no credential reference', async () => {
  const host = fakeHost()
  await host.call('providers/save', draft)
  assert.equal((host.user().providers as any).acme.apiKeyEnv, undefined)
})

test('create refuses an id already in use, including shipped providers', async () => {
  const host = fakeHost()
  await assert.rejects(host.call('providers/save', { ...draft, id: 'openai' }), /already in use/)
  await assert.rejects(host.call('providers/save', { ...draft, id: 'deepseek-official' }), /already in use/)
  assert.equal(host.writes.length, 0)
})

test('edit sets fields one by one so unshown settings survive', async () => {
  const host = fakeHost({ acme: { api: 'openai-completions', baseURL: 'https://old/v1', headers: { 'X-Team': 'a' }, models: [{ id: 'old' }] } })
  await host.call('providers/save', { ...draft, create: false, displayName: '', api: 'anthropic-messages', apiKey: 'sk-new' })
  const acme = (host.user().providers as any).acme
  assert.deepEqual(acme.headers, { 'X-Team': 'a' })
  assert.equal(acme.api, 'anthropic-messages')
  assert.equal(acme.apiKeyEnv, 'ACME_API_KEY')
  assert.deepEqual(acme.models, [{ id: 'm1', contextWindow: 128000 }])
  assert.equal(host.stored.get('ACME_API_KEY'), 'sk-new')
})

test('a stale revision is refused by the settings service', async () => {
  const host = fakeHost()
  await assert.rejects(host.call('providers/save', { ...draft, expectedRevision: 7 }), (e: { code?: string }) => e.code === 'SETTINGS_CONFLICT')
})

test('list reports user routes with key state, registration and directory facts', async () => {
  const host = fakeHost({ acme: { displayName: 'Acme', api: 'openai-completions', baseURL: 'https://gw/v1', apiKeyEnv: 'ACME_API_KEY', models: [{ id: 'm1' }, { bogus: true }] }, idle: { api: 'anthropic-messages', baseURL: 'https://a', models: [] } }, ['acme'])
  host.stored.set('ACME_API_KEY', 'x')
  const list = await host.call('providers/list', {})
  assert.deepEqual(list.providers.map((p: any) => [p.id, p.active, p.credential?.configured, p.models.length]), [['acme', true, true, 1], ['idle', false, undefined, 0]])
  assert.deepEqual(list.protocols, ['openai-completions', 'openai-responses', 'anthropic-messages'])
  assert.ok(list.taken.includes('openai') && list.taken.includes('acme'))
  assert.equal(JSON.stringify(list).includes('"x"'), false, 'never returns a key')
})

test('remove deletes the route and its key unless another route reads it', async () => {
  const host = fakeHost({
    a: { apiKeyEnv: 'SHARED_API_KEY', api: 'openai-completions', baseURL: 'https://a', models: [{ id: 'x' }] },
    b: { apiKeyEnv: 'SHARED_API_KEY', api: 'openai-completions', baseURL: 'https://b', models: [{ id: 'y' }] },
    c: { apiKeyEnv: 'C_API_KEY', api: 'openai-completions', baseURL: 'https://c', models: [{ id: 'z' }] },
  })
  await host.call('providers/remove', { id: 'a', removeKey: true })
  await host.call('providers/remove', { id: 'c', removeKey: true })
  assert.deepEqual(Object.keys(host.user().providers as object), ['b'])
  assert.deepEqual(host.unset, ['C_API_KEY'])
})

test('discover forwards the draft and normalizes candidates', async () => {
  const host = fakeHost()
  const { models } = await host.call('providers/discover', { api: 'openai-completions', baseURL: 'https://gw/v1', apiKey: ' sk ' })
  assert.deepEqual(host.discoverCalls, [{ api: 'openai-completions', baseURL: 'https://gw/v1', apiKey: 'sk' }])
  assert.deepEqual(models, [{ id: 'm1', contextWindow: 128000, input: ['text', 'image'] }, { id: 'm2' }])
  assert.equal(toProviderModel({ name: 'no id' }), undefined)
})

test('removing the route the default model points at resets the default', async () => {
  const host = fakeHost({ a: { api: 'openai-completions', baseURL: 'https://a', models: [{ id: 'x' }] }, b: { api: 'openai-completions', baseURL: 'https://b', models: [{ id: 'y' }] } })
  const resets: string[] = []
  host.setDefault({ provider: 'a', reset: async () => { resets.push('a') } })
  assert.equal((await host.call('providers/remove', { id: 'b' })).defaultReset, false)
  assert.equal((await host.call('providers/remove', { id: 'a' })).defaultReset, true)
  assert.deepEqual(resets, ['a'])
})
