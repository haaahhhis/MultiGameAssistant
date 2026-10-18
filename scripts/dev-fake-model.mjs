#!/usr/bin/env node
/**
 * Register the test-kit fake model as provider `adg-fake` on a running gateway
 * and keep serving it, so the UI can be clicked through without an API key.
 * Ctrl+C removes the provider again.
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:fake-model
 *
 * Behaviour: a prompt mentioning “审批” or “命令” makes the model ask to run a
 * shell command that needs approval; after the tool result it reports the
 * output; anything else is echoed back.
 */
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'

const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  respond: body => {
    const messages = Array.isArray(body.messages) ? body.messages : []
    const last = messages.at(-1)
    if (!Array.isArray(body.tools) || body.tools.length === 0) return { text: '模拟会话' } // title request
    if (last?.role === 'tool') return { text: `命令已执行，输出：${textOf(last.content).trim() || '（无输出）'}` }
    // The user's words come first among the user-role messages of this turn;
    // dsh appends runtime-context and reminder messages after them.
    const lastAssistant = messages.findLastIndex(m => m.role === 'assistant')
    const said = messages.slice(lastAssistant + 1).filter(m => m.role === 'user').map(m => textOf(m.content))[0] ?? ''
    if (/审批|命令/.test(said)) {
      return {
        toolCalls: [{
          name: SHELL,
          arguments: {
            description: 'Print a greeting',
            command: 'echo 来自模拟模型的问候',
            sandbox_permissions: 'danger-full-access',
            justification: '演示审批：运行一条无害的 echo 命令',
          },
        }],
      }
    }
    return { text: `（模拟模型）收到：${said.slice(0, 200)}` }
  },
})

const gateway = await connectGateway({ name: 'adg-dev-fake-model' })
await saveFakeProvider(gateway.call, `${llm.url}/v1`)
console.log(`fake model serving at ${llm.url}/v1 as provider adg-fake / ${FAKE_MODEL}; Ctrl+C to stop`)

let stopping = false
for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, async () => {
    if (stopping) return
    stopping = true
    await removeFakeProvider(gateway.call)
    gateway.close()
    await llm.close()
    process.exit(0)
  })
}

function textOf(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) return content.map(part => (typeof part?.text === 'string' ? part.text : '')).join('')
  return ''
}
