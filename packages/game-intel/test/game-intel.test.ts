import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GameManifest } from '@adg/pack-schema'
import { ManualClock } from '../../test-kit/src/clock.ts'
import { Calendar, DEFAULT_SETTINGS } from '../src/calendar.ts'
import { DailyReport } from '../src/daily.ts'
import { sameEvent } from '../src/names.ts'
import { buildReport, recentDigest } from '../src/report.ts'
import { parseAsk, parseSra, readSmw, smwQuery, type Fetch } from '../src/sources.ts'
import { leftText, parseDateText, parseRemaining, zonedTime } from '../src/time.ts'

const TZ = 'Asia/Shanghai'
/** 2026-10-20 09:00 in Shanghai. */
const NOW = zonedTime(2026, 10, 20, 9, 0, TZ)
const HOUR = 3_600_000
const DAY = 24 * HOUR

const arknights = GameManifest.parse({
  id: 'arknights', name: '明日方舟', scripts: ['maa'],
  sources: [{ id: 'prts', name: 'PRTS', smw: { api: 'https://prts.wiki/api.php', conditions: '[[分类:有活动信息的页面]]', title: '名称', start: '活动开始时间', end: '活动结束时间', shopEnd: '兑换结束时间', page: 'https://prts.wiki/w/{page}' } }],
})
const prts = arknights.sources[0]!.smw!
const starrailSmw = GameManifest.parse({
  id: 'starrail', name: '崩坏：星穹铁道',
  sources: [{ id: 'biligame', name: '星穹铁道 WIKI', smw: { api: 'https://wiki.biligame.com/sr/api.php', conditions: '[[分类:活动]]', start: '开始时间', end: '结束时间', dates: 'text' } }],
}).sources[0]!.smw!

const ts = (y: number, m: number, d: number, h: number, mi: number) => ({ timestamp: String(Date.UTC(y, m - 1, d, h, mi) / 1000), raw: `1/${y}/${m}/${d}/${h}/${mi}/0/0` })
/** As PRTS answers: dates are SMW dates in UTC. */
const PRTS_RESULTS = {
  恒远津梁: { printouts: { 名称: ['恒远津梁'], 活动开始时间: [ts(2026, 10, 16, 8, 0)], 活动结束时间: [ts(2026, 10, 29, 19, 59)], 兑换结束时间: [] } },
  昨日海: { printouts: { 名称: ['SideStory「昨日海」'], 活动开始时间: [ts(2026, 10, 9, 4, 0)], 活动结束时间: [ts(2026, 10, 22, 19, 59)], 兑换结束时间: [ts(2026, 10, 29, 19, 59)] } },
  '矢量突破/03': { printouts: { 名称: ['矢量突破#3「拟生态」'], 活动开始时间: [ts(2026, 9, 29, 8, 0)], 活动结束时间: [ts(2026, 10, 19, 19, 59)], 兑换结束时间: [ts(2026, 10, 22, 19, 59)] } },
  沉沦者的黑流树海: { printouts: { 名称: ['集成战略「沉沦者的黑流树海」'], 活动开始时间: [ts(2026, 7, 17, 8, 0)], 活动结束时间: [ts(2027, 3, 10, 8, 0)], 兑换结束时间: [] } },
  稳态测定: { printouts: { 名称: ['稳态测定签到活动'], 活动开始时间: [ts(2026, 9, 27, 20, 0)], 活动结束时间: [ts(2026, 10, 7, 19, 59)], 兑换结束时间: [] } },
}
/** As the Bilibili wiki answers: text in server time, 9999 for permanent. */
const SR_RESULTS = {
  '「位面分裂」第二十六期': { printouts: { 开始时间: ['2026/10/12 04:00'], 结束时间: ['2026/10/25 03:59'] }, fullurl: 'https://wiki.biligame.com/sr/x' },
  '「星际幻宠」乐园': { printouts: { 开始时间: ['2026/09/28 10:00'], 结束时间: ['2026/11/10 15:00'] } },
  '「幽府偃偶」': { printouts: { 开始时间: ['2024/06/19 10:00'], 结束时间: ['9999/01/01'] } },
}

