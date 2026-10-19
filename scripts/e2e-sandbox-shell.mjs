#!/usr/bin/env node
/**
 * The agent's sandboxed shell actually runs a command (no approval needed,
 * the default sandbox). On Windows this needs the host process to have a
 * console: a host started without one (the desktop app) made every
 * sandboxed command die with 0xC0000142.
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host        (or the desktop app)
 *   ADG_GATEWAY_TOKEN=dev-token node scripts/e2e-sandbox-shell.mjs
 */
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'
const COMMAND = process.platform === 'win32' ? '$PSVersionTable.PSVersion.ToString(); "sandbox-ok"' : 'echo sandbox-ok'
const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  replies: [{ toolCalls: [{ name: SHELL, arguments: { description: 'Check the shell', command: COMMAND } }] }],
  fallback: { text: '好的。' },
  scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
})
const gateway = await connectGateway({ name: 'adg-e2e-sandbox' })
const { call, waitFor } = gateway
try {
  await saveFakeProvider(call, `${llm.url}/v1`)
  const { sessionId } = await call('sessions/create', {})
  const opened = await call('session/open', { sessionId })
  for (let i = 0; ; i++) {
    try { await call('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }); break } catch (error) { if (i > 30) throw error; await new Promise(r => setTimeout(r, 300)) }
  }
  const result = waitFor(m => m.method === 'session/event' && m.params.subscriptionId === opened.subscriptionId && m.params.event.type === 'tool/result', 'tool/result', 120_000)
  // The fake route may need a moment before the session accepts it.
  for (let i = 0; ; i++) {
    try { await call('session/prompt', { sessionId, requestId: `e2e-sb-${Date.now()}`, text: '看看 shell 能不能用', mode: 'queue' }); break } catch (error) {
      if (i > 30 || !/model/i.test(error.message)) throw error
      await new Promise(r => setTimeout(r, 500))
      await call('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }).catch(() => {})
    }
  }
  const { event } = await result
  const output = (event.content ?? []).map(c => c.text ?? '').join('').trim()
  if (event.isError || !output.includes('sandbox-ok')) throw new Error(`the sandboxed shell failed: ${output.slice(0, 400)}`)
  console.log(`✔ the sandboxed ${SHELL} ran: ${output.replace(/\s+/g, ' ').slice(0, 120)}`)
} catch (error) {
  console.error(`✘ ${error.message}`)
  process.exitCode = 1
} finally {
  await removeFakeProvider(call)
  gateway.close()
  await llm.close()
}
