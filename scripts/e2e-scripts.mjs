#!/usr/bin/env node
/**
 * End-to-end check of the script library (M1) against a running gateway, with
 * no network and no API key:
 *
 * 1. Through the `scripts` capability (what the UI does): point the library at
 *    the test-kit fake GitHub, install the built-in MAA pack from a fake
 *    release, update it with the user's config carried over, roll back, check
 *    the environment.
 * 2. Through the agent: the fake model calls `script_install` for a repository
 *    no built-in pack describes; the approval is requested and granted; the
 *    install completes.
 *
 * Everything it creates is removed afterwards and the settings are restored.
 *
 *   ADG_GATEWAY_TOKEN=dev-token pnpm dev:host          # in another terminal
 *   ADG_GATEWAY_TOKEN=dev-token pnpm e2e:scripts
 */
import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { makeZip, startFakeGitHub, startFakeLlm } from '../packages/test-kit/lib/index.js'
import { connectGateway, FAKE_MODEL, FAKE_PROVIDER, removeFakeProvider, saveFakeProvider } from './lib/gateway.mjs'

const MAA = 'MaaAssistantArknights/MaaAssistantArknights'
const STRANGER = 'adg-e2e/stranger-tool'
const maaZip = version => makeZip({
  [`MAA-v${version}/`]: '',
  [`MAA-v${version}/MAA.exe`]: `MZ fake MAA ${version}`,
  [`MAA-v${version}/MaaCore.dll`]: 'MZ',
  [`MAA-v${version}/config/gui.json`]: '{"factory":true}',
})
const github = await startFakeGitHub({
  repos: {
    [MAA]: [{ tag: 'v6.18.0', publishedAt: '2026-09-01T00:00:00Z', assets: [{ name: 'MAA-v6.18.0-win-x64.zip', content: maaZip('6.18.0') }, { name: 'MAA-v6.18.0-linux-x86_64.tar.gz', content: 'x' }] }],
    [STRANGER]: [{ tag: 'v0.3.0', assets: [{ name: 'stranger-tool-windows-amd64.zip', content: makeZip({ 'stranger.exe': 'MZ' }) }] }],
  },
})
const gateway = await connectGateway({ name: 'adg-e2e-scripts' })
const { call, waitFor } = gateway
const steps = []
const step = (name, detail = '') => {
  steps.push(name)
  console.log(`✔ ${name}${detail === '' ? '' : `: ${detail}`}`)
}
const jobDone = jobId => waitFor(m => m.method === 'scripts/job' && m.params.id === jobId && m.params.endedAt !== undefined, `job ${jobId}`, 120_000)
const expectDone = job => { if (job.phase !== 'done') throw new Error(`job ${job.kind} ended ${job.phase}: ${job.error ?? ''}`) }

if (!gateway.capabilities.includes('scripts')) {
  console.error('✘ the gateway does not serve the scripts capability; rebuild (pnpm build) and restart pnpm dev:host')
  process.exit(1)
}

