/** Article identity for agent submissions, source imports and probe receipts. */
export function articleKey(raw: string): string | undefined {
  try {
    const url = new URL(raw)
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) return
    url.hash = ''
    if (/^(?:www\.)?rockstargames\.com$/.test(url.hostname)) {
      const article = /^\/newswire\/article\/([a-z\d]+)(?:\/|$)/i.exec(url.pathname)
      if (article) url.pathname = '/newswire/article/' + article[1]
    }
    const steam = /(?:^|\.)(?:steampowered\.com|steamcommunity\.com|steamstore-a\.akamaihd\.net)$/.test(url.hostname)
    for (const key of [...url.searchParams.keys()]) {
      if (/^utm_|^(fbclid|gclid)$/i.test(key) || (steam && key === 'l')) url.searchParams.delete(key)
    }
    url.searchParams.sort()
    return url.href.replace(/\/+$/, '')
  } catch { return }
}

/** The parent's own delivered subagent messages are the inputs. Other links in prose or image columns are references. */
export class ReportedArticles {
  private readonly urls = new Map<string, string>()
  private readonly skipped = new Set<string>()

  expect(urls: readonly string[]): void {
    for (const url of urls) {
      const key = articleKey(url)
      if (key) this.urls.set(key, url)
    }
  }

  receive(report: string): void {
    let links = -1
    for (const row of report.split(/\r?\n/)) {
      if (!row.includes('|')) { links = -1; continue }
      const cells = row.trim().replace(/^\||\|$/g, '').split('|').map(cell => cell.trim())
      if (cells.some(c => /标题|^title$/i.test(c)) && cells.some(c => /日期|^date$/i.test(c))) {
        links = cells.findIndex(c => /直链|文章链接|^链接$|^url$|^link$/i.test(c))
      } else if (links >= 0) {
        const raw = cells[links]?.match(/https?:\/\/[^\s<>\])|]+/i)?.[0]
        const key = raw && articleKey(raw)
        if (key && raw) this.urls.set(key, raw)
      }
    }
  }

  remaining(stored: readonly (string | undefined)[], summary: string): string[] {
    for (const row of summary.split(/\r?\n/)) {
      const skip = /^\s*(?:[-*]\s*)?跳过\s+(https?:\/\/\S+)\s+[|｜]\s*\S/.exec(row)
      const key = skip?.[1] && articleKey(skip[1])
      if (key && this.urls.has(key)) this.skipped.add(key)
    }
    const known = new Set(stored.map(url => url && articleKey(url)))
    return [...this.urls].filter(([key]) => !known.has(key) && !this.skipped.has(key)).map(([, url]) => url)
  }

  get count(): number { return this.urls.size }
  get exclusions(): number { return this.skipped.size }
}

/** A game's encyclopedia overview can corroborate a release, but has no publication of its own. */
export function gameOverview(raw: string, names: readonly string[]): boolean {
  try {
    const url = new URL(raw)
    if (!/(?:^|\.)(?:fandom\.com|wikipedia\.org)$/i.test(url.hostname)) return false
    const normalize = (v: string) => v.normalize('NFKC').replace(/[\s_]+/g, ' ').trim().toLowerCase()
    const page = /^\/wiki\/(.+)$/.exec(decodeURIComponent(url.pathname))?.[1]
    return !!page && names.some(name => normalize(name) === normalize(page))
  } catch { return false }
}
