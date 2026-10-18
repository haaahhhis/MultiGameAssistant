import { strict as assert } from 'node:assert'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { fileURLToPath } from 'node:url'
import { ManualClock } from '../src/clock.ts'
import { startFakeGitHub } from '../src/fake-github.ts'
import { startFakeLlm } from '../src/fake-llm.ts'
import { parseScenario, runScenario } from '../src/fake-script.ts'

const noSleep = { sleep: async () => {} }

test('a scenario plays logs, file writes and stops at its exit code', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-scenario-'))
  const out: string[] = []
  const err: string[] = []
  const code = await runScenario(parseScenario({
    steps: [
      { log: 'TaskChain Fight Start' },
      { logFile: join(dir, 'debug', 'asst.log'), line: 'connected' },
      { writeFile: join(dir, 'config', 'gui.json'), content: '{"ok":true}' },
      { log: 'adb disconnected', stream: 'stderr' },
      { exit: 3 },
      { log: 'never printed' },
    ],
  }), { stdout: l => out.push(l), stderr: l => err.push(l), ...noSleep })
  assert.equal(code, 3)
  assert.deepEqual(out, ['TaskChain Fight Start'])
  assert.deepEqual(err, ['adb disconnected'])
  assert.equal(readFileSync(join(dir, 'debug', 'asst.log'), 'utf8'), 'connected\n')
  assert.equal(readFileSync(join(dir, 'config', 'gui.json'), 'utf8'), '{"ok":true}')
})

test('invalid scenarios are refused with the failing step', () => {
  assert.throws(() => parseScenario({ steps: [{ log: 'ok' }, { exit: 1.5 }] }), /step 1/)
  assert.throws(() => parseScenario({}), /steps array/)
})

test('the CLI wrapper runs a scenario file and exits with its code', () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-cli-'))
  const file = join(dir, 'scenario.json')
  writeFileSync(file, JSON.stringify({ steps: [{ log: 'hello' }, { sleepMs: 5 }, { exit: 7 }] }))
  const cli = fileURLToPath(new URL('../src/fake-script-cli.ts', import.meta.url))
  const result = spawnSync(process.execPath, [cli, file], { encoding: 'utf8' })
  assert.equal(result.status, 7, result.stderr)
  assert.equal(result.stdout.trim(), 'hello')
})

test('the manual clock fires timers in order, including ones scheduled while firing', () => {
  const clock = new ManualClock(0)
  const fired: string[] = []
  clock.setTimeout(() => fired.push('b@20'), 20)
  clock.setTimeout(() => {
    fired.push('a@10')
    clock.setTimeout(() => fired.push('c@15'), 5)
  }, 10)
  const cancel = clock.setTimeout(() => fired.push('cancelled'), 12)
  cancel()
  clock.advance(19)
  assert.deepEqual(fired, ['a@10', 'c@15'])
  assert.equal(clock.now(), 19)
  clock.advance(1)
  assert.deepEqual(fired, ['a@10', 'c@15', 'b@20'])
  assert.equal(clock.pending, 0)
  assert.throws(() => clock.advance(-1))
})

test('the fake GitHub lists releases, resolves latest, serves assets and injects faults', async () => {
  const github = await startFakeGitHub({
    repos: {
      'MaaAssistantArknights/MaaAssistantArknights': [
        { tag: 'v6.19.0', publishedAt: '2026-10-01T00:00:00Z', assets: [{ name: 'MAA-v6.19.0-win-x64.zip', content: 'zip-bytes' }] },
        { tag: 'v6.20.0-beta.1', prerelease: true, publishedAt: '2026-10-10T00:00:00Z', assets: [] },
        { tag: 'v6.21.0', draft: true, assets: [] },
      ],
    },
  })
  try {
    const api = `${github.url}/repos/MaaAssistantArknights/MaaAssistantArknights/releases`
    const list = await (await fetch(api)).json() as { tag_name: string }[]
    assert.deepEqual(list.map(r => r.tag_name), ['v6.20.0-beta.1', 'v6.19.0'])

    const latest = await (await fetch(`${api}/latest`)).json() as { tag_name: string; assets: { name: string; size: number; browser_download_url: string }[] }
    assert.equal(latest.tag_name, 'v6.19.0')
    assert.equal(latest.assets[0]!.size, 9)
    assert.equal(await (await fetch(latest.assets[0]!.browser_download_url)).text(), 'zip-bytes')

    github.fault({ kind: 'rate-limit' }, 1)
    const limited = await fetch(`${api}/latest`)
    assert.equal(limited.status, 403)
    assert.equal(limited.headers.get('x-ratelimit-remaining'), '0')
    assert.equal((await fetch(`${api}/latest`)).status, 200, 'the fault applies to one request only')

    github.fault({ kind: 'drop' }, 1)
    await assert.rejects(fetch(`${api}/latest`))
    assert.equal((await fetch(`${github.url}/repos/nobody/nothing/releases`)).status, 404)
  } finally {
    await github.close()
  }
})

test('the fake model lists models and plays scripted text and tool-call replies', async () => {
  const llm = await startFakeLlm({
    models: ['fake-vision'],
    replies: [{ toolCalls: [{ name: 'bash', arguments: { command: 'echo hi' } }] }],
    fallback: { text: 'all done' },
  })
  try {
    const models = await (await fetch(`${llm.url}/v1/models`)).json() as { data: { id: string }[] }
    assert.deepEqual(models.data.map(m => m.id), ['fake-vision'])

    const post = (stream: boolean) => fetch(`${llm.url}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'fake-vision', stream, messages: [{ role: 'user', content: 'hi' }] }),
    })
    const sse = await (await post(true)).text()
    const chunks = sse.split('\n\n').filter(l => l.startsWith('data: {')).map(l => JSON.parse(l.slice(6)))
    const call = chunks.flatMap(c => c.choices).find(c => c.delta?.tool_calls !== undefined)
    assert.equal(call.delta.tool_calls[0].function.name, 'bash')
    assert.deepEqual(JSON.parse(call.delta.tool_calls[0].function.arguments), { command: 'echo hi' })
    assert.ok(sse.trimEnd().endsWith('data: [DONE]'))

    const plain = await (await post(false)).json() as { choices: { message: { content: string } }[] }
    assert.equal(plain.choices[0]!.message.content, 'all done')
    assert.equal(llm.requests.length, 2)
  } finally {
    await llm.close()
  }
})