test('remaining times and dates as games and wikis write them', () => {
  assert.equal(parseRemaining('剩余 3天12小时'), 3 * DAY + 12 * HOUR)
  assert.equal(parseRemaining('活动剩余：5天'), 5 * DAY)
  assert.equal(parseRemaining('12小时30分'), 12 * HOUR + 30 * 60_000)
  assert.equal(parseRemaining('3d 4h'), 3 * DAY + 4 * HOUR)
  assert.equal(parseRemaining('05:12:30'), 5 * HOUR + 12 * 60_000)
  assert.equal(parseRemaining('不足1小时'), 30 * 60_000)
  assert.equal(parseRemaining('即将结束'), undefined)
  assert.equal(parseDateText('2026/10/25 03:59', TZ, NOW), Date.UTC(2026, 9, 24, 19, 59))
  assert.equal(parseDateText('2026年10月25日', TZ, NOW), Date.UTC(2026, 9, 24, 16, 0))
  assert.equal(parseDateText('10/25 03:59', TZ, NOW), Date.UTC(2026, 9, 24, 19, 59), 'no year: this year')
  assert.equal(parseDateText('01/05 04:00', TZ, NOW), zonedTime(2027, 1, 5, 4, 0, TZ), 'no year in October: next January')
  assert.equal(parseDateText('9999/01/01', TZ, NOW), null, 'permanent')
  assert.equal(parseDateText('长期', TZ, NOW), null)
  assert.equal(parseDateText('下个版本', TZ, NOW), undefined)
  assert.equal(leftText(NOW + 2 * DAY + 5 * HOUR, NOW), '还剩 2 天')
  assert.equal(leftText(NOW + 5 * HOUR, NOW), '还剩 5 小时')
})

test('PRTS and Bilibili wiki answers become events; permanent and ended ones are left out', () => {
  const ak = parseAsk(PRTS_RESULTS, prts, TZ, NOW)
  assert.deepEqual(ak.map(e => e.name), ['矢量突破#3「拟生态」', 'SideStory「昨日海」', '恒远津梁', '集成战略「沉沦者的黑流树海」'], 'soonest end first; 稳态测定 ended')
  const ss = ak.find(e => e.name === 'SideStory「昨日海」')!
  assert.equal(ss.endsAt, Date.UTC(2026, 9, 22, 19, 59))
  assert.equal(ss.shopEndsAt, Date.UTC(2026, 9, 29, 19, 59))
  assert.deepEqual(ss.aliases, ['昨日海'])
  assert.equal(ss.url, 'https://prts.wiki/w/%E6%98%A8%E6%97%A5%E6%B5%B7')
  assert.ok(ak.some(e => e.name.startsWith('矢量突破')), 'the event ended but its shop is open')

  const sr = parseAsk(SR_RESULTS, starrailSmw, TZ, NOW)
  assert.deepEqual(sr.map(e => e.name), ['「位面分裂」第二十六期', '「星际幻宠」乐园'])
  assert.equal(sr[0]!.endsAt, zonedTime(2026, 10, 25, 3, 59, TZ))
  assert.equal(sr[0]!.url, 'https://wiki.biligame.com/sr/x')
  assert.deepEqual(parseAsk([], prts, TZ, NOW), [], 'SMW answers an empty result with []')
})

test('the ask query keeps events whose end or shop end is ahead, in the format the property is stored', () => {
  assert.equal(smwQuery(prts, '2026-10-19'), '[[分类:有活动信息的页面]][[活动结束时间::>2026-10-19]] OR [[分类:有活动信息的页面]][[兑换结束时间::>2026-10-19]]|?名称|?活动开始时间|?活动结束时间|?兑换结束时间|limit=100')
  assert.equal(smwQuery(starrailSmw, '2026/10/19'), '[[分类:活动]][[结束时间::>2026/10/19]]|?开始时间|?结束时间|limit=100')
})

test('a site is read page by page, and a failure says which site and why', async () => {
  const urls: string[] = []
  const pages = [
    { query: { results: { 恒远津梁: PRTS_RESULTS.恒远津梁 } }, 'query-continue-offset': 1 },
    { query: { results: { 昨日海: PRTS_RESULTS.昨日海 } } },
  ]
  const fake: Fetch = async url => { urls.push(url); const body = pages.shift(); return { ok: true, status: 200, json: async () => body } }
  const events = await readSmw(prts, arknights, NOW, fake)
  assert.equal(events.length, 2)
  assert.match(decodeURIComponent(urls[0]!), /action=ask&format=json&query=\[\[分类:有活动信息的页面\]\]\[\[活动结束时间::>2026-10-19\]\]/)
  assert.match(decodeURIComponent(urls[1]!), /\|offset=1$/)
  await assert.rejects(readSmw(prts, arknights, NOW, async () => ({ ok: false, status: 503, json: async () => ({}) })), /prts\.wiki 读不到：HTTP 503/)
  await assert.rejects(readSmw(prts, arknights, NOW, async () => ({ ok: true, status: 200, json: async () => ({ error: { info: 'bad query' } }) })), /不接受这个查询：bad query/)
})

