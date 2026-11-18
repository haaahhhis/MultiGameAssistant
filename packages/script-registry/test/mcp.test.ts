import { strict as assert } from 'node:assert'
import { copyFileSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Mcp, ScriptManifest } from '@adg/pack-schema'
import { discoverMcp, expandPlaceholders, fingerprint, mcpEndpoints, parseMcpConfig, ScriptMcp } from '../src/mcp.ts'

const FAKE = new URL('./fixtures/fake-mcp-server.mjs', import.meta.url)

/** A script directory with the fake server and an MCP config pointing at it. */
function scriptDir(config: unknown, file = '.mcp.json'): string {
  const dir = mkdtempSync(join(tmpdir(), 'adg-mcp-'))
  copyFileSync(FAKE, join(dir, 'server.mjs'))
  mkdirSync(join(dir, file, '..'), { recursive: true })
  writeFileSync(join(dir, file), typeof config === 'string' ? config : JSON.stringify(config))
  return dir
}

test('MCP config files are read in the shapes scripts write them', () => {
  const claude = parseMcpConfig(JSON.stringify({ mcpServers: { maa: { command: 'MaaMCP.exe', args: ['--stdio'], env: { A: 1 } }, web: { url: 'http://127.0.0.1:5000/mcp' }, old: { url: 'http://localhost:1/sse' }, off: { command: 'x', disabled: true } } }), '.mcp.json')
  assert.deepEqual(claude.map(s => [s.server, s.transport]), [['maa', 'stdio'], ['web', 'http'], ['old', 'sse'], ['off', 'stdio']])
  assert.deepEqual(claude[0]!.env, { A: '1' }, 'env values become strings')
  assert.equal(claude[3]!.disabled, true)
  // VS Code: `servers`, `type`, comments and trailing commas.
  const vscode = parseMcpConfig('{\n // the script\'s server\n "servers": { "bgi": { "type": "http", "url": "http://127.0.0.1:8090/mcp", }, },\n}', '.vscode/mcp.json')
  assert.deepEqual(vscode.map(s => [s.file, s.server, s.transport, s.url]), [['.vscode/mcp.json', 'bgi', 'http', 'http://127.0.0.1:8090/mcp']])
  assert.deepEqual(parseMcpConfig('not json', 'x'), [])
  assert.deepEqual(parseMcpConfig('{"other": 1}', 'x'), [])
})

test('placeholders: the script directory, the environment; ${input:…} cannot be filled', () => {
  process.env['ADG_MCP_TEST'] = 'yes'
  const inputs = new Set<string>()
  assert.equal(expandPlaceholders('${workspaceFolder}/a {dir}/b ${env:ADG_MCP_TEST} ${ADG_MCP_TEST}', 'D:/s', inputs), 'D:/s/a D:/s/b yes yes')
  expandPlaceholders('--token ${input:token}', 'D:/s', inputs)
  assert.deepEqual([...inputs], ['token'])
})

test('endpoints: the pack names and explains servers, from the script\'s own file; the rest are offered as found', async () => {
  const dir = scriptDir({ mcpServers: { main: { command: 'node', args: ['${workspaceFolder}/server.mjs'] }, 'extra tool!': { url: 'http://127.0.0.1:9/mcp' }, ask: { command: 'x', args: ['${input:key}'] } } })
  const found = await discoverMcp(dir)
  assert.equal(found.length, 3)
  const mcp = Mcp.parse({ servers: [{ name: 'script', from: { file: '.mcp.json', server: 'main' }, description: '控制脚本' }], usage: '先 status' })
  const endpoints = mcpEndpoints(dir, found, mcp, true)
  assert.deepEqual(endpoints.map(e => [e.name, e.source, e.builtin]), [['script', 'pack', true], ['extra-tool', 'discovered', false], ['ask', 'discovered', false]])
  assert.equal(endpoints[0]!.args[0], `${dir}/server.mjs`)
  assert.equal(endpoints[0]!.cwd, dir)
  assert.equal(endpoints[0]!.server, 'main')
  assert.match(endpoints[2]!.problem ?? '', /key/)
  // A `from` the script no longer has.
  const gone = mcpEndpoints(dir, found, Mcp.parse({ servers: [{ name: 'x', from: { file: '.mcp.json', server: 'renamed' } }] }), true)
  assert.match(gone[0]!.problem ?? '', /renamed/)
  // A relative command is the script's own program.
  const local = mcpEndpoints(dir, [{ file: 'mcp.json', server: 's', transport: 'stdio', command: './bin/srv.exe' }], undefined, false)
  assert.equal(local[0]!.command, join(dir, 'bin', 'srv.exe'))
})

