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
