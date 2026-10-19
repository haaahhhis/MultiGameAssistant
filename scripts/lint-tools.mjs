#!/usr/bin/env node
/**
 * Every tool the agent is offered, as a model really receives it (the fake
 * model records the request), checked for loose schemas: some models keep
 * emitting whitespace on "any value" / "any object" parameters and the
 * provider cuts them off (`tool_arguments_stalled`).
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host
 *   ADG_GATEWAY_TOKEN=dev-token pnpm lint:tools
 */
import { schemaProblems, startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const llm = await startFakeLlm({ models: [FAKE_MODEL], fallback: { text: '好的。' } })
const gateway = await connectGateway({ name: 'adg-lint-tools' })
const { call } = gateway
try {
  await saveFakeProvider(call, `${llm.url}/v1`)
  const { sessionId } = await call('sessions/create', {})
  for (let i = 0; ; i++) {
    try {
      await call('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL })
      await call('session/prompt', { sessionId, requestId: `lint-${Date.now()}`, text: '你好', mode: 'queue' })
      break
    } catch (error) {
      if (i > 30) throw error
      await new Promise(r => setTimeout(r, 500))
    }
  }
  for (let i = 0; i < 100 && !llm.requests.some(r => Array.isArray(r.tools)); i++) await new Promise(r => setTimeout(r, 200))
  const tools = llm.requests.find(r => Array.isArray(r.tools))?.tools ?? []
  if (tools.length === 0) throw new Error('the model was offered no tools')
  let bad = 0
  for (const tool of tools) {
    const fn = tool.function ?? tool
    const problems = schemaProblems(fn.parameters ?? {})
    if (problems.length === 0) continue
    bad++
    console.log(`✘ ${fn.name}\n    ${problems.join('\n    ')}`)
  }
  console.log(`\n${tools.length} tools offered, ${bad} with loose parameters${bad === 0 ? '' : ' (see above)'}`)
  if (process.argv.includes('--strict') && bad > 0) process.exitCode = 1
} catch (error) {
  console.error(`✘ ${error.message}`)
  process.exitCode = 1
} finally {
  await removeFakeProvider(call)
  gateway.close()
  await llm.close()
}