test('names of one event in different spellings meet', () => {
  assert.ok(sameEvent(['SideStory「昨日海」', '昨日海'], ['昨日海']))
  assert.ok(sameEvent(['「位面分裂」第二十六期'], ['位面分裂 第二十六期']))
  assert.ok(!sameEvent(['「位面分裂」第二十六期'], ['「位面分裂」第二十七期']))
  assert.ok(!sameEvent(['恒远津梁'], ['昨日海']))
})

test('the calendar: site dates count, the screen adds progress, a disagreement is called out', async () => {
  const calendar = new Calendar(mkdtempSync(join(tmpdir(), 'adg-games-')))
  await calendar.load()
  await calendar.applySite('arknights', { id: 'prts', name: 'PRTS' }, parseAsk(PRTS_RESULTS, prts, TZ, NOW), NOW, TZ)
  assert.equal(calendar.list('arknights').length, 4)

  const written = await calendar.applyRead('arknights', 'screen', [
    { name: '昨日海', remaining: '剩余 2天10小时', todo: ['活动商店还剩 3 项没换'] },
    { name: '恒远津梁', remaining: '剩余 2天', todo: [] , done: ['关卡全部通关'] },
    { name: '危机合约', remaining: '剩余 6天' },
  ], { now: NOW, timeZone: TZ, sessionId: 's1', shot: 'shot:0123456789abcdef0123456789abcdef.png' })
  assert.deepEqual(written.map(w => w.matched), [true, true, false])
  const ss = calendar.list('arknights').find(a => a.name === 'SideStory「昨日海」')!
  assert.deepEqual(ss.todo, ['活动商店还剩 3 项没换'])
  assert.equal(ss.endsAt, Date.UTC(2026, 9, 22, 19, 59), 'still the site end')
  assert.equal(ss.screen?.evidence, true)
  assert.equal(ss.mismatch, undefined, '2天10小时 is close enough to the site end')
  const bridge = calendar.list('arknights').find(a => a.name === '恒远津梁')!
  assert.match(bridge.mismatch ?? '', /游戏里显示「剩余 2天」，PRTS 写的是 10\/30 03:59 结束（还剩 9 天），以 PRTS 为准/)
  const contract = calendar.list('arknights').find(a => a.name === '危机合约')!
  assert.equal(contract.endsAt, NOW + 6 * DAY, 'only on screen: its end comes from there')

  // Next day the site no longer lists 恒远津梁: it stays (seen on screen) but loses its site; 矢量突破 (never seen in game) goes.
  const later = NOW + DAY
  await calendar.applySite('arknights', { id: 'prts', name: 'PRTS' }, parseAsk({ 昨日海: PRTS_RESULTS.昨日海 }, prts, TZ, later), later, TZ)
  const names = calendar.list('arknights').map(a => a.name)
  assert.ok(names.includes('恒远津梁') && !names.some(n => n.startsWith('矢量突破')))
  assert.equal(calendar.list('arknights').find(a => a.name === '恒远津梁')?.site, undefined)

  // Saved and read back.
  const again = new Calendar(join(calendar.file, '..'))
  await again.load()
  assert.deepEqual(again.list(), calendar.list())
})

