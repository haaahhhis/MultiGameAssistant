import type { GameManifest } from '@adg/pack-schema'
import type { GameNotice, NoticeArticle } from '@adg/protocol'
import { newswireArticle, publisherArticle } from './notice-article.ts'
import { readSteam, type Fetch } from './sources.ts'

function sourceApp(source: GameManifest['sources'][number]): number | undefined {
  if (source.steam) return source.steam.appid
  const match = /^https:\/\/store\.steampowered\.com\/(?:news\/)?app\/(\d+)(?:\/|$)/.exec(source.homepage ?? '')
  return match ? Number(match[1]) : undefined
}

function steamPost(url: URL) {
  if (url.hostname === 'store.steampowered.com') return /^\/news\/app\/(\d+)\/view\/(\d+)\/?$/.exec(url.pathname)?.[2]
  if (url.hostname === 'steamstore-a.akamaihd.net') return /^\/news\/externalpost\/steam_community_announcements\/(\d+)\/?$/.exec(url.pathname)?.[1]
}

/** Recover a legacy summary from its article, never by matching a similar title. */
export async function readNoticeArticle(notice: GameNotice, game: GameManifest, fetchImpl: Fetch): Promise<NoticeArticle> {
  if (!notice.url || !URL.canParse(notice.url)) return []
  const url = new URL(notice.url)
  if (url.protocol !== 'https:' || url.username || url.password || url.port) return []
  const gid = steamPost(url)
  if (gid) {
    const source = game.sources.find(s => s.id === notice.source.id)
    const configured = source && sourceApp(source)
    const apps = new Set(game.sources.map(sourceApp).filter(id => id !== undefined))
    const onlyApp = apps.size === 1 ? [...apps][0] : undefined
    const storeApp = /^\/news\/app\/(\d+)\/view\//.exec(url.pathname)?.[1]
    const appid = Number(storeApp ?? configured ?? onlyApp)
    if (!Number.isSafeInteger(appid) || appid <= 0) return []
    // Manually recorded publication dates may have only day or minute precision.
    const endDate = notice.publishedAt === undefined ? undefined : Math.floor(notice.publishedAt / 1000) + 86_400
    const items = await readSteam({ appid }, fetchImpl, undefined, endDate)
    return items.find(item => item.url && URL.canParse(item.url) && steamPost(new URL(item.url)) === gid)?.article ?? []
  }
  const signal = AbortSignal.timeout(12_000)
  if (/^(?:www\.)?rockstargames\.com$/.test(url.hostname)) {
    const id = /^\/(?:[a-z]{2}\/)?newswire\/article\/([a-z0-9]+)(?:\/|$)/i.exec(url.pathname)?.[1]
    if (id) return newswireArticle(id, async endpoint => {
      const response = await fetchImpl(endpoint, { signal, headers: { accept: 'application/json' } })
      if (!response.ok) throw new Error('新闻来源返回 HTTP ' + response.status)
      return response.json()
    })
  }
  if (/^(?:www\.)?megacrit\.com$/.test(url.hostname) && /^\/news\/[^/]+\/?$/.test(url.pathname)) {
    const response = await fetch(url, { redirect: 'error', signal })
    if (!response.ok) throw new Error('新闻来源返回 HTTP ' + response.status)
    return publisherArticle(await response.text(), url.href)
  }
  return []
}
