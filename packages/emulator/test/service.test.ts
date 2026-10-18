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
  assert.deepEqual(await service.prepare({ signal: AbortSignal.timeout(5000), onStatus: () => {} }), { address: '127.0.0.1:5555', label: '手动配置的 ADB 地址' })
  assert.equal((await emulators.status()).selection.address, '127.0.0.1:5555')
})