test('the daily report: by how soon each ends, with what is left to do', async () => {
  const calendar = new Calendar(mkdtempSync(join(tmpdir(), 'adg-games-')))
  await calendar.applySite('arknights', { id: 'prts', name: 'PRTS' }, parseAsk(PRTS_RESULTS, prts, TZ, NOW), NOW, TZ)
  await calendar.applyRead('arknights', 'screen', [{ name: '昨日海', remaining: '剩余 2天10小时', todo: ['活动商店还剩 3 项没换'] }], { now: NOW, timeZone: TZ })
  const games = [{ id: 'arknights', name: '明日方舟', timezone: TZ }, { id: 'starrail', name: '崩坏：星穹铁道', timezone: TZ }]
  const report = buildReport(games, calendar.list(), DEFAULT_SETTINGS.report, NOW)
  assert.match(report.title, /^今日活动日报（\d+月\d+日）$/)
  const lines = report.text.split('\n')
  assert.equal(lines[0], '【明日方舟】')
  assert.match(lines[1]!, /^· ⚠ 矢量突破#3「拟生态」：活动已结束，商店还剩 2 天/)
  assert.match(lines[2]!, /^· ⚠ SideStory「昨日海」：还剩 2 天（10\/23 03:59 结束），商店开到 10\/30 03:59 · 还没做：活动商店还剩 3 项没换$/)
  assert.match(lines[3]!, /^· 恒远津梁：还剩 9 天/)
  assert.equal(lines[4], '· 长期：集成战略「沉沦者的黑流树海」（还剩 141 天）', 'a season gets one line')
  assert.ok(!report.text.includes('星穹铁道'), 'a game without events is left out')
  assert.match(report.text, /活动时间来自 PRTS；进度是 agent .+ 在游戏里看到的。$/)
  assert.equal(report.count, 4)
  assert.match(buildReport(games, [], DEFAULT_SETTINGS.report, NOW).text, /今天没有进行中的活动/)
})

test('the AI report sees only recent events: ending soon and not done, just started, starting soon', async () => {
  const calendar = new Calendar(mkdtempSync(join(tmpdir(), 'adg-games-')))
  await calendar.applySite('arknights', { id: 'prts', name: 'PRTS' }, parseAsk(PRTS_RESULTS, prts, TZ, NOW), NOW, TZ)
  await calendar.applyRead('arknights', 'screen', [{ name: '昨日海', remaining: '剩余 2天10小时', todo: ['活动商店还剩 3 项没换'] }], { now: NOW, timeZone: TZ })
  const games = [{ id: 'arknights', name: '明日方舟', timezone: TZ }]
  const digest = recentDigest(games, calendar.list(), DEFAULT_SETTINGS.report, NOW) ?? ''
  assert.match(digest, /^【明日方舟】/)
  assert.match(digest, /昨日海」：快结束：还剩 2 天（10\/23 03:59）；还没做：活动商店还剩 3 项没换/)
  assert.match(digest, /拟生态」：活动已结束，商店还剩 2 天/)
  assert.ok(!digest.includes('集成战略') && !digest.includes('恒远津梁'), 'a season and a quiet mid-run event are not news')
  assert.equal(recentDigest(games, [], DEFAULT_SETTINGS.report, NOW), undefined)
})

test('the report goes out once a day at its time, late after a missed time, never in a failing loop', async () => {
  // 08:00 local on some day.
  const start = new Date(2026, 9, 20, 8, 0).getTime()
  const clock = new ManualClock(start)
  let lastDay: string | undefined
  const sent: string[] = []
  let fail = false
  const daily = new DailyReport({
    clock, at: () => '09:00', lastDay: () => lastDay,
    send: async day => { sent.push(day); if (fail) throw new Error('boom'); lastDay = day },
    log: { warn() {} },
  })
  daily.start()
  assert.equal(daily.next(), new Date(2026, 9, 20, 9, 0).getTime())
  clock.advance(HOUR - 1)
  assert.deepEqual(sent, [])
  clock.advance(1)
  await new Promise(r => setImmediate(r))
  assert.deepEqual(sent, ['2026-10-20'])
  assert.equal(daily.next(), new Date(2026, 9, 21, 9, 0).getTime())
  daily.start() // settings changed: no second report today
  await new Promise(r => setImmediate(r))
  assert.deepEqual(sent, ['2026-10-20'])

  // Started at 11:00 on a day the 09:00 report was missed: sent at once.
  const late = new ManualClock(new Date(2026, 9, 22, 11, 0).getTime())
  const lateSent: string[] = []
  new DailyReport({ clock: late, at: () => '09:00', lastDay: () => '2026-10-21', send: async day => { lateSent.push(day) }, log: { warn() {} } }).start()
  await new Promise(r => setImmediate(r))
  assert.deepEqual(lateSent, ['2026-10-22'])

  // A failing send is tried once, then waits for the next day.
  fail = true
  clock.advance(DAY)
  await new Promise(r => setImmediate(r))
  await new Promise(r => setImmediate(r))
  assert.deepEqual(sent, ['2026-10-20', '2026-10-21'])
  assert.equal(clock.pending, 1, 'one timer: tomorrow')
  daily.stop()
})

test('SRA public API: the version, and events still ahead with their kind and description, in server time', () => {
  const now = Date.UTC(2026, 9, 24, 12) // 2026-10-24 20:00 in Shanghai
  const body = {
    version: '1.6', versionName: '丹青渡', startTime: '2026-10-15T12:00:00', endTime: '2026-11-26T06:00:00',
    activities: [
      { name: '「丰碑留名·刻影」限时挑战', kind: '挑战活动', description: '完成挑战领取奖励', startTime: '2026-10-05T12:00:00', endTime: '2026-10-19T04:00:00', cover: '' },
      { name: '丹青渡·版本活动', kind: '版本活动', description: '', startTime: '2026-10-15T12:00:00', endTime: '2026-11-05T03:59:59' },
      { name: '没有结束时间', startTime: '2026-10-15T12:00:00' },
    ],
  }
  const read = parseSra(body, 'Asia/Shanghai', now)
  assert.deepEqual(read.version, { name: '1.6', title: '丹青渡', startsAt: Date.UTC(2026, 9, 15, 4), endsAt: Date.UTC(2026, 10, 25, 22) })
  assert.equal(read.events.length, 1, 'ended and undated ones are left out')
  assert.deepEqual(read.events[0], { name: '丹青渡·版本活动', aliases: [], endsAt: Date.UTC(2026, 10, 4, 19, 59), startsAt: Date.UTC(2026, 9, 15, 4), kind: '版本活动' })
  assert.deepEqual(parseSra('not json', 'Asia/Shanghai', now), { events: [], pools: [] })
  const pictured = parseSra({
    version: '4.6', cover: 'https://cdn.example/v.jpg',
    activities: [{ name: 'A', startTime: '2026-10-20T12:00:00', endTime: '2026-11-01T04:00:00', cover: 'http://insecure.example/a.jpg' }],
    pools: [
      { name: '万物更新', type: '特许寻访', upCharacters: ['祀'], startTime: '2026-10-15T12:00:00', endTime: '2026-11-05T12:00:00', cover: 'https://cdn.example/p.png' },
      { name: '旧卡池', type: '常驻', upCharacters: [], startTime: '2026-09-01T12:00:00', endTime: '2026-10-01T12:00:00' },
    ],
  }, 'Asia/Shanghai', now)
  assert.equal(pictured.version?.cover, 'https://cdn.example/v.jpg')
  assert.equal(pictured.events[0]?.cover, undefined, 'only https pictures')
  assert.deepEqual(pictured.pools, [{ name: '万物更新', type: '特许寻访', up: ['祀'], startsAt: Date.UTC(2026, 9, 15, 4), endsAt: Date.UTC(2026, 10, 5, 4), cover: 'https://cdn.example/p.png' }], 'ended banners are left out')
})

test('the built-in game packs parse, and SRA comes before the wikis so their dates have the last word', async () => {
  const { readFileSync } = await import('node:fs')
  const { parseGameManifest } = await import('@adg/pack-schema')
  for (const id of ['arknights', 'endfield', 'starrail']) {
    const manifest = parseGameManifest(readFileSync(new URL(`../../packs/games/${id}/game.yaml`, import.meta.url), 'utf8'))
    assert.equal(manifest.sources[0]?.sra?.api, 'https://starrailassistant.top/api/v1', id)
  }
})

test('progress the user keeps: ticking moves an item to done, finished marks the whole event, both survive a reload', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-progress-'))
  const calendar = new Calendar(dir)
  await calendar.applySite('endfield', { id: 'sra', name: 'SRA 公共 API' }, [{ name: '丹青渡·版本活动', aliases: [], endsAt: NOW + 10 * DAY }], NOW, TZ)
  const id = calendar.list('endfield')[0]!.id
  await calendar.progress(id, { todo: ['剧情通关', '商店换完', ' '] }, NOW)
  const ticked = await calendar.progress(id, { todo: ['剧情通关', '商店换完'], done: ['剧情通关'] }, NOW)
  assert.deepEqual([ticked?.todo, ticked?.done], [['商店换完'], ['剧情通关']], 'a ticked item is no longer to do')
  await calendar.progress(id, { finished: true }, NOW + HOUR)
  const again = new Calendar(dir)
  await again.load()
  assert.deepEqual(again.get(id)?.finished, { at: NOW + HOUR })
  await again.progress(id, { finished: false }, NOW)
  assert.equal(again.get(id)?.finished, undefined)
  assert.equal(await again.progress('endfield/none', { finished: true }, NOW), undefined)
})

