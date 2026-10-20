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
import { buildReport } from '../src/report.ts'
import { parseAsk, readSmw, smwQuery, type Fetch } from '../src/sources.ts'
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
  ], { now: NOW, timeZone: TZ, sessionId: 's1', evidence: async () => true })
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
