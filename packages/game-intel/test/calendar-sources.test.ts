import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { OWN_SOURCE, SCREEN_SOURCE } from '@adg/protocol'
import { Calendar } from '../src/calendar.ts'
import { MS } from '../src/time.ts'
import { gameTools, type GameToolDeps } from '../src/tools.ts'

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

const SHOT = 'shot:0123456789abcdef0123456789abcdef.png'
const OWN = 'own:0123456789abcdef0123456789abcdef.png'
const PRTS = { id: 'prts', name: 'PRTS' }
const A = { startsAt: NOW - 3 * MS.DAY, endsAt: NOW + 5 * MS.DAY }
const B = { startsAt: NOW - MS.DAY, endsAt: NOW + 9 * MS.DAY, shopEndsAt: NOW + 12 * MS.DAY }

/** One event, as two data sites (the second with a picture) and the game screen tell it. */
async function twoSites(): Promise<{ calendar: Calendar; id: string }> {
  const calendar = fresh()
  await calendar.applySite('ak', SRA, [{ name: '活动', aliases: [], ...A }], NOW, TZ)
  await calendar.applySite('ak', PRTS, [{ name: '活动', aliases: [], ...B, cover: 'https://prts.example/a.png' }], NOW + 1, TZ)
  await calendar.applyRead('ak', 'screen', [{ name: '活动', remaining: '2天' }], { now: NOW, timeZone: TZ, shot: SHOT })
  return { calendar, id: calendar.list('ak')[0]!.id }
}

test('a picture goes by rank: what the user set, then a source, then the agent\'s screenshot', async () => {
  const calendar = fresh()
  await calendar.applyRead('ak', 'screen', [{ name: '活动', remaining: '2天' }], { now: NOW, timeZone: TZ, shot: SHOT })
  const id = calendar.list('ak')[0]!.id
  const rank = () => { const a = calendar.get(id)!; return [a.cover, a.shown?.cover] }
  assert.deepEqual(rank(), [SHOT, SCREEN_SOURCE], 'only the screenshot')
  await calendar.applySite('ak', SRA, [{ name: '活动', aliases: [], endsAt: NOW + MS.DAY, cover: 'https://sra.example/a.png' }], NOW, TZ)
  assert.deepEqual(rank(), ['https://sra.example/a.png', 'sra'], 'a source beats the screenshot')
  await calendar.saveOwn({ game: 'ak', id }, { cover: OWN }, NOW, TZ)
  assert.deepEqual(rank(), [OWN, OWN_SOURCE], 'the user beats the source')
  // A later screenshot and a later refresh do not change that.
  await calendar.applyRead('ak', 'screen', [{ name: '活动', remaining: '1天' }], { now: NOW + 1, timeZone: TZ, shot: 'shot:fedcba9876543210fedcba9876543210.png' })
  await calendar.applySite('ak', SRA, [{ name: '活动', aliases: [], endsAt: NOW + MS.DAY, cover: 'https://sra.example/b.png' }], NOW + 2, TZ)
  assert.deepEqual(rank(), [OWN, OWN_SOURCE])
  await calendar.saveOwn({ game: 'ak', id }, { cover: null }, NOW, TZ)
  assert.deepEqual(rank(), ['https://sra.example/b.png', 'sra'])
})

test('the agent\'s screenshot kept with setShot stays below a source\'s picture', async () => {
  const { calendar, id } = await twoSites()
  await calendar.setShot(id, 'shot:fedcba9876543210fedcba9876543210.png', { now: NOW, timeZone: TZ })
  const a = calendar.get(id)!
  assert.equal(a.cover, 'https://prts.example/a.png')
  assert.equal(a.own, undefined, 'it is not the user\'s word')
  assert.deepEqual([...calendar.shotImages()], ['shot:fedcba9876543210fedcba9876543210.png'])
})