test('pack manifests: an mcp section is checked', () => {
  assert.equal(Mcp.safeParse({ servers: [{ name: 'a', transport: 'stdio' }] }).success, false, 'stdio needs a command')
  assert.equal(Mcp.safeParse({ servers: [{ name: 'a', transport: 'http', url: 'http://x/mcp' }] }).success, true)
  assert.equal(Mcp.safeParse({ servers: [{ name: 'bad name' , from: { file: '.mcp.json' } }] }).success, false)
  const manifest = (mcp: unknown) => ScriptManifest.safeParse({ id: 'demo', name: 'Demo', launch: { exe: 'demo.exe' }, tasks: [{ id: 'daily', title: '日常' }], mcp })
  assert.equal(manifest({ servers: [{ name: 'a', from: { file: '.mcp.json' } }], usage: '先 status', tools: [{ name: 'start', use: '开始', task: 'daily' }] }).success, true)
  const issues = (mcp: unknown) => { const r = manifest(mcp); return r.success ? [] : r.error.issues.map(i => i.message) }
  assert.deepEqual(issues({ servers: [{ name: 'a', from: { file: '.mcp.json' } }], tools: [{ name: 'start', use: '开始', task: 'weekly' }] }), ['no task weekly'])
  assert.deepEqual(issues({ servers: [{ name: 'a', from: { file: 'x.json' } }, { name: 'b', from: { file: 'x.json' } }], tools: [{ name: 't', use: 'u' }, { name: 't', server: 'c', use: 'u' }] }), ['several MCP servers: say which one', 'no MCP server c'])
  assert.deepEqual(issues({ servers: [] }), ['no MCP servers: say why in note'])
  assert.deepEqual(issues({ servers: [], note: '要付费的服务' }), [])
})

test('a script\'s stdio server: connected when used, its tools listed and called, errors reported', async () => {
  const dir = scriptDir({ mcpServers: { fake: { command: process.execPath, args: ['{dir}/server.mjs'], env: { FAKE_MODE: 'test' } } } }, '.vscode/mcp.json')
  const data = mkdtempSync(join(tmpdir(), 'adg-mcp-data-'))
  const mcp = new ScriptMcp({ dataDir: data, idleMs: 60_000 })
  try {
    const [endpoint] = await mcp.endpoints(dir, undefined)
    assert.ok(endpoint !== undefined)
    assert.equal(await mcp.trusted('demo', endpoint), false, 'no built-in pack: asked first')
    await mcp.trust('demo', endpoint)
    assert.equal(await new ScriptMcp({ dataDir: data }).trusted('demo', endpoint), true, 'the approval is kept')
    assert.equal(mcp.connected('demo', 'fake'), false, 'nothing runs until used')

    const listed = await mcp.tools('demo', endpoint)
    assert.deepEqual(listed.tools.map(t => t.name), ['status', 'start_task', 'fail'])
    assert.equal(listed.tools[0]!.readOnly, true)
    assert.deepEqual(listed.server, { name: 'fake-script', version: '1.2.3' })
    assert.equal(listed.instructions, 'Call status first.')
    assert.equal(mcp.connected('demo', 'fake'), true)

    const started = await mcp.call('demo', endpoint, 'start_task', { task: 'daily' })
    assert.deepEqual({ ...started }, { isError: false, text: 'started daily', structured: { started: 'daily' }, other: [] })
    const status = await mcp.call('demo', endpoint, 'status', {})
    assert.equal(status.text, 'running: daily; env FAKE_MODE=test', 'one server process across calls, with its env')
    const failed = await mcp.call('demo', endpoint, 'fail', {})
    assert.equal(failed.isError, true)
    assert.equal(failed.text, 'no emulator connected')
    await assert.rejects(mcp.call('demo', endpoint, 'nope', {}), /没有工具 nope/)

    // The script changed its server (an update): a new process, not the old one.
    const moved = { ...endpoint, args: [...endpoint.args, '--v2'] }
    assert.notEqual(fingerprint('demo', moved), fingerprint('demo', endpoint))
    assert.equal(await mcp.trusted('demo', moved), false, 'a changed command is asked about again')
    assert.equal((await mcp.call('demo', moved, 'status', {})).text, 'running: idle; env FAKE_MODE=test')

    await mcp.close('demo')
    assert.equal(mcp.connected('demo', 'fake'), false)
  } finally {
    await mcp.dispose()
  }
})

test('a server that cannot start says why, with what it printed', async () => {
  const dir = scriptDir({ mcpServers: { broken: { command: process.execPath, args: ['-e', 'console.error("missing resource folder"); process.exit(3)'] } } })
  const mcp = new ScriptMcp({ dataDir: mkdtempSync(join(tmpdir(), 'adg-mcp-data-')) })
  try {
    const [endpoint] = await mcp.endpoints(dir, undefined)
    await assert.rejects(mcp.tools('demo', endpoint!), (error: Error) => /连不上 MCP 服务 broken/.test(error.message))
    const http = mcpEndpoints(dir, [{ file: '.mcp.json', server: 'gui', transport: 'http', url: 'http://127.0.0.1:9/mcp' }], undefined, false)[0]!
    await assert.rejects(mcp.tools('demo', http), (error: Error) => /要先启动脚本/.test(error.message))
  } finally {
    await mcp.dispose()
  }
})
