#!/usr/bin/env node
/**
 * End-to-end chat + approval check against a running gateway, with no API key:
 * starts the test-kit fake model, registers it as a custom provider, opens a
 * session, sends one prompt, approves the tool call the fake model asks for,
 * and waits for the final answer. The fake provider is removed afterwards.
 *
 *   pnpm build && pnpm dev:home
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host        # in another terminal
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e
 */
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const FINAL = '已完成：命令输出 hi。'
// The shell tool dsh mounts: pwsh on Windows, bash elsewhere.
const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  replies: [{
    toolCalls: [{
      name: SHELL,
      arguments: {
        description: 'Print hi',
        command: 'echo hi',
        sandbox_permissions: 'danger-full-access',
        justification: 'e2e check: ask the user once before running',
      },
    }],
  }],
  fallback: { text: FINAL },
  // Only agent-loop requests offer tools; the session-title request must not take the tool call.
  scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
})
const gateway = await connectGateway({ name: 'adg-e2e' })
const { call, waitFor } = gateway

const steps = []
const step = (name, detail = '') => {
  steps.push(name)
  console.log(`✔ ${name}${detail === '' ? '' : `: ${detail}`}`)
}

try {
  step('initialize', gateway.capabilities.join(', '))
  await saveFakeProvider(call, `${llm.url}/v1`)
  step('register fake provider', `${llm.url}/v1`)

  const { sessionId } = await call('sessions/create', {})
  step('create session', sessionId)
  const opened = await call('session/open', { sessionId })

  let selected
  for (let attempt = 0; selected === undefined; attempt++) {
    selected = await call('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }).catch(async error => {
      if (attempt >= 19) throw error
      await delay(250) // the route registers asynchronously after saving
      return undefined
    })
  }
  step('select model', `${selected.selected.provider}/${selected.selected.model}`)

  const ofSession = type => m => m.method === 'session/event' && m.params.subscriptionId === opened.subscriptionId && m.params.event.type === type
  const approval = waitFor(m => m.method === 'approval/requested' && m.params.sessionId === sessionId, 'approval/requested')
  const toolResult = waitFor(ofSession('tool/result'), 'the tool result', 90_000)
  const answered = waitFor(m => ofSession('assistant/message')(m) && JSON.stringify(m.params.event).includes(FINAL), 'the final assistant message', 90_000)
  await call('session/prompt', { sessionId, requestId: `e2e-${Date.now()}`, text: '运行 echo hi', mode: 'queue' })
  step('send prompt')

  const request = await approval
  step('approval requested', `${request.toolName}${request.reason === undefined ? '' : ` (${request.reason})`}`)
  await call('approval/respond', { approvalId: request.approvalId, decision: 'allow-once' })
  step('approve once')

  const result = await toolResult
  const output = result.event.content?.map(c => c.text ?? '').join('').trim()
  if (result.event.isError || output !== 'hi') throw new Error(`unexpected tool result: ${JSON.stringify(result.event)}`)
  step('tool ran', output)

  await answered
  step('final answer received', FINAL)
  console.log(`\nend-to-end OK (${steps.length} steps); the fake model served ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  const tools = llm.requests.find(r => Array.isArray(r.tools))?.tools?.map(t => t.function?.name) ?? []
  if (tools.length > 0) console.error(`  tools offered to the model: ${tools.join(', ')}`)
  process.exitCode = 1
} finally {
  await removeFakeProvider(call)
  gateway.close()
  await llm.close()
}
