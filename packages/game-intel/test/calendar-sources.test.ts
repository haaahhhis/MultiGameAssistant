import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { Calendar } from '../src/calendar.ts'
import { MS } from '../src/time.ts'

const TZ = 'Asia/Shanghai'
const NOW = Date.UTC(2026, 9, 20, 4)
const SRA = { id: 'sra', name: 'SRA 公共 API' }

function fresh(): Calendar {
  return new Calendar(mkdtempSync(join(tmpdir(), 'adg-cal-sources-')))
}

test('what the agent read on a web page survives a refresh, and one that no longer lists it', async () => {
  const calendar = fresh()
  // The agent read the announcement: an event the API does not have, and one it has under a longer name.
  await calendar.applyRead('sr', 'site', [
    { name: '星火燎原', startsAt: '2026-10-18 10:00', endsAt: '2026-11-08 03:59', url: 'https://sr.example.com/news/1', cover: 'https://sr.example.com/1.png' },
    { name: '花藏繁生', endsAt: '2026-11-01 03:59', url: 'https://sr.example.com/news/2' },
  ], { now: NOW, timeZone: TZ })

  // The API lists 花藏繁生 (loosely: inside a longer name), with its own end, and not 星火燎原.
  await calendar.applySite('sr', SRA, [{ name: '活动「花藏繁生」', aliases: [], endsAt: NOW + 10 * MS.DAY }], NOW + MS.HOUR, TZ)
  let list = calendar.list('sr')
  assert.deepEqual(list.map(a => a.name).sort(), ['星火燎原', '活动「花藏繁生」'].sort(), 'both kept')
  const flower = list.find(a => a.name === '活动「花藏繁生」')!
  assert.equal(flower.url, 'https://sr.example.com/news/2', 'the page the agent read is still its link')
  assert.equal(flower.endsAt, NOW + 10 * MS.DAY, 'the API\'s date counts')
  assert.deepEqual(flower.sources?.map(s => s.id).sort(), ['agent', 'sra'])
  assert.match(flower.mismatch ?? '', /agent 查到的网页.*SRA 公共 API/, 'the two dates differ by days: said so')

  // A later refresh no longer lists 花藏繁生: what the agent read stays, with its own dates.
  await calendar.applySite('sr', SRA, [], NOW + 2 * MS.HOUR, TZ)
  list = calendar.list('sr')
  assert.deepEqual(list.map(a => a.name).sort(), ['星火燎原', '活动「花藏繁生」'].sort())
  const left = list.find(a => a.name === '活动「花藏繁生」')!
  assert.deepEqual(left.sources?.map(s => s.id), ['agent'])
  assert.equal(left.endsAt, Date.UTC(2026, 9, 31, 19, 59), 'back to the date the agent read (11-01 03:59 in Shanghai)')
  assert.equal(left.mismatch, undefined)
  const fire = list.find(a => a.name === '星火燎原')!
  assert.equal(fire.cover, 'https://sr.example.com/1.png')
  assert.equal(fire.site?.source, 'agent')
})

test('a refresh still drops what only it listed, and an API event takes no agent entry whose dates do not overlap', async () => {
  const calendar = fresh()
  await calendar.applySite('sr', SRA, [{ name: '模拟宇宙', aliases: [], endsAt: NOW + 3 * MS.DAY }], NOW, TZ)
  // The agent read next season's 模拟宇宙 page: its dates do not overlap, so a different event.
  await calendar.applyRead('sr', 'site', [{ name: '模拟宇宙 第二季', startsAt: '2026-11-15 10:00', endsAt: '2026-12-31 03:59' }], { now: NOW, timeZone: TZ })
  assert.equal(calendar.list('sr').length, 2)
  // The next refresh lists 模拟宇宙 again: it does not take the agent's entry either.
  await calendar.applySite('sr', SRA, [{ name: '模拟宇宙', aliases: [], endsAt: NOW + 3 * MS.DAY }], NOW + MS.HOUR, TZ)
  assert.equal(calendar.list('sr').length, 2)
  await calendar.applySite('sr', SRA, [], NOW + 2 * MS.HOUR, TZ)
  assert.deepEqual(calendar.list('sr').map(a => a.name), ['模拟宇宙 第二季'], 'the API-only event went with the API; the agent\'s stayed')
})

test('a page the user added is its own source; reading it again replaces only what that page said', async () => {
  const calendar = fresh()
  await calendar.applyRead('sr', 'site', [{ name: '星火燎原', endsAt: '2026-11-08 03:59' }], { now: NOW, timeZone: TZ, source: { id: 'link-1', name: '米游社' } })
  await calendar.applyRead('sr', 'site', [{ name: '星火燎原', endsAt: '2026-11-09 03:59' }], { now: NOW, timeZone: TZ })
  const item = calendar.list('sr')[0]!
  assert.deepEqual(item.sources?.map(s => [s.id, s.name]), [['link-1', '米游社'], ['agent', 'agent 查到的网页']])
  assert.equal(item.endsAt, Date.UTC(2026, 10, 8, 19, 59), 'the newer reading counts among pages')
})

test('a calendar saved before sources were kept is read with what it had', async () => {
  const calendar = fresh()
  writeFileSync(calendar.file, JSON.stringify({ activities: [
    { id: 'sr/a', game: 'sr', name: 'A', names: ['A'], endsAt: NOW + MS.DAY, url: 'https://x/a', site: { source: 'agent', name: 'agent 查到的网页', at: NOW }, todo: [], done: [] },
    { id: 'sr/b', game: 'sr', name: 'B', names: ['B'], endsAt: NOW + 2 * MS.DAY, site: { source: 'sra', name: 'SRA 公共 API', at: NOW }, todo: [], done: [] },
  ] }))
  await calendar.load()
  await calendar.applySite('sr', SRA, [], NOW + MS.HOUR, TZ)
  assert.deepEqual(calendar.list('sr').map(a => a.name), ['A'], 'the agent\'s survived; the API\'s went')
  assert.match(readFileSync(calendar.file, 'utf8'), /"facts"/)
})