test('following an SRA game without a pack, and stopping, which forgets its events', async () => {
  const { followedManifest, SRA_GAMES } = await import('../src/sra-games.ts')
  const ys = followedManifest(SRA_GAMES.find(g => g.sra === 'ys')!)
  assert.equal(ys.id, 'sra-ys')
  assert.equal(ys.sources[0]?.sra?.game, 'ys')
  const calendar = new Calendar(mkdtempSync(join(tmpdir(), 'adg-follow-')))
  await calendar.follow('ys', true, 'sra-ys')
  assert.deepEqual(calendar.settings.followed, ['ys'])
  await calendar.applySite('sra-ys', { id: 'sra', name: 'SRA 公共 API' }, [{ name: '海灯节', aliases: [], endsAt: NOW + DAY }], NOW, TZ)
  await calendar.follow('ys', false, 'sra-ys')
  assert.deepEqual([calendar.settings.followed, calendar.list('sra-ys')], [[], []])
})

test("the user's own events: added by hand, kept through refreshes, with no end until taken off", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-own-'))
  const calendar = new Calendar(dir)
  await assert.rejects(calendar.saveOwn({ game: 'endfield' }, { kind: '签到' }, NOW, TZ), /名字/)
  const added = await calendar.saveOwn({ game: 'endfield' }, { name: '周年庆签到', endsAt: NOW + 5 * DAY, kind: '签到', cover: 'own:0123456789abcdef0123456789abcdef.png', todo: ['每天签到'] }, NOW, TZ)
  assert.ok(added !== undefined)
  assert.equal(added.name, '周年庆签到')
  assert.deepEqual(added.own?.fields, ['name', 'endsAt', 'kind', 'cover'])
  assert.equal(added.sources, undefined)
  assert.deepEqual(added.todo, ['每天签到'])
  assert.deepEqual([...calendar.ownImages()], ['own:0123456789abcdef0123456789abcdef.png'])
  // A data site that does not list it does not drop it.
  await calendar.applySite('endfield', { id: 'sra', name: 'SRA 公共 API' }, [{ name: '丹青渡·版本活动', aliases: [], endsAt: NOW + 10 * DAY }], NOW, TZ)
  await calendar.applySite('endfield', { id: 'sra', name: 'SRA 公共 API' }, [], NOW + HOUR, TZ)
  assert.deepEqual(calendar.list('endfield').map(a => a.name), ['周年庆签到'])
  // No end: it stays past the time an undated reading is forgotten.
  const undated = await calendar.saveOwn({ game: 'endfield', id: added.id }, { endsAt: null }, NOW, TZ)
  assert.equal(undated?.endsAt, undefined)
  await calendar.applySite('endfield', { id: 'sra', name: 'SRA 公共 API' }, [], NOW + 30 * DAY, TZ)
  assert.equal(calendar.list('endfield').length, 1)
  // Same name again is the same event.
  const again = await calendar.saveOwn({ game: 'endfield' }, { name: '周年庆签到', description: '登录领奖励' }, NOW, TZ)
  assert.equal(again?.id, added.id)
  assert.equal(again?.description, '登录领奖励')
  const reloaded = new Calendar(dir)
  await reloaded.load()
  assert.equal(reloaded.get(added.id)?.description, '登录领奖励')
  // Taking it back: one only the user had goes, and so does its picture.
  assert.equal(await reloaded.resetOwn(added.id, TZ), undefined)
  assert.equal(reloaded.list('endfield').length, 0)
  assert.equal(reloaded.ownImages().size, 0)
})

