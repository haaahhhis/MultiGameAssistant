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
 * output. One mentioning “交给” makes 助手 hand a task to the 游戏 agent
 * (agent_delegate); 游戏 answers it a few seconds later, and 助手 passes the
 * reply on when it comes back. Anything else is echoed back.
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
    if (last?.role === 'tool') {
      const called = messages.findLast(m => m.role === 'assistant')?.tool_calls?.[0]?.function?.name
      if (called === 'agent_delegate') return { text: '（模拟模型）已经交给「游戏」去读明日方舟今天的活动，它读完会发回来。' }
      return { text: `命令已执行，输出：${textOf(last.content).trim() || '（无输出）'}` }
    }
    // The user's words come first among the user-role messages of this turn;
    // dsh appends runtime-context and reminder messages after them.
    const lastAssistant = messages.findLastIndex(m => m.role === 'assistant')
    const said = messages.slice(lastAssistant + 1).filter(m => m.role === 'user').map(m => textOf(m.content))[0] ?? ''
    // 游戏, handed the task: slow enough to see it working in 助手's conversation.
    if (said.startsWith('（助手交给你的事')) return { delayMs: 6000, text: '（模拟模型）明日方舟今天没有结束的活动；「孤星」复刻还有 3 天。不需要你做什么。' }
    // 助手, the reply back: the gist.
    if (/^（「[^」]+」交回了/.test(said)) return { text: `（模拟模型）游戏读完了：${said.split('\n\n')[1] ?? ''}` }
    if (/交给/.test(said) && body.tools.some(t => (t.function?.name ?? t.name) === 'agent_delegate')) {
      return { toolCalls: [{ name: 'agent_delegate', arguments: { agent: '游戏', task: '读一下明日方舟国服今天的活动，哪些今天结束。', expecting: '今天结束的活动，没有就说没有' } }] }
    }
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
