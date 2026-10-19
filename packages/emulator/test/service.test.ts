import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Context } from '@deepseek-ai/cordis'
import { AdgEmulators, type Config } from '../src/index.ts'

// Other plugins reach this service through Cordis, which hands out a proxy:
// every public method must work with the proxy as `this` (no `#private` members).
test('the service works when called through ctx.get, as the runner does', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-emu-svc-'))
  const ctx = new Context()
  class NoMuMu extends AdgEmulators {
    constructor(ctx: Context, config: Config) {
      super(ctx, config, async () => undefined)
    }
  }
  await ctx.plugin(NoMuMu, { dataDir: dir, sharedDir: dir })
  const service = ctx.get('adgEmulators')
  assert.ok(service !== undefined)
  await service.prepare({ signal: AbortSignal.timeout(5000), onStatus: () => {} }).then(
    () => assert.fail('no emulator to prepare'),
    (error: Error) => assert.match(error.message, /没有找到 MuMu 模拟器/),
  )

  const emulators = ctx.get('adgEmulators') as unknown as AdgEmulators
  assert.equal((await emulators.configure({ manualAddress: '127.0.0.1:5555' })).manualAddress, '127.0.0.1:5555')
  assert.deepEqual(await service.prepare({ signal: AbortSignal.timeout(5000), onStatus: () => {} }), { address: '127.0.0.1:5555', label: '手动配置的 ADB 地址', managed: false })
  assert.equal((await emulators.status()).selection.address, '127.0.0.1:5555')
})

test('reconnect runs adb disconnect / connect and checks the device; screencap returns the PNG', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-emu-adb-'))
  const calls: string[] = []
  const exec = async (file: string, args: readonly string[]) => {
    calls.push([file, ...args].join(' '))
    if (args[0] === 'connect') return { code: 0, stdout: 'connected to 127.0.0.1:5555\n', stderr: '' }
    if (args.includes('echo')) return { code: 0, stdout: 'adg-ok\n', stderr: '' }
    if (file.endsWith('reg.exe') || file === 'reg') return undefined
    return { code: 0, stdout: '', stderr: '' }
  }
  const execBuffer = async () => ({ code: 0, stdout: Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d]), stderr: '' })
  const ctx = new Context()
  class FakeAdb extends AdgEmulators {
    constructor(ctx: Context, config: Config) {
      super(ctx, config, exec, execBuffer)
    }
  }
  await ctx.plugin(FakeAdb, { dataDir: dir, sharedDir: dir })
  const emulators = ctx.get('adgEmulators') as unknown as AdgEmulators
  await emulators.configure({ manualAddress: '127.0.0.1:5555', adbPath: 'C:/adb/adb.exe' })
  assert.equal(await emulators.reconnect('127.0.0.1:5555', AbortSignal.timeout(5000)), '已重新连接 127.0.0.1:5555')
  assert.deepEqual(calls.filter(c => c.startsWith('C:/adb')), [
    'C:/adb/adb.exe disconnect 127.0.0.1:5555',
    'C:/adb/adb.exe connect 127.0.0.1:5555',
    'C:/adb/adb.exe -s 127.0.0.1:5555 shell echo adg-ok',
  ])
  assert.equal((await emulators.screencap('127.0.0.1:5555', AbortSignal.timeout(5000)))[0], 0x89)
})
