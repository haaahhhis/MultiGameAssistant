import { DomUtils, parseDocument } from 'htmlparser2'
import type { GameManifest } from '@adg/pack-schema'
import type { ReadNotice } from './calendar.ts'
import { articleKey } from './web-delivery.ts'

/** Publisher indexes whose article URLs we can recognize without guessing. */
function publisher(url: URL): 'rockstar' | 'megacrit' | undefined {
  if (url.protocol !== 'https:' || url.port || url.username || url.password) return
  const host = url.hostname.replace(/^www\./, '')
  if (host === 'rockstargames.com') return 'rockstar'
  if (host === 'megacrit.com') return 'megacrit'
}

function link(raw: string | undefined, base: URL): URL | undefined {
  if (!raw) return
  try { return new URL(raw, base) } catch { return }
}

export function publisherLinks(html: string, base: URL): URL[] {
  const site = publisher(base)
  const unique = new Map<string, URL>()
  for (const a of DomUtils.getElementsByTagName('a', parseDocument(html).children)) {
    const url = link(a.attribs.href, base)
    if (!site || !url || publisher(url) !== site) continue
    const article = site === 'rockstar' ? /^\/newswire\/article\/[\da-z]+(?:\/|$)/i : /^\/news\/\d{4}-\d{1,2}-\d{1,2}-/
    const key = articleKey(url.href)
    if (key && article.test(url.pathname)) unique.set(key, url)
  }
  return [...unique.values()]
}

export function publisherNotice(html: string, page: URL, game: Pick<GameManifest, 'name' | 'aliases'>): ReadNotice | undefined {
  const doc = parseDocument(html)
  const meta = new Map(DomUtils.getElementsByTagName('meta', doc.children).map(el => [el.attribs.property ?? el.attribs.name, el.attribs.content?.trim()]))
  const title = meta.get('og:title')?.replace(/\s+[-|–]\s+(?:Rockstar Games|Mega Crit).*$/i, '').trim()
  const summary = meta.get('og:description') || meta.get('description') || ''
  const normalize = (v: string) => v.normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim()
  const content = ' ' + normalize(title + ' ' + summary) + ' '
  if (!title || ![game.name, ...game.aliases].some(name => content.includes(' ' + normalize(name) + ' '))) return
  const image = link(meta.get('og:image'), page)
  const date = meta.get('article:published_time') ?? DomUtils.getElementsByTagName('time', doc.children)[0]?.attribs.datetime
  const datedPath = publisher(page) === 'megacrit' && /^\/news\/(\d{4})-(\d{1,2})-(\d{1,2})-/.exec(page.pathname)
  const publishedAt = date ? Date.parse(date) : datedPath ? Date.UTC(Number(datedPath[1]), Number(datedPath[2]) - 1, Number(datedPath[3])) : undefined
  const canonical = link(DomUtils.getElementsByTagName('link', doc.children).find(el => el.attribs.rel === 'canonical')?.attribs.href, page)
  return { title, kind: /patch|hotfix|patch notes/i.test(title) ? 'update' : 'news',
    url: canonical && publisher(canonical) === publisher(page) && articleKey(canonical.href) === articleKey(page.href) ? canonical.href : page.href,
    ...(summary ? { summary: summary.slice(0, 300) } : {}),
    ...(image?.protocol === 'https:' ? { cover: image.href } : {}),
    ...(typeof publishedAt === 'number' && Number.isFinite(publishedAt) ? { publishedAt } : {}) }
}

async function readPage(start: URL, signal: AbortSignal): Promise<string> {
  let page = start
  const timed = AbortSignal.any([signal, AbortSignal.timeout(12_000)])
  for (let redirects = 0; redirects <= 3; redirects++) {
    const response = await fetch(page, { redirect: 'manual', signal: timed })
    if (response.status >= 300 && response.status < 400) {
      const next = link(response.headers.get('location') ?? undefined, page)
      await response.body?.cancel()
      if (!next || publisher(next) !== publisher(start)) throw new Error('来源跳转到其他网站')
      page = next
      continue
    }
    if (!response.ok || !response.body) { await response.body?.cancel(); throw new Error('HTTP ' + response.status) }
    const reader = response.body.getReader()
    const parts: Uint8Array[] = []
    let size = 0
    try {
      for (;;) {
        const chunk = await reader.read()
        if (chunk.done) return Buffer.concat(parts).toString('utf8')
        size += chunk.value.length
        if (size > 4_000_000) throw new Error('网页超出读取范围')
        parts.push(chunk.value)
      }
    } finally { await reader.cancel() }
  }
  throw new Error('来源跳转次数过多')
}

export async function readPublisher(game: GameManifest, homepage: string, signal: AbortSignal, now: number) {
  const base = new URL(homepage)
  if (!publisher(base)) return
  const candidates = publisherLinks(await readPage(base, signal), base)
  const notices: ReadNotice[] = []
  const failed: string[] = []
  // Bound simultaneous requests to the publisher. Older entries can still be checked by the agent.
  const selected = candidates.slice(0, 20)
  for (let i = 0; i < selected.length; i += 4) {
    signal.throwIfAborted()
    await Promise.all(selected.slice(i, i + 4).map(async url => {
      try {
        const notice = publisherNotice(await readPage(url, signal), url, game)
        if (notice && (notice.publishedAt === undefined || notice.publishedAt >= now - 120 * 86_400_000)) notices.push(notice)
      } catch { failed.push(url.href) }
    }))
  }
  signal.throwIfAborted()
  return { notices, checked: selected.length, listed: candidates.length, failed }
}