const original = await call('scripts/settings', {})
const before = await call('scripts/list', {})
if (before.scripts.some(s => s.id === 'maa' || s.id === 'stranger-tool')) {
  console.error('✘ the library already has "maa" or "stranger-tool"; remove them first so this check cannot touch your scripts')
  process.exit(1)
}
let llm
try {
  await call('scripts/settings/set', { apiBase: github.url, downloadMirror: '' })
  step('point the library at the fake GitHub', github.url)
  const packs = before.packs.map(p => p.id).sort().join(', ')
  step('built-in packs', packs)

  const releases = await call('scripts/releases', { repo: MAA })
  if (releases.packId !== 'maa' || releases.releases[0]?.suggestedAsset !== 'MAA-v6.18.0-win-x64.zip') throw new Error(`unexpected releases: ${JSON.stringify(releases)}`)
  step('releases resolved through the pack', `${releases.releases[0].tag} → ${releases.releases[0].suggestedAsset}`)

  const started = await call('scripts/install', { repo: MAA })
  expectDone(await jobDone(started.jobId))
  let maa = await call('scripts/get', { id: 'maa' })
  if (maa.current !== '6.18.0' || maa.family !== 'gui-config') throw new Error(`unexpected install: ${JSON.stringify(maa)}`)
  step('installed', `${maa.id} ${maa.current} → ${maa.dir}`)
  step('environment checked', maa.env?.items.map(i => `${i.kind}=${i.status}`).join(', ') ?? 'none')

  writeFileSync(join(maa.dir, 'config', 'gui.json'), '{"mine":true}')
  github.fault(null)
  await github.close()
  const github2 = await startFakeGitHub({
    repos: { [MAA]: [
      { tag: 'v6.18.0', publishedAt: '2026-09-01T00:00:00Z', assets: [{ name: 'MAA-v6.18.0-win-x64.zip', content: maaZip('6.18.0') }] },
      { tag: 'v6.19.0', publishedAt: '2026-10-01T00:00:00Z', assets: [{ name: 'MAA-v6.19.0-win-x64.zip', content: maaZip('6.19.0') }] },
    ] },
  })
  try {
    await call('scripts/settings/set', { apiBase: github2.url })
    const check = await call('scripts/checkUpdate', { id: 'maa' })
    if (!check.available || check.latest !== '6.19.0') throw new Error(`update not seen: ${JSON.stringify(check)}`)
    const update = await call('scripts/update', { id: 'maa' })
    expectDone(await jobDone(update.jobId))
    maa = await call('scripts/get', { id: 'maa' })
    const carried = readFileSync(join(maa.dir, 'config', 'gui.json'), 'utf8')
    if (maa.current !== '6.19.0' || carried !== '{"mine":true}') throw new Error(`update wrong: ${maa.current} ${carried}`)
    step('updated with config carried over', `${check.current} → ${maa.current}`)

    maa = await call('scripts/rollback', { id: 'maa' })
    if (maa.current !== '6.18.0') throw new Error(`rollback went to ${maa.current}`)
    step('rolled back', `versions ${maa.versions.map(v => v.version).join(', ')}, current ${maa.current}`)
  } finally {
    await github2.close()
  }

  // The agent installs a repository no built-in pack describes: approval first.
  const github3 = await startFakeGitHub({ repos: { [STRANGER]: [{ tag: 'v0.3.0', assets: [{ name: 'stranger-tool-windows-amd64.zip', content: makeZip({ 'stranger.exe': 'MZ' }) }] }] } })
  try {
    await call('scripts/settings/set', { apiBase: github3.url })
    llm = await startFakeLlm({
      models: [FAKE_MODEL],
      replies: [{ toolCalls: [{ name: 'script_install', arguments: { repo: STRANGER } }] }],
      fallback: { text: '安装完成。' },
      scripted: body => Array.isArray(body.tools) && body.tools.length > 0,
    })
    await saveFakeProvider(call, `${llm.url}/v1`)
    const { sessionId } = await call('sessions/create', {})
    const opened = await call('session/open', { sessionId })
    for (let attempt = 0; ; attempt++) {
      const ok = await call('session/selectModel', { sessionId, provider: FAKE_PROVIDER, model: FAKE_MODEL }).then(() => true, () => false)
      if (ok) break
      if (attempt > 20) throw new Error('fake model route never registered')
      await delay(250)
    }
    const approval = waitFor(m => m.method === 'approval/requested' && m.params.sessionId === sessionId, 'approval for script_install')
    const result = waitFor(m => m.method === 'session/event' && m.params.subscriptionId === opened.subscriptionId && m.params.event.type === 'tool/result', 'script_install result', 120_000)
    await call('session/prompt', { sessionId, requestId: `e2e-scripts-${Date.now()}`, text: `安装 ${STRANGER}`, mode: 'queue' })
    const request = await approval
    if (request.toolName !== 'script_install' || !request.reason?.includes(STRANGER)) throw new Error(`unexpected approval: ${JSON.stringify(request)}`)
    step('agent asked before installing an unknown repo', request.reason)
    await call('approval/respond', { approvalId: request.approvalId, decision: 'allow-once' })
    const event = (await result).event
    const text = event.content?.map(c => c.text ?? '').join('') ?? ''
    if (event.isError || !text.includes('"ok": true')) throw new Error(`script_install failed: ${text}`)
    const stranger = await call('scripts/get', { id: 'stranger-tool' })
    step('agent installed it', `${stranger.id} ${stranger.current}, launchers: ${stranger.probe?.executables.join(', ')}`)
  } finally {
    await github3.close()
  }

  console.log(`\nscripts end-to-end OK (${steps.length} steps)`)
} catch (error) {
  console.error(`\n✘ failed after: ${steps.join(' → ') || 'nothing'}\n  ${error.message}`)
  process.exitCode = 1
} finally {
  for (const id of ['maa', 'stranger-tool']) await call('scripts/remove', { id, deleteFiles: true }).catch(() => {})
  const { tokenConfigured: _ignored, ...settings } = original
  await call('scripts/settings/set', settings).catch(() => {})
  await removeFakeProvider(call)
  gateway.close()
  await github.close().catch(() => {})
  await llm?.close()
}
