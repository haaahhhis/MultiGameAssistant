import { strict as assert } from 'node:assert'
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { gameKeywords, locateGame, type GameProbe } from '../src/locate.ts'

const none: GameProbe = { running: [], entries: [], shortcuts: [] }
const make = (path: string) => { mkdirSync(join(path, '..'), { recursive: true }); writeFileSync(path, 'MZ') }

test('a program Windows noted (run before, App Paths, the search index) is found by its file name', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-locate-'))
  const game = join(dir, 'Star Rail Games', 'StarRail.exe')
  make(game)
  const found = await locateGame({
    exe: 'StarRail.exe', keywords: ['星穹铁道'], roots: [],
    probe: async () => ({ ...none, known: [{ path: game, source: '以前运行过' }, { path: join(dir, 'gone', 'StarRail.exe'), source: 'Windows 搜索' }, { path: join(dir, 'Other.exe'), source: 'App Paths' }] }),
  })
  assert.deepEqual(found, [{ path: game, source: '以前运行过' }])
})

test('a folder a launcher noted is searched, and so are the folders beside a launcher a shortcut opens', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-locate-'))
  const noted = join(dir, 'D', 'Endfield Game', 'Game', 'Endfield.exe')
  make(noted)
  const byNote = await locateGame({ exe: 'Endfield.exe', keywords: ['Endfield'], roots: [], probe: async () => ({ ...none, installs: [join(dir, 'D', 'Endfield Game')] }) })
  assert.equal(byNote[0]?.path, noted)

  // HoYoPlay\launcher\launcher.exe is what the shortcut opens; the game is in HoYoPlay\games\….
  const beside = join(dir, 'HoYoPlay', 'games', 'Star Rail Game', 'StarRail.exe')
  make(beside)
  make(join(dir, 'HoYoPlay', 'launcher', 'launcher.exe'))
  const byShortcut = await locateGame({
    exe: 'StarRail.exe', keywords: gameKeywords({ name: '崩坏：星穹铁道', pc: { process: 'StarRail.exe', keywords: ['HoYoPlay'] } }), roots: [],
    probe: async () => ({ ...none, shortcuts: [{ name: '崩坏：星穹铁道', target: join(dir, 'HoYoPlay', 'launcher', 'launcher.exe') }] }),
  })
  assert.equal(byShortcut[0]?.path, beside)
})