test('choosing a source switches the picture and the dates; a refresh keeps the choice', async () => {
  const { calendar, id } = await twoSites()
  let a = calendar.get(id)!
  assert.equal(a.chosen, undefined)
  assert.equal(a.endsAt, B.endsAt, 'by default the data site that wrote last')
  assert.match(a.mismatch ?? '', /游戏里显示/, 'the screen disagrees')
  assert.deepEqual(a.sources?.find(s => s.id === 'sra'), { id: 'sra', name: 'SRA 公共 API', at: NOW, web: false, ...A }, 'each source says what it says')

  a = (await calendar.chooseSource(id, 'sra', TZ))!
  assert.equal(a.chosen, 'sra')
  assert.deepEqual([a.startsAt, a.endsAt, a.shown?.startsAt, a.shown?.endsAt], [A.startsAt, A.endsAt, 'sra', 'sra'])
  assert.equal(a.cover, 'https://prts.example/a.png', 'it has no picture: the next by rank')
  assert.equal(a.shopEndsAt, B.shopEndsAt, 'nor a shop: the default')
  assert.equal(a.mismatch, undefined, 'the user chose: no "this one counts"')
  assert.ok(calendar.pictures().has('https://prts.example/a.png'))

  await calendar.applySite('ak', SRA, [{ name: '活动', aliases: [], startsAt: A.startsAt, endsAt: A.endsAt + MS.DAY }], NOW + 2, TZ)
  a = calendar.get(id)!
  assert.equal(a.chosen, 'sra')
  assert.equal(a.endsAt, A.endsAt + MS.DAY, 'follows what the chosen source says now')

  a = (await calendar.chooseSource(id, SCREEN_SOURCE, TZ))!
  assert.equal(a.cover, SHOT, 'a screenshot, when that is what the user picked')
  assert.equal(a.startsAt, A.startsAt, 'the screen gives no start: the default (SRA wrote last now)')

  a = (await calendar.chooseSource(id, null, TZ))!
  assert.equal(a.chosen, undefined)
  assert.equal(a.endsAt, A.endsAt + MS.DAY)
  assert.equal(a.cover, 'https://prts.example/a.png')
  await assert.rejects(calendar.chooseSource(id, 'nobody', TZ), /没有这个来源/)
})

test('the user\'s own word is a source too, and an edit shows over a chosen one without moving the rest', async () => {
  const { calendar, id } = await twoSites()
  await calendar.saveOwn({ game: 'ak', id }, { cover: OWN, endsAt: NOW + 20 * MS.DAY }, NOW, TZ)
  let a = calendar.get(id)!
  assert.deepEqual([a.cover, a.endsAt, a.own?.endsAt, a.own?.cover], [OWN, NOW + 20 * MS.DAY, NOW + 20 * MS.DAY, OWN])
  assert.equal(a.chosen, undefined, 'the default order puts the user first')

  // Choosing a source shows it over what the user wrote, which stays kept.
  a = (await calendar.chooseSource(id, 'prts', TZ))!
  assert.deepEqual([a.cover, a.endsAt], ['https://prts.example/a.png', B.endsAt])
  assert.equal(a.own?.cover, OWN)
  assert.ok(calendar.ownImages().has(OWN), 'the picture is not swept while it can be switched back to')

  // A new picture shows at once; the dates stay the chosen source's, and a rename brings nothing back.
  const NEW = 'own:fedcba9876543210fedcba9876543210.png'
  a = (await calendar.saveOwn({ game: 'ak', id }, { cover: NEW, name: '我的活动' }, NOW + 3, TZ))!
  assert.deepEqual([a.chosen, a.cover, a.shown?.cover, a.endsAt, a.name], ['prts', NEW, OWN_SOURCE, B.endsAt, '我的活动'])

  a = (await calendar.chooseSource(id, OWN_SOURCE, TZ))!
  assert.deepEqual([a.chosen, a.cover, a.endsAt], [OWN_SOURCE, NEW, NOW + 20 * MS.DAY])

  // Taking the user's word back ends a choice of it.
  a = (await calendar.resetOwn(id, TZ))!
  assert.equal(a.chosen, undefined)
  assert.equal(a.own, undefined)
  assert.equal(a.endsAt, B.endsAt)
})