test("the user's word on a site's event beats the site, survives a refresh, and can be taken back", async () => {
  const calendar = new Calendar(mkdtempSync(join(tmpdir(), 'adg-own-')))
  await calendar.applySite('arknights', { id: 'prts', name: 'PRTS' }, parseAsk(PRTS_RESULTS, prts, TZ, NOW), NOW, TZ)
  const event = calendar.list('arknights').find(a => a.name === '恒远津梁')!
  const siteEnd = event.endsAt!
  // The same name as the site's is not kept as the user's; the end and picture are.
  const edited = await calendar.saveOwn({ game: 'arknights', id: event.id }, { name: '恒远津梁', endsAt: siteEnd + 2 * DAY, cover: 'https://example.com/a.png' }, NOW, TZ)
  assert.deepEqual(edited?.own?.fields, ['endsAt', 'cover'])
  assert.equal(edited?.endsAt, siteEnd + 2 * DAY)
  assert.equal(edited?.mismatch, undefined)
  // A wrong id in another game is not found.
  assert.equal(await calendar.saveOwn({ game: 'starrail', id: event.id }, { kind: 'x' }, NOW, TZ), undefined)
  // Renamed by the user: the site still finds it by its own name, and does not take the name back.
  await calendar.saveOwn({ game: 'arknights', id: event.id }, { name: '津梁（我的）' }, NOW, TZ)
  await calendar.applySite('arknights', { id: 'prts', name: 'PRTS' }, parseAsk(PRTS_RESULTS, prts, TZ, NOW + HOUR), NOW + HOUR, TZ)
  const after = calendar.get(event.id)!
  assert.equal(after.name, '津梁（我的）')
  assert.equal(after.endsAt, siteEnd + 2 * DAY)
  assert.equal(calendar.list('arknights').filter(a => a.name.includes('津梁')).length, 1)
  // Taking back one field, then everything: the site's word shows again.
  const partly = await calendar.saveOwn({ game: 'arknights', id: event.id }, { endsAt: null }, NOW, TZ)
  assert.equal(partly?.endsAt, siteEnd)
  const back = await calendar.resetOwn(event.id, TZ)
  assert.equal(back?.name, '恒远津梁')
  assert.equal(back?.own, undefined)
  assert.equal(back?.cover, undefined)
})

