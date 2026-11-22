import assert from 'node:assert/strict'
import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { GameManifest } from '@adg/pack-schema'
import { Calendar } from '../src/calendar.ts'
import { readNoticeArticle } from '../src/read-notice.ts'
import { steamArticle } from '../src/notice-article.ts'

test('a legacy patch gets its own complete article and images in order, even outside the latest feed', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'adg-notice-detail-'))
  const calendar = new Calendar(dir)
  const source = { id: 'steam', name: 'Steam' }
  const game = GameManifest.parse({ id: 'game', name: 'Game', sources: [{ ...source, steam: { appid: 42 } }] })
  const base = 'https://steamstore-a.akamaihd.net/news/externalpost/steam_community_announcements/'
  const [old] = await calendar.applyNotices('game', source, [{ title: 'Patch', kind: 'update', url: base + '101', summary: 'old…', publishedAt: 123000 }], 456)
  const end = 'x'.repeat(900) + ' Final fix.'
  const article = await readNoticeArticle({ ...old!, source: { id: 'agent', name: 'agent 查到' } }, game, async url => {
    assert.equal(new URL(url).searchParams.get('enddate'), '86523')
    return new Response(JSON.stringify({ appnews: { newsitems: [
      { title: 'Patch', url: base + '102', contents: 'different post' },
      { title: 'Patch', url: base + '101', contents: '[p]Opening[/p][img]{STEAM_CLAN_IMAGE}/42/one.gif[/img]<img src="https://example.org/two.png">[p]' + end + '[/p]' },
    ] } }))
  })
  await calendar.saveArticle('game', old!.id, article)
  await calendar.applyNotices('game', source, [{ title: 'Patch', kind: 'update', url: base + '101', summary: 'new summary' }], 789)
  const reopened = new Calendar(dir)
  await reopened.load()
  const detail = reopened.noticeDetail('game', old!.id)
  assert.deepEqual(detail.article, [
    { type: 'text', text: 'Opening' },
    { type: 'image', url: 'https://clan.akamai.steamstatic.com/images/42/one.gif' },
    { type: 'image', url: 'https://example.org/two.png' },
    { type: 'text', text: end },
  ])
  assert.equal(detail.summary, 'new summary')
  assert.ok(reopened.pictures().has('https://example.org/two.png'))
  assert.equal('article' in reopened.notices('game')[0]!, false)
  assert.throws(() => reopened.noticeDetail('other-game', old!.id))
})

test('article text is decoded, while embedded scripts and non-HTTPS images are discarded', () => {
  assert.deepEqual(steamArticle('Hello <b>world</b> &amp; all!<br>Line two.<script>hidden()</script><img src="file:///tmp/test">'), [
    { type: 'text', text: 'Hello world & all!\nLine two.' },
  ])
})
