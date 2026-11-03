import { strict as assert } from 'node:assert'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { Context } from '@deepseek-ai/cordis'
import { serveMounted } from '../src/server.ts'
import { AgentParts, OwnSessions } from '../src/shared.ts'
import { SkillScope } from '../src/skill-scope.ts'

test("the app's own sessions are kept across starts", async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-own-')), 'own-sessions.json')
  const own = new OwnSessions(file)
  await own.loaded
  assert.equal(own.has('s1'), false)
  await own.add('s1')
  await own.add('s1')
  assert.equal(own.has('s1'), true)
  const again = new OwnSessions(file)
  await again.loaded
  assert.equal(again.has('s1'), true, 'read back after a restart')
  assert.equal(again.has('s2'), false, "another chat in the same dsh is not the app's")
})

test('agent parts reach every scope that attaches, now and later, and leave with their owner', () => {
  const warnings: string[] = []
  const parts = new AgentParts({ warn: message => warnings.push(message) })
  const held: string[] = []
  const scope = (name: string) => ({ name }) as unknown as Context
  const part = (label: string) => (s: Context) => {
    held.push(`${(s as unknown as { name: string }).name}+${label}`)
    return () => held.push(`${(s as unknown as { name: string }).name}-${label}`)
  }
  const removeTools = parts.add('tools', part('tools'))
  const detachA = parts.attach(scope('a'))
  assert.deepEqual(held, ['a+tools'], 'a scope gets the parts already there')
  parts.add('prompt', part('prompt'))
  assert.deepEqual(held, ['a+tools', 'a+prompt'], 'and the ones added later')
  parts.attach(scope('b'))
  assert.deepEqual(held.slice(2), ['b+tools', 'b+prompt'])
  removeTools()
  assert.deepEqual(held.slice(4), ['a-tools', 'b-tools'], "a part's owner going away takes it out of every scope")
  detachA()
  assert.ok(held.includes('a-prompt'), 'a scope going away disposes what it held')
  parts.add('broken', () => { throw new Error('no tools service') })
  assert.match(warnings.join('\n'), /broken not registered for the app's agents: no tools service/)
})

test("the tools the parts register are known as the app's own, apart from dsh's", () => {
  const parts = new AgentParts({ warn: () => {} })
  const names = new Set(['pwsh', 'read_file'])
  const scope = { tools: { schemas: () => [...names].map(name => ({ name })), register: (tool: { name: string }) => { names.add(tool.name); return () => names.delete(tool.name) } } } as unknown as Context
  parts.attach(scope)
  parts.add('runner', s => s.tools.register({ name: 'script_run' } as never))
  parts.add('prompt', () => () => {})
  assert.deepEqual([...parts.tools], ['script_run'], "dsh's own tools are not the app's")
})

test("a shared dsh's other chats see none of the app's skills", async () => {
  const scope = new SkillScope(undefined, { warn: () => {} })
  const provider = scope.provider(() => {})
  scope.register({ name: 'script-analysis', description: 'd', content: 'c', source: 'bundled' })
  scope.limitTo(sessionId => sessionId === 'app-chat')
  const names = async (sessionId?: string) => (await provider.list(sessionId === undefined ? {} : { scope: { session: { id: sessionId } } })).map(s => (s as { name: string }).name)
  assert.deepEqual(await names('app-chat'), ['script-analysis'])
  assert.deepEqual(await names('coding-chat'), [], 'another chat in the same dsh')
  assert.deepEqual(await names(), ['script-analysis'], 'lists without a session (the 技能 page) still show it')
})

test("the UI under dsh's web server: the bare mount redirects, files and the SPA fallback come from the UI folder", async () => {
  const ui = mkdtempSync(join(tmpdir(), 'adg-ui-'))
  writeFileSync(join(ui, 'index.html'), '<!doctype html>app')
  mkdirSync(join(ui, 'assets'))
  writeFileSync(join(ui, 'assets', 'app.js'), 'console.log(1)')
  const server: Server = createServer((req, res) => serveMounted(ui, req, res))
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  try {
    const bare = await fetch(`${base}/adg`, { redirect: 'manual' })
    assert.equal(bare.status, 308)
    assert.equal(bare.headers.get('location'), '/adg/')
    assert.equal(await (await fetch(`${base}/adg/`)).text(), '<!doctype html>app')
    const script = await fetch(`${base}/adg/assets/app.js`)
    assert.match(script.headers.get('content-type') ?? '', /javascript/)
    assert.equal(await (await fetch(`${base}/adg/settings/deep/link`)).text(), '<!doctype html>app', 'SPA fallback')
    assert.equal(await (await fetch(`${base}/adg/..%2f..%2fetc`)).text(), '<!doctype html>app', 'no way out of the folder')
    assert.equal((await fetch(`${base}/adg/`, { method: 'POST' })).status, 405)
  } finally {
    server.close()
  }
})
