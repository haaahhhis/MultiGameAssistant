import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { findMuMu } from '../src/detect.ts'
import { MuMuManager, parsePolluted, type Exec } from '../src/mumu.ts'

/** A fake MuMuManager: two instances; launching instance 1 boots it after two polls. */
function fakeMuMu() {
  const calls: string[] = []
  const state: Record<number, { process: boolean; android: boolean; polls: number }> = {
    0: { process: true, android: true, polls: 0 },
    1: { process: false, android: false, polls: 0 },
  }
  const entry = (i: number) => ({
    index: String(i), name: i === 0 ? 'MuMu安卓设备' : '多开-1',
    is_process_started: state[i]!.process, is_android_started: state[i]!.android,
    ...(state[i]!.android ? { adb_host_ip: '127.0.0.1', adb_port: 16384 + 32 * i } : {}),
  })
  const exec: Exec = async (_file, args) => {
    calls.push(args.join(' '))
    const [cmd, , target, action] = args
    if (cmd === 'info' && target === 'all') return { code: 0, stdout: `[log] noise\n${JSON.stringify({ 0: entry(0), 1: entry(1) })}\n`, stderr: '' }
    if (cmd === 'info') {
      const i = Number(target)
      if (state[i] === undefined) return { code: 0, stdout: '{"errcode":-1,"errmsg":"vm not exist"}', stderr: '' }
      if (state[i]!.process && !state[i]!.android && ++state[i]!.polls >= 2) state[i]!.android = true
      return { code: 0, stdout: JSON.stringify(entry(i)), stderr: '' }
    }
    if (cmd === 'control' && action === 'launch') { state[Number(target)]!.process = true; return { code: 0, stdout: '{"errcode":0}', stderr: '' } }
    if (cmd === 'control' && action === 'shutdown') { state[Number(target)] = { process: false, android: false, polls: 0 }; return { code: 0, stdout: '{"errcode":0}', stderr: '' } }
    if (cmd === 'adb') return { code: 0, stdout: 'vm not running', stderr: '' }
    return { code: 1, stdout: '', stderr: 'unknown command' }
  }
  return { exec, calls, state }
}

test('instances are read from noisy JSON for one or all', async () => {
  const { exec } = fakeMuMu()
  const mumu = new MuMuManager('C:\\MuMu\\shell\\MuMuManager.exe', exec)
  const list = await mumu.instances()
  assert.deepEqual(list.map(i => [i.index, i.name, i.ready, i.adb]), [[0, 'MuMu安卓设备', true, '127.0.0.1:16384'], [1, '多开-1', false, undefined]])
  assert.equal((await mumu.instance(0))?.running, true)
  assert.throws(() => parsePolluted('no json here'), /没有 JSON/)
})

test('ensureReady launches a stopped instance and waits for Android', async () => {
  const { exec, calls } = fakeMuMu()
  const mumu = new MuMuManager('mgr.exe', exec)
  const status: string[] = []
  const ready = await mumu.ensureReady(1, { timeoutMs: 5000, pollMs: 10, onStatus: s => status.push(s) })
  assert.equal(ready.ready, true)
  assert.ok(calls.includes('control -v 1 launch'))
  assert.match(status[0]!, /启动 MuMu 实例 1/)
  assert.equal(await mumu.adbAddress(1), '127.0.0.1:16416')
  await assert.rejects(mumu.ensureReady(7, { timeoutMs: 100, pollMs: 10 }), /没有实例 7；可用实例：0（MuMu安卓设备）、1（多开-1）/)
})

test('an instance that never boots times out; a missing manager is reported', async () => {
  const exec: Exec = async (_f, args) => args[0] === 'info'
    ? { code: 0, stdout: JSON.stringify({ index: '0', name: 'x', is_process_started: true, is_android_started: false }), stderr: '' }
    : { code: 0, stdout: '{}', stderr: '' }
  await assert.rejects(new MuMuManager('m.exe', exec).ensureReady(0, { timeoutMs: 50, pollMs: 10 }), /内没有启动完成/)
  await assert.rejects(new MuMuManager('missing.exe', async () => undefined).instances(), /找不到 MuMuManager/)
  assert.equal(await new MuMuManager('m.exe', exec).adbAddress(0), '127.0.0.1:16384', 'default port when MuMu does not say')
})

test('detection finds MuMuManager from uninstall entries and known folders', async () => {
  const root = mkdtempSync(join(tmpdir(), 'adg-mumu-'))
  const viaRegistry = join(root, 'Netease', 'MuMu Player 12')
  mkdirSync(join(viaRegistry, 'shell'), { recursive: true })
  writeFileSync(join(viaRegistry, 'shell', 'MuMuManager.exe'), 'MZ')
  const viaFolder = join(root, 'Other', 'MuMuPlayer')
  mkdirSync(join(viaFolder, 'nx_main'), { recursive: true })
  writeFileSync(join(viaFolder, 'nx_main', 'MuMuManager.exe'), 'MZ')
  const registry = [
    { DisplayName: 'MuMu Player 12', DisplayVersion: '4.1.2', DisplayIcon: `${join(viaRegistry, 'shell', 'MuMuPlayer.exe')},0` },
    { DisplayName: 'MuMuPlugin', InstallLocation: viaFolder },
    { DisplayName: '7-Zip', InstallLocation: 'C:\\7z' },
  ]
  const exec: Exec = async () => ({ code: 0, stdout: JSON.stringify(registry), stderr: '' })
  const found = await findMuMu(exec, [viaFolder, join(root, 'nothing')])
  assert.deepEqual(found.map(f => [f.manager, f.version]), [
    [join(viaRegistry, 'shell', 'MuMuManager.exe'), '4.1.2'],
    [join(viaFolder, 'nx_main', 'MuMuManager.exe'), undefined],
  ], 'MuMuPlugin is not taken for MuMu; the folder scan still finds the second install')
  assert.deepEqual(await findMuMu(async () => undefined, []), [], 'no PowerShell, no folders: nothing found')
})
