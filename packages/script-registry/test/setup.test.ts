import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { test } from 'node:test'
import type { EnvHost } from '@adg/installer'
import type { ScriptJob } from '@adg/protocol'
import { makeZip } from '@adg/test-kit'
import { ScriptLibrary } from '../src/library.ts'
import type { PendingSetup } from '../src/state.ts'
import { fakeMirror } from './fake-mirror.ts'

const noDotnet: EnvHost = { exec: async () => undefined, exists: async () => false, listDir: async () => [], env: () => undefined }
/** The start of an NSIS installer: an exe whose manifest names NSIS's stub. */
const NSIS = Buffer.concat([Buffer.from('MZ'), Buffer.alloc(4000), Buffer.from('<assemblyIdentity name="Nullsoft.NSIS.exehead"/>'), Buffer.alloc(4000)])

function library(root: string, mirrorUrl: string, setups: PendingSetup[], jobs: ScriptJob[] = []) {
  return new ScriptLibrary({
    toolsDir: join(root, 'tools'), dataDir: join(root, 'data'), packDirs: [],
    credential: async ref => (ref === 'MIRRORCHYAN_CDK' ? 'good' : undefined),
    credentialConfigured: async ref => ref === 'MIRRORCHYAN_CDK',
    envHost: noDotnet, mirrorchyanBase: mirrorUrl,
    onChanged() {}, onJob: job => jobs.push(job), onSetup: async setup => { setups.push(setup); return 'session-1' }, log: { info() {}, warn() {} },
  })
}

test('a Mirror酱 link without a file name: the download takes the real name; an archive under it still unpacks', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-realname-'))
  const mirror = await fakeMirror({ latest: 'v2.0.0', cdk: 'good', full: makeZip({ 'tool.exe': 'MZ 2' }), served: 'Tool-v2.0.0.zip' })
  const lib = library(root, mirror.url, [])
  await lib.start()
  try {
    const job = await lib.install({ mirrorchyan: { rid: 'Tool', platform: false } }).done
    assert.equal(job.phase, 'done', job.error)
    assert.equal(readFileSync(join(lib.get('tool').dir!, 'tool.exe'), 'utf8'), 'MZ 2')
  } finally {
    lib.dispose()
    await mirror.close()
  }
})

test('a setup program instead of an archive: handed to the agent, kept across a restart, finished by importing its folder', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-setup-'))
  const state = { latest: 'v5.7.32', cdk: 'good', full: NSIS, served: 'tool-v5.7.32.exe' }
  const mirror = await fakeMirror(state)
  const setups: PendingSetup[] = []
  const jobs: ScriptJob[] = []
  let lib = library(root, mirror.url, setups, jobs)
  await lib.start()
  try {
    const job = await lib.install({ mirrorchyan: { rid: 'Tool', platform: false } }).done
    assert.equal(job.phase, 'done', job.error)
    assert.equal(job.version, '5.7.32')
    assert.match(jobs.at(-1)?.message ?? '', /tool-v5\.7\.32\.exe 是 NSIS 安装程序，不是压缩包，已交给 agent 安装/)
    assert.deepEqual(jobs.at(-1)?.setup, { kind: 'nsis', dir: join(root, 'tools', 'tool', '5.7.32'), sessionId: 'session-1' }, 'the panel links the conversation')
    assert.equal(setups.length, 1, 'the app starts the agent on it')
    const setup = setups[0]!
    assert.equal(setup.kind, 'nsis')
    assert.equal(basename(setup.file), 'tool-v5.7.32.exe', 'named after the file the link redirected to')
    assert.ok(existsSync(setup.file), 'the installer is kept until it is done')
    assert.equal(setup.dir, join(root, 'tools', 'tool', '5.7.32'))
    assert.deepEqual(setup.source, { kind: 'mirrorchyan', rid: 'Tool', platform: false })
    assert.throws(() => lib.get('tool'), 'not installed yet')

    // Still waiting after a restart.
    lib.dispose()
    lib = library(root, mirror.url, setups, jobs)
    await lib.start()
    assert.equal(lib.pendingSetup('tool')?.version, '5.7.32')
    await assert.rejects(lib.import({ path: setup.dir, id: 'tool' }), /不是一个存在的目录/, 'nothing installed yet')
    mkdirSync(setup.dir, { recursive: true })
    await assert.rejects(lib.import({ path: setup.dir, id: 'tool' }), /是空的/)

    // What the installer would have put there; importing it finishes the install.
    writeFileSync(join(setup.dir, 'ok-gi.exe'), 'MZ')
    const info = await lib.import({ path: setup.dir, id: 'tool' })
    assert.equal(info.current, '5.7.32')
    assert.equal(info.source.kind, 'mirrorchyan', 'still updates from Mirror酱')
    assert.equal(info.dir, setup.dir)
    assert.equal(lib.pendingSetup('tool'), undefined)
    assert.ok(!existsSync(setup.file), 'the installer is removed once done')

    // The agent asking for an update itself is told in the job instead of a new conversation.
    const before = setups.length
    Object.assign(state, { latest: 'v5.7.33', served: 'tool-v5.7.33.exe' })
    const update = await lib.install({ mirrorchyan: { rid: 'Tool', platform: false }, byAgent: true }).done
    assert.equal(update.phase, 'done', update.error)
    assert.equal(setups.length, before)
    assert.match(jobs.at(-1)?.message ?? '', /用 script_setup_run 运行它/)
    assert.equal(lib.pendingSetup('tool')?.update, true)
  } finally {
    lib.dispose()
    await mirror.close()
  }
})
