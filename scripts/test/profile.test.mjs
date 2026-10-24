import { strict as assert } from 'node:assert'
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ensureLink } from '../../apps/desktop/profile.mjs'

function sandbox() {
  const dir = mkdtempSync(join(tmpdir(), 'adg-link-'))
  const make = name => {
    const target = join(dir, name)
    mkdirSync(target)
    writeFileSync(join(target, 'sentinel.txt'), name)
    return target
  }
  return { dir, make }
}

test('creating, keeping and re-pointing a link never touches link targets', () => {
  const { dir, make } = sandbox()
  const a = make('a')
  const b = make('b')
  const link = join(dir, 'link')
  ensureLink(a, link)
  assert.equal(readFileSync(join(link, 'sentinel.txt'), 'utf8'), 'a')
  ensureLink(a, link) // already correct: no-op
  ensureLink(b, link) // re-point: only the link entry is replaced
  assert.equal(readFileSync(join(link, 'sentinel.txt'), 'utf8'), 'b')
  assert.ok(existsSync(join(a, 'sentinel.txt')), 'old target must survive')
  assert.ok(existsSync(join(b, 'sentinel.txt')), 'new target must survive')
})

test('a real directory at the link path is refused, not deleted', () => {
  const { dir, make } = sandbox()
  const a = make('a')
  const real = make('real')
  assert.throws(() => ensureLink(a, real), /not a link/)
  assert.ok(existsSync(join(real, 'sentinel.txt')))
})

test('a profile left half-made by an earlier start is moved aside and made again; a failure says why', async () => {
  const { prepareAdgProfile } = await import('../../apps/desktop/profile.mjs')
  const { readdirSync } = await import('node:fs')
  const { fileURLToPath } = await import('node:url')
  const root = fileURLToPath(new URL('../..', import.meta.url))
  const dshBin = join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js')
  const bundleDir = join(root, 'packages', 'bundle')
  const home = mkdtempSync(join(tmpdir(), 'adg-profile-'))
  mkdirSync(join(home, 'profiles', 'adg'), { recursive: true }) // no package.json: an earlier start stopped half-way
  const profile = prepareAdgProfile({ home, bundleDir, dshBin, env: { ADG_WORKSPACE_DIR: join(home, 'ws') } })
  assert.ok(existsSync(join(profile, 'package.json')))
  assert.ok(readdirSync(join(home, 'profiles')).some(n => n.startsWith('adg.unfinished-')), 'the half-made one is kept aside')
  assert.throws(() => prepareAdgProfile({ home: mkdtempSync(join(tmpdir(), 'adg-profile-')), bundleDir, dshBin: join(home, 'missing.js') }), /创建 dsh 配置.*失败：.*(Cannot find module|missing\.js)/s)
})
