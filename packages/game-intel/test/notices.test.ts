import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { ReportedArticles } from '../src/web-delivery.ts'
import { GameManifest } from '@adg/pack-schema'
import { Calendar } from '../src/calendar.ts'
import { parseSteam, readSteam, type Fetch } from '../src/sources.ts'
import { MS } from '../src/time.ts'
import { gameTools, type GameToolDeps } from '../src/tools.ts'

const NOW = Date.UTC(2026, 10, 19, 4)
const STEAM = { id: 'steam', name: 'Steam 官方公告' }

/** As Steam's GetNewsForApp answers (fields it gives that are not read are left in). */
const STEAM_NEWS = {
  appnews: {
    appid: 2868840,
    newsitems: [
      {
        gid: '1', title: 'Major Update #3 - v0.111.1', url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1',
        is_external_url: true, author: 'dev', feedlabel: 'Community Announcements', feedname: 'steam_community_announcements', feed_type: 1, appid: 2868840,
        contents: '[img src="{STEAM_CLAN_IMAGE}/45063247/a1b2.png"][/img]Hello [b]Slayers[/b]!<br>New relics &amp; a [url=https://x.test]rebalanced[/url] Act 2.',
        date: 1763500000, tags: ['patchnotes'],
      },
      {
        gid: '2', title: 'Hotfix 0.110.4', url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/2',
        contents: '[p]Hi folks,[/p][p][/p][p]A small update.[/p][list][*][p]Fixed a crash[/p][/list]', date: 1763000000,
      },
      {
        gid: '3', title: 'Join us at the winter showcase', url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/3',
        contents: '[img]{STEAM_CLAN_IMAGE}/45063247/c3d4.jpg[/img]' + 'x'.repeat(400), date: 1762000000, tags: [],
      },
      { gid: '4', title: '   ', contents: 'no title', date: 1761000000 },
      { gid: '5', title: 'May Bug Fixes', url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/5', contents: '', date: 1760000000 },
    ],
    count: 5,
  },
}

function fresh(): Calendar {
  return new Calendar(mkdtempSync(join(tmpdir(), 'adg-cal-notices-')))
}

test('Steam\'s news become announcements: patch notes and update titles are updates, with the version, a plain summary and the picture', () => {
  const read = parseSteam(STEAM_NEWS)
  assert.deepEqual(read.map(n => n.title), ['Major Update #3 - v0.111.1', 'Hotfix 0.110.4', 'Join us at the winter showcase', 'May Bug Fixes'], 'one without a title is left out')
  const [major, hotfix, showcase, fixes] = read
  assert.equal(fixes!.kind, 'update', 'bug fixes are an update')
  assert.equal(fixes!.summary, undefined, 'no text, no summary')
  assert.equal(major!.kind, 'update', 'tagged patchnotes')
  assert.equal(major!.version, 'v0.111.1')
  assert.equal(major!.publishedAt, 1763500000 * 1000)
  assert.equal(major!.cover, 'https://clan.akamai.steamstatic.com/images/45063247/a1b2.png')
  assert.equal(major!.summary, 'Hello Slayers ! New relics & a rebalanced Act 2.')
  assert.equal(hotfix!.kind, 'update', 'a hotfix by its title, with no tags')
  assert.equal(hotfix!.version, '0.110.4')
  assert.equal(hotfix!.summary, 'Hi folks, A small update. Fixed a crash', 'paragraphs and list items stay apart')
  assert.equal(showcase!.kind, 'notice')
  assert.equal(showcase!.version, undefined)
  assert.equal(showcase!.cover, 'https://clan.akamai.steamstatic.com/images/45063247/c3d4.jpg', 'the older [img]…[/img] form too')
  assert.ok(showcase!.summary!.length <= 241 && showcase!.summary!.endsWith('…'), 'a long text is cut')
  assert.throws(() => parseSteam({ error: 'nope' }), /appnews/)
})

test('readSteam asks Steam for the game\'s own announcements only, and says when the app has none', async () => {
  const asked: string[] = []
  const ok: Fetch = async url => { asked.push(String(url)); return new Response(JSON.stringify(STEAM_NEWS), { status: 200 }) }
  assert.equal((await readSteam({ appid: 2868840 }, ok)).length, 4)
  assert.match(asked[0]!, /GetNewsForApp\/v2\/\?appid=2868840&/)
  assert.match(asked[0]!, /feeds=steam_community_announcements/)
  const missing: Fetch = async () => new Response('', { status: 403 })
  await assert.rejects(readSteam({ appid: 1 }, missing), /Steam 上没有 app 1 的新闻/)
})

test('a game pack can name its Steam app and say it is single-player; only one kind of site per source', () => {
  const manifest = GameManifest.parse({ id: 'sts2', name: '杀戮尖塔2', single: true, sources: [{ id: 'steam', name: 'Steam 官方公告', steam: { appid: 2868840 } }] })
  assert.equal(manifest.single, true)
  assert.equal(manifest.sources[0]!.steam?.appid, 2868840)
  assert.throws(() => GameManifest.parse({ id: 'x', name: 'X', sources: [{ id: 's', name: 'S', steam: { appid: 1 }, sra: { game: 'sr' } }] }))
})

test('announcements are kept per game: the same one is brought up to date, long-term ones first, the newest 40 besides', async () => {
  const calendar = fresh()
  await calendar.load()
  const first = await calendar.applyNotices('sts2', STEAM, parseSteam(STEAM_NEWS), NOW)
  assert.equal(first.length, 4)
  assert.ok(calendar.pictures().has('https://clan.akamai.steamstatic.com/images/45063247/a1b2.png'), 'its pictures can be shown (games/image)')
  assert.deepEqual(calendar.notices('sts2').map(n => n.title), ['Major Update #3 - v0.111.1', 'Hotfix 0.110.4', 'Join us at the winter showcase', 'May Bug Fixes'], 'newest first')

  // Read again with a new summary: the same entry (by its address), the same id; what it no longer says is kept.
  const id = first[0]!.id
  await calendar.applyNotices('sts2', STEAM, [{ title: 'Major Update #3 - v0.111.1 (updated)', kind: 'update', url: 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/1?l=schinese', summary: '新遗物' }], NOW + MS.HOUR)
  const again = calendar.notices('sts2')
  assert.equal(again.length, 4, 'not a second one')
  const major = again.find(n => n.id === id)!
  assert.equal(major.title, 'Major Update #3 - v0.111.1 (updated)')
  assert.equal(major.summary, '新遗物')
  assert.equal(major.version, 'v0.111.1', 'kept from before')
  assert.equal(major.at, NOW + MS.HOUR)

  // A long-term notice goes first however old; lasting=false takes that back.
  await calendar.applyNotices('sts2', { id: 'agent', name: 'agent 查到' }, [{ title: '存档迁移说明', kind: 'notice', publishedAt: NOW - 500 * MS.DAY, lasting: true }], NOW)
  assert.equal(calendar.notices('sts2')[0]!.title, '存档迁移说明')
  await calendar.applyNotices('sts2', { id: 'agent', name: 'agent 查到' }, [{ title: '存档迁移说明', kind: 'notice', lasting: false }], NOW)
  assert.equal(calendar.notices('sts2').at(-1)!.title, '存档迁移说明', 'an ordinary old one now')
  assert.equal(calendar.notices('sts2').at(-1)!.publishedAt, NOW - 500 * MS.DAY, 'its date kept')

  // Many more: the newest 40 stay, and a long-term one besides.
  await calendar.applyNotices('sts2', STEAM, [{ title: '常驻规则', kind: 'notice', lasting: true, publishedAt: 0 }], NOW)
  await calendar.applyNotices('sts2', STEAM, Array.from({ length: 50 }, (_, i) => ({ title: `News ${i}`, kind: 'news' as const, publishedAt: NOW - i * MS.DAY })), NOW)
  const kept = calendar.notices('sts2')
  assert.equal(kept.length, 41)
  assert.equal(kept[0]!.title, '常驻规则')
  assert.ok(kept.some(n => n.title === 'News 39') && !kept.some(n => n.title === 'News 40'))

  // They survive a restart; another game's are its own; forgetting the game forgets them.
  await calendar.applyNotices('other', STEAM, [{ title: 'Other', kind: 'news' }], NOW)
  const reloaded = new Calendar(dirname(calendar.file))
  await reloaded.load()
  assert.equal(reloaded.notices('sts2').length, 41)
  assert.equal(reloaded.notices().length, 42)
  await reloaded.forget('sts2')
  assert.deepEqual(reloaded.notices().map(n => n.game), ['other'])
})

test('check the article column of a delivered worker report against saved URLs and explicit exclusions', () => {
  const articles = new ReportedArticles()
  const urls = Array.from({ length: 8 }, (_, i) => `https://news.example/post?id=${i}`)
  articles.receive(['| 标题 | 日期 | 直链 | 配图 |', '|---|---|---|---|',
    ...urls.map((url, i) => `| 文章 ${i} | 11/19 | [原文](${url}) | https://news.example/photo.jpg |`),
    '', '参见 https://another.example',
  ].join('\n'))
  assert.equal(articles.count, 8)
  assert.equal(articles.remaining(urls.slice(0, 3), '').length, 5)
  assert.deepEqual(articles.remaining(urls.slice(0, 6), `跳过 ${urls[6]} | 属于另一个游戏`), [urls[7]])
  assert.equal(articles.exclusions, 1)
})

test('eight article links on a query-based news site are retained; re-reading a tracked link enriches the existing cover', async () => {
  const calendar = fresh()
  await calendar.load()
  const articles = Array.from({ length: 8 }, (_, i) => ({ title: '公告' + i, kind: 'news' as const, url: 'https://news.example/article?id=' + i }))
  await calendar.applyNotices('game', STEAM, articles, NOW)
  await calendar.applyNotices('game', STEAM, [{ ...articles[0]!, url: articles[0]!.url + '&utm_source=feed', cover: 'https://news.example/cover.jpg' }], NOW + 1)
  assert.equal(calendar.notices('game').length, 8)
  assert.equal(calendar.notices('game').find(n => n.title === articles[0]!.title)?.cover, 'https://news.example/cover.jpg')
})

test('game_notice: the agent records announcements with their dates in the game\'s time; only web addresses are kept', async () => {
  const calendar = fresh()
  await calendar.load()
  const tools = gameTools({
    games: () => [{ id: 'sts2', name: '杀戮尖塔2', aliases: [], timezone: 'Asia/Shanghai' }],
    now: () => NOW,
    notices: (game?: string) => calendar.notices(game),
    recordNotices: (game: string, notices: never[]) => calendar.applyNotices(game, { id: 'agent', name: 'agent 查到' }, notices, NOW),
  } as unknown as GameToolDeps)
  const record = tools.find(t => t.name === 'game_notice')!
  const out = await record.execute({ game: '杀戮尖塔2', notices: [
    { title: 'v0.111.1 更新', kind: 'update', version: 'v0.111.1', published_at: '2026/11/18 10:00', url: 'https://store.steampowered.com/news/app/2868840', summary: '新遗物' },
    { title: '长期公告', kind: 'notice', lasting: true, url: 'javascript:alert(1)', cover: 'http://insecure/x.png' },
  ] }, {} as never) as unknown as { recorded: Array<{ title: string; date?: string; lasting?: boolean }> }
  assert.deepEqual(out.recorded.map(n => n.title), ['v0.111.1 更新', '长期公告'])
  const [update, lasting] = [calendar.notices('sts2').find(n => n.kind === 'update')!, calendar.notices('sts2').find(n => n.kind === 'notice')!]
  assert.equal(update.publishedAt, Date.UTC(2026, 10, 18, 2), '10:00 in Shanghai')
  assert.equal(update.version, 'v0.111.1')
  assert.equal(lasting.lasting, true)
  assert.equal(lasting.url, undefined, 'not a web address')
  assert.equal(lasting.cover, undefined, 'not https')
  await assert.rejects(record.execute({ game: 'nope', notices: [{ title: 'x', kind: 'news' }] }, {} as never), /没有游戏「nope」/)
})

test('game_add: what the sources the plugin reads itself gave is told to the agent, so it does not record them again', async () => {
  const added: unknown[] = []
  const info = (sources: Array<{ name: string; auto: boolean }>) => ({ id: 'sts', name: '杀戮尖塔', aliases: [], timezone: 'Asia/Shanghai', sources: sources.map((s, i) => ({ id: `s${i}`, ...s })) })
  let read: { count: number; notices?: number; detail?: string } | undefined = { count: 0, notices: 20 }
  const tools = gameTools({
    games: () => [],
    now: () => NOW,
    add: async (manifest: unknown) => { added.push(manifest); return { game: info([{ name: 'Steam 官方公告', auto: true }, { name: '官网', auto: false }]), ...(read === undefined ? {} : { read }) } },
  } as unknown as GameToolDeps)
  const add = tools.find(t => t.name === 'game_add')!
  assert.ok(add.timeoutMs! >= 120_000, 'it waits for the first read')
  const args = { id: 'sts', name: '杀戮尖塔', single: true, sources: [{ id: 'steam', name: 'Steam 官方公告', steam_appid: 646570 }, { id: 'site', name: '官网', homepage: 'https://www.megacrit.com/news/' }] }
  const out = await add.execute(args, {} as never) as unknown as { read_now?: { notices: number; failed?: string }; note: string }
  assert.deepEqual((added[0] as { sources: unknown[] }).sources[0], { id: 'steam', name: 'Steam 官方公告', steam: { appid: 646570 } })
  assert.equal(out.read_now?.notices, 20)
  assert.match(out.note, /20 条公告/)
  assert.match(out.note, /不用再用 game_record \/ game_notice 记/)

  read = { count: 0, detail: 'Steam 上没有 app 1 的新闻（HTTP 404）' }
  const failed = await add.execute(args, {} as never) as unknown as { read_now?: { notices: number; failed?: string } }
  assert.deepEqual(failed.read_now, { activities: 0, notices: 0, failed: 'Steam 上没有 app 1 的新闻（HTTP 404）' })

  read = undefined
  const none = await add.execute({ ...args, sources: [args.sources[1]] }, {} as never) as unknown as { read_now?: unknown; note: string }
  assert.equal(none.read_now, undefined)
  assert.match(none.note, /agent 读/)
})