test('an event with no picture shows the screenshot it was read from; a source or the user still wins', async () => {
  const calendar = new Calendar(mkdtempSync(join(tmpdir(), 'adg-shot-')))
  const SHOT = 'shot:0123456789abcdef0123456789abcdef.png'
  const LATER_SHOT = 'shot:fedcba9876543210fedcba9876543210.png'
  await calendar.applySite('endfield', { id: 'sra', name: 'SRA 公共 API' }, [
    { name: '有图的活动', aliases: [], endsAt: NOW + 5 * DAY, cover: 'https://example.com/art.png' },
    { name: '没图的活动', aliases: [], endsAt: NOW + 5 * DAY },
  ], NOW, TZ)
  await calendar.applyRead('endfield', 'screen', [{ name: '有图的活动', remaining: '5天' }, { name: '没图的活动', remaining: '5天' }, { name: '只在游戏里', remaining: '3天' }], { now: NOW, timeZone: TZ, shot: SHOT })
  const cover = (name: string) => calendar.list('endfield').find(a => a.name === name)?.cover
  assert.equal(cover('有图的活动'), 'https://example.com/art.png', "the site's picture first")
  assert.equal(cover('没图的活动'), SHOT)
  assert.equal(cover('只在游戏里'), SHOT)
  assert.deepEqual([...calendar.shotImages()], [SHOT])
  // Read again without a screenshot: no evidence this time, the last screenshot stays the picture.
  await calendar.applyRead('endfield', 'screen', [{ name: '没图的活动', remaining: '4天' }], { now: NOW + HOUR, timeZone: TZ })
  const again = calendar.list('endfield').find(a => a.name === '没图的活动')!
  assert.equal(again.screen?.evidence, false)
  assert.equal(again.cover, SHOT)
  // A newer screenshot replaces it; the user's picture beats it, and taking that back shows it again.
  await calendar.applyRead('endfield', 'screen', [{ name: '没图的活动', remaining: '4天' }], { now: NOW + 2 * HOUR, timeZone: TZ, shot: LATER_SHOT })
  assert.equal(cover('没图的活动'), LATER_SHOT)
  const id = again.id
  await calendar.saveOwn({ game: 'endfield', id }, { cover: 'own:00000000000000000000000000000000.png' }, NOW, TZ)
  assert.equal(cover('没图的活动'), 'own:00000000000000000000000000000000.png')
  await calendar.saveOwn({ game: 'endfield', id }, { cover: null }, NOW, TZ)
  assert.equal(cover('没图的活动'), LATER_SHOT)
  // Screenshots kept the old way (one file per event) are taken in as pictures.
  const old = calendar.list('endfield').find(a => a.name === '只在游戏里')!
  await calendar.adoptShots(new Map([[old.id, LATER_SHOT]]), () => TZ)
  assert.equal(cover('只在游戏里'), LATER_SHOT)
})
