import { strict as assert } from 'node:assert'
import { createServer } from 'node:http'
import { test } from 'node:test'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import { BROWSER_TOOLS, browserClient, browserTools, renderPage, type BrowserCall } from '../src/index.ts'

const page = { tab: 't1', url: 'https://example.com/', title: '例子', snapshot: '- button "好" [ref=e1]\n' }

function setup(answer: (method: string, params: Record<string, unknown>) => unknown = () => page) {
  const calls: { method: string; params: Record<string, unknown> }[] = []
  const call: BrowserCall = async (method, params) => { calls.push({ method, params }); return answer(method, params) }
  let saved = 0
  let vision = true
  const tools = browserTools({
    call,
    saveImage: async () => { saved += 1; return { id: 'img-1' } },
    checkVision: async () => { if (!vision) throw new Error('不能看图片') },
  })
  const exec = { signal: new AbortController().signal, agent: { session: { id: 'session-1' } } } as unknown as ToolRunContext
  const run = (name: string, args: unknown) => tools.find(t => t.name === name)!.execute(args, exec) as Promise<any>
  const render = (name: string, value: unknown) => tools.find(t => t.name === name)!.output.render({}, value as never)
  return { calls, run, render, tools, saved: () => saved, blind: () => { vision = false } }
}

test('every tool names the session, so each conversation works in its own tab', async () => {
  const { calls, run } = setup()
  await run(BROWSER_TOOLS.navigate, { url: 'example.com', new_tab: null })
  await run(BROWSER_TOOLS.click, { ref: 'e1', x: null, y: null })
  await run(BROWSER_TOOLS.type, { ref: 'e2', text: '原神', submit: true })
  await run(BROWSER_TOOLS.press, { key: 'Enter' })
  assert.deepEqual(calls, [
    { method: 'navigate', params: { url: 'example.com', session: 'session-1' } },
    { method: 'click', params: { ref: 'e1', session: 'session-1' } },
    { method: 'type', params: { ref: 'e2', text: '原神', submit: true, session: 'session-1' } },
    { method: 'press', params: { key: 'Enter', session: 'session-1' } },
  ])
})

test('navigate needs an address or an action; tabs select needs a tab', async () => {
  const { run } = setup()
  await assert.rejects(run(BROWSER_TOOLS.navigate, {}), /url，或 action/)
  await assert.rejects(run(BROWSER_TOOLS.tabs, { action: 'select' }), /要给 tab/)
})

test('a page reads as its tab, title, address and content', () => {
  const { render } = setup()
  const [block] = render(BROWSER_TOOLS.click, page) as { type: string; text: string }[]
  assert.equal(block!.text, renderPage(page))
  assert.match(block!.text, /^标签页 t1：例子\nhttps:\/\/example.com\/\n\n- button "好" \[ref=e1\]/)
})

test('a screenshot goes to the model as an image, and only for a model that sees', async () => {
  const { run, render, saved, blind } = setup(() => ({ tab: 't1', url: 'u', title: 't', width: 800, height: 600, png: Buffer.from('png').toString('base64') }))
  const shot = await run(BROWSER_TOOLS.screenshot, {})
  assert.equal(saved(), 1)
  const blocks = render(BROWSER_TOOLS.screenshot, shot) as { type: string }[]
  assert.deepEqual(blocks.map(b => b.type), ['text', 'image'])
  blind()
  await assert.rejects(run(BROWSER_TOOLS.screenshot, {}), /不能看图片/)
})

test('the client sends the token, and passes the bridge\'s refusal on as the error', async () => {
  const seen: { auth?: string; body: unknown }[] = []
  const server = createServer((request, response) => {
    let body = ''
    request.on('data', chunk => { body += chunk })
    request.on('end', () => {
      const parsed = JSON.parse(body) as { method: string }
      seen.push({ auth: request.headers.authorization, body: parsed })
      response.end(JSON.stringify(parsed.method === 'snapshot' ? { ok: true, result: page } : { ok: false, error: '没有 e9：先用 browser_snapshot' }))
    })
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const port = (server.address() as { port: number }).port
    const call = browserClient({ url: `http://127.0.0.1:${port}`, token: 'secret' })
    assert.deepEqual(await call('snapshot', { session: 's' }), page)
    await assert.rejects(call('click', { ref: 'e9' }), /没有 e9/)
    assert.equal(seen[0]!.auth, 'Bearer secret')
    assert.deepEqual(seen[0]!.body, { method: 'snapshot', params: { session: 's' } })
    const closed = browserClient({ url: 'http://127.0.0.1:1', token: 'x' })
    await assert.rejects(closed('snapshot', {}), /连不上内置浏览器/)
  } finally {
    server.close()
  }
})
