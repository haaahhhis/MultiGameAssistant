import assert from 'node:assert/strict'
import { test } from 'node:test'
import { publisherLinks, publisherNotice } from '../src/publisher-news.ts'
import { steamNewsSource } from '../src/sources.ts'
import { gameOverview } from '../src/web-delivery.ts'

const index = new URL('https://www.rockstargames.com/VI')
const game = { name: '侠盗猎车手VI', aliases: ['Grand Theft Auto VI'] }

test('a publisher index retains different articles and merges short and titled links', () => {
  const links = publisherLinks([
    '<a href="/newswire/article/111/news-a">A</a><a href="/newswire/article/111">A</a>',
    '<a href="/newswire/article/222/news-b">B</a><a href="/newswire/article/333/news-c">C</a>',
    '<a href="https://example.org/newswire/article/444">other site</a>',
  ].join(''), index)
  assert.equal(links.length, 3)
  const page = new URL('/newswire/article/111', index)
  const metas = '<meta property="og:title" content="Grand Theft Auto VI Launch Gallery - Rockstar Games"><meta property="og:image" content="/media/gallery.jpg">'
  assert.deepEqual(publisherNotice(metas, page, game), {
    title: 'Grand Theft Auto VI Launch Gallery', kind: 'news', url: page.href, cover: 'https://www.rockstargames.com/media/gallery.jpg',
  })
  assert.equal(publisherNotice(metas.replace('Grand Theft Auto VI', 'GTA Online'), page, game), undefined)
})

test('an existing Steam store news link identifies the feed and encyclopedia overview is a reference', () => {
  assert.deepEqual(steamNewsSource('https://store.steampowered.com/news/app/2868840'), { appid: 2868840 })
  assert.equal(steamNewsSource('https://elsewhere.example/news/app/2868840'), undefined)
  assert.equal(gameOverview('https://gta.fandom.com/wiki/Grand_Theft_Auto_VI', game.aliases), true)
  assert.equal(gameOverview('https://gta.fandom.com/wiki/Other_article', game.aliases), false)
})
