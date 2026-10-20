#!/usr/bin/env node
/**
 * End-to-end check of 设置 → 权限 against a running host, with a fake model:
 *
 * 1. 完全访问: a command that would escape the sandbox runs at once — the
 *    session has no sandbox, and no approval reaches the UI.
 * 2. 完全访问 covers the app's own confirmations too: running the help of a
 *    script without a built-in pack (normally asked first) is allowed at once
 *    and listed as auto-allowed.
 * 3. Back to 每次确认: the escalated command asks again.
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e:permissions
 */
import { copyFileSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const SHELL = process.platform === 'win32' ? 'pwsh' : 'bash'
const ID = 'e2e-permissions-tool'
const dir = mkdtempSync(join(tmpdir(), 'adg-e2e-perm-'))
copyFileSync(process.execPath, join(dir, 'Tool.exe'))

const call = (name, args) => ({ toolCalls: [{ name, arguments: args }] })
const command = marker => call(SHELL, { description: 'Print a marker', command: `echo ${marker}`, sandbox_permissions: 'danger-full-access', justification: 'e2e：权限检查' })
const llm = await startFakeLlm({
  models: [FAKE_MODEL],
  replies: [
    command('full-access-ok'), { text: '完全访问下运行了。' },
    call('script_help', { id: ID, exe: 'Tool.exe', args: ['--version'] }), { text: '看到了版本号。' },
    command('asked-ok'), { text: '确认后运行了。' },
  ],
  fallback: { text: '好的。' },
  scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
})
const gateway = await connectGateway({ name: 'adg-e2e-permissions' })
const { call: rpc, waitFor } = gateway
const steps = []
const step = (name, detail = '') => { steps.push(name); console.log(`✔ ${name}${detail === '' ? '' : `: ${detail}`}`) }
const fail = message => { throw new Error(message) }
/** The tool result that followed a call of `name`. */
const resultOf = name => {
  const r = llm.requests.find(q => q.messages?.at(-1)?.role === 'tool' && JSON.stringify(q.messages.at(-2) ?? {}).includes(name))
  return r === undefined ? undefined : JSON.stringify(r.messages.at(-1))
}
const asked = []
let before
try {
  if (!gateway.capabilities.includes('permissions')) fail('capability permissions missing; rebuild and restart pnpm dev:host')
  before = (await rpc('permissions/get', {})).mode
  await saveFakeProvider(rpc, `${llm.url}/v1`)
  await rpc('scripts/import', { path: dir, id: ID, name: 'E2E 权限假工具' })

  // 1. full access: no sandbox, no question
  await rpc('permissions/set', { mode: 'full' })
  const { sessionId } = await rpc('sessions/create', {})
  for (let i = 0; !(await rpc('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false)); i++) {
    if (i > 50) fail('the fake model route never appeared')
    await delay(200)
  }
  waitFor(m => m.method === 'approval/requested' && m.params.sessionId === sessionId, 'an approval', 300_000).then(p => asked.push(p), () => {})
  const prompt = text => rpc('session/prompt', { sessionId, requestId: `p-${Date.now()}`, text, mode: 'queue' })
  await prompt('运行一条命令')
  if (!(await waitUntil(() => resultOf(SHELL) !== undefined, 120_000))) fail('the command never ran')
  if (!resultOf(SHELL).includes('full-access-ok')) fail(`unexpected command result: ${resultOf(SHELL).slice(0, 300)}`)
  if (asked.length > 0) fail('full access still asked for approval')
  step('完全访问: a command escaping the sandbox ran without asking', 'full-access-ok')

  // 2. the app's own confirmation
  await prompt('看看这个工具的版本')
  if (!(await waitUntil(() => resultOf('script_help') !== undefined, 120_000))) fail('script_help never returned')
  const help = resultOf('script_help')
  if (!/v\d+\.\d+/.test(help)) fail(`script_help did not run: ${help.slice(0, 300)}`)
  const allowed = (await rpc('permissions/get', {})).recent
  const entry = allowed.find(r => r.toolName === 'script_help')
  if (entry === undefined) fail(`script_help is not in the auto-allowed list: ${JSON.stringify(allowed)}`)
  if (asked.length > 0) fail('full access still asked for approval')
  step('完全访问: the app’s own confirmation was allowed at once and listed', entry.reason ?? '')

  // 3. ask again
  await rpc('permissions/set', { mode: 'ask' })
  const approval = waitFor(m => m.method === 'approval/requested' && m.params.sessionId === sessionId, 'an approval', 120_000)
  await prompt('再运行一条')
  const request = await approval
  await rpc('approval/respond', { approvalId: request.approvalId, decision: 'allow-once' })
  if (!(await waitUntil(() => llm.requests.some(r => JSON.stringify(r.messages?.at(-1) ?? {}).includes('asked-ok')), 120_000))) fail('the approved command never ran')
  step('每次确认: the escalated command asked first, then ran once allowed', request.toolName)

  console.log(`\npermissions end-to-end OK (${steps.length} steps); the fake model served ${llm.requests.length} requests`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  process.exitCode = 1
} finally {
  if (before !== undefined) await rpc('permissions/set', { mode: before }).catch(() => {})
  await rpc('scripts/remove', { id: ID }).catch(() => {})
  await removeFakeProvider(rpc)
  gateway.close()
  await llm.close()
  rmSync(dir, { recursive: true, force: true, maxRetries: 5 })
}
// The watcher for an unexpected approval is still waiting: do not wait for it.
process.exit(process.exitCode ?? 0)

async function waitUntil(check, ms) {
  const end = Date.now() + ms
  while (Date.now() < end) {
    if (check()) return true
    await delay(300)
  }
  return false
}
