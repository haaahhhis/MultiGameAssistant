import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GamesRequests } from '@adg/protocol'
import { Calendar } from '../src/calendar.ts'

const PICTURE = 'own:0123456789abcdef0123456789abcdef.png'
const OTHER = 'own:fedcba9876543210fedcba9876543210.webp'

test('a banner picture of the user\'s own is kept per game, survives a restart, and is let go on 恢复默认', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-banner-'))
  const calendar = new Calendar(dir)
  assert.equal(calendar.banner('starrail'), undefined, 'none chosen: the version\'s art')
  await calendar.setBanner('starrail', PICTURE)
  await calendar.setBanner('arknights', OTHER)
  assert.deepEqual([calendar.banner('starrail'), calendar.banner('arknights')], [PICTURE, OTHER])
  // The pictures stay on disk while a banner shows them (sweepImages keeps what ownImages names).
  assert.deepEqual([...calendar.ownImages()].sort(), [PICTURE, OTHER].sort())

  const reloaded = new Calendar(dir)
  await reloaded.load()
  assert.deepEqual([reloaded.banner('starrail'), reloaded.banner('arknights')], [PICTURE, OTHER], 'kept through a restart')

  await reloaded.setBanner('starrail', undefined)
  assert.equal(reloaded.banner('starrail'), undefined, 'back to the default')
  assert.equal(reloaded.banner('arknights'), OTHER, 'the other game keeps its own')
  assert.deepEqual([...reloaded.ownImages()], [OTHER], 'the old picture can be swept')

  // A game made here and deleted takes its banner along.
  await reloaded.forget('arknights')
  const again = new Calendar(dir)
  await again.load()
  assert.deepEqual([again.banner('starrail'), again.banner('arknights'), [...again.ownImages()]], [undefined, undefined, []])
})

test('only a picture the host keeps can be a banner; a bad value in the file loses nothing else', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-banner-'))
  const calendar = new Calendar(dir)
  await assert.rejects(calendar.setBanner('starrail', 'https://example.com/a.png'), /不是用户添加的图片/)
  await assert.rejects(calendar.setBanner('starrail', 'own:../../secret.png'), /不是用户添加的图片/)
  await calendar.hide('arknights', true)
  // Written by hand (or an older build): an odd value is not shown, the rest of the file still loads.
  const saved = JSON.parse(readFileSync(calendar.file, 'utf8'))
  saved.settings.banners = { starrail: 'C:/Users/x/pic.png' }
  writeFileSync(calendar.file, JSON.stringify(saved))
  const reloaded = new Calendar(dir)
  await reloaded.load()
  assert.deepEqual([reloaded.banner('starrail'), reloaded.settings.hidden, [...reloaded.ownImages()]], [undefined, ['arknights'], []])
})

test('games/banner/set takes the picture\'s bytes, a picked file\'s path, or neither (恢复默认) — not both', () => {
  const params = GamesRequests['games/banner/set'].params
  assert.ok(params.safeParse({ game: 'starrail' }).success, 'neither: the default again')
  assert.ok(params.safeParse({ game: 'starrail', path: 'C:\\Pictures\\bg.png' }).success)
  assert.ok(params.safeParse({ game: 'starrail', image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' } }).success)
  assert.ok(!params.safeParse({ game: 'starrail', path: 'C:\\a.png', image: { mediaType: 'image/png', data: 'iVBORw0KGgo=' } }).success, 'not both')
  assert.ok(!params.safeParse({ game: 'starrail', image: { mediaType: 'image/png', data: 'data:image/png;base64,iVBORw0KGgo=' } }).success, 'no data: prefix')
  assert.ok(!params.safeParse({ game: 'starrail', image: { mediaType: 'text/html', data: 'PGI+' } }).success, 'pictures only')
  assert.ok(!params.safeParse({ game: '' }).success)
})