test('a chosen source that stops listing the event is no choice; it counts again when it comes back', async () => {
  const { calendar, id } = await twoSites()
  await calendar.chooseSource(id, 'sra', TZ)
  await calendar.applySite('ak', SRA, [], NOW + 2, TZ)
  let a = calendar.get(id)!
  assert.equal(a.chosen, undefined)
  assert.equal(a.endsAt, B.endsAt)
  await calendar.applySite('ak', SRA, [{ name: '活动', aliases: [], ...A }], NOW + 3, TZ)
  a = calendar.get(id)!
  assert.equal(a.chosen, 'sra')
  assert.equal(a.endsAt, A.endsAt)
})

test('the choice survives a restart, and an older calendar is worked out again on load', async () => {
  const { calendar, id } = await twoSites()
  await calendar.chooseSource(id, 'sra', TZ)
  const dir = calendar.file.replace(/[\\/]calendar\.json$/, '')
  const reloaded = new Calendar(dir)
  await reloaded.load()
  assert.equal(reloaded.get(id)?.chosen, 'sra')
  assert.equal(reloaded.get(id)?.endsAt, A.endsAt)

  // Saved by a version that kept no `shown`, with a screenshot above a source's picture.
  const saved = JSON.parse(readFileSync(calendar.file, 'utf8')) as { activities: Array<Record<string, unknown>> }
  for (const item of saved.activities) { delete item['shown']; delete item['chosen']; item['cover'] = SHOT }
  writeFileSync(calendar.file, JSON.stringify(saved))
  const old = new Calendar(dir)
  await old.load()
  await old.rederive(() => TZ)
  assert.equal(old.get(id)?.cover, 'https://prts.example/a.png')
  assert.equal(old.get(id)?.shown?.cover, 'prts')
})

test('an unreadable calendar is not overwritten by working it out again', async () => {
  const calendar = fresh()
  writeFileSync(calendar.file, '{ not json')
  await calendar.load()
  await calendar.rederive(() => TZ)
  assert.equal(readFileSync(calendar.file, 'utf8'), '{ not json')
})

test('the agent chooses a source by its id, or own, screen or default', async () => {
  const { calendar, id } = await twoSites()
  const saves: unknown[] = []
  const save = gameTools({
    games: () => [{ id: 'ak', name: '方舟', aliases: [], timezone: TZ }],
    now: () => NOW,
    chooseSource: async (activity: string, source: string | null) => (await calendar.chooseSource(activity, source, TZ))!,
    saveActivity: async (...args: unknown[]) => { saves.push(args); return calendar.get(id)! },
  } as unknown as GameToolDeps).find(t => t.name === 'game_activity_save')!
  const run = (args: Record<string, unknown>) => save.execute({ game: 'ak', ...args }, {} as never) as unknown as Promise<{ saved: { dates_from: string; chosen_by_user?: string; sources?: Array<{ id: string; ends?: string }> } }>

  const picked = await run({ id, use_source: 'sra' })
  assert.equal(picked.saved.chosen_by_user, 'SRA 公共 API')
  assert.equal(picked.saved.dates_from, 'SRA 公共 API')
  assert.deepEqual(picked.saved.sources?.map(s => s.id), ['sra', 'prts'], 'the ids it can choose from')
  assert.equal(saves.length, 0, 'choosing is not the user writing anything')
  assert.equal((await run({ id, use_source: 'screen' })).saved.chosen_by_user, '游戏画面')
  assert.equal((await run({ id, use_source: 'default' })).saved.chosen_by_user, undefined)
  await assert.rejects(run({ name: '新活动', use_source: 'sra' }), /要和 id 一起用/)
  await assert.rejects(run({ id }), /没有要改的内容/)
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
