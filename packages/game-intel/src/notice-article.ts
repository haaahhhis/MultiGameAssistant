import { DomUtils, parseDocument } from 'htmlparser2'
import type { NoticeArticle } from '@adg/protocol'

const CLAN_IMAGES = 'https://clan.akamai.steamstatic.com/images'

function httpsImage(raw: string, base?: string): string | undefined {
  try {
    const url = new URL(raw.replace('{STEAM_CLAN_IMAGE}', CLAN_IMAGES), base)
    if (url.protocol === 'https:' && !url.username && !url.password) return url.href
  } catch { /* Some articles contain empty or broken image tags. */ }
}

type ArticleNode = ReturnType<typeof parseDocument>['children'][number]

/** Render only text and image addresses, preserving their original order. */
function articleNodes(nodes: ArticleNode[], base?: string): NoticeArticle {
  const result: NoticeArticle = []
  let buffer = ''
  const flush = () => {
    const text = buffer.replace(/\u00a0/g, ' ').replace(/[ \t]+/g, ' ').replace(/ *\n */g, '\n').replace(/\n{3,}/g, '\n\n').trim()
    if (text) result.push({ type: 'text', text })
    buffer = ''
  }
  function visit(node: ArticleNode) {
    if (node.type === 'text') { buffer += node.data; return }
    if (node.type !== 'tag' || ['nav', 'aside', 'footer', 'noscript'].includes(node.name)) return
    if (node.name === 'img') {
      const raw = node.attribs['data-src'] || node.attribs.src
      const url = raw && httpsImage(raw.trim(), base)
      if (url) { flush(); result.push({ type: 'image', url }) }
      return
    }
    const paragraph = /^(p|div|section|blockquote|h[1-6])$/.test(node.name)
    if (paragraph) buffer += '\n\n'
    if (node.name === 'br') buffer += '\n'
    if (node.name === 'li') buffer += '\n• '
    for (const child of node.children) visit(child)
    if (paragraph) buffer += '\n\n'
  }
  for (const node of nodes) visit(node)
  flush()
  return result
}

export function steamArticle(contents: string): NoticeArticle {
  // Steam uses both HTML and BBCode, including an older [img]url[/img] form.
  const html = contents
    .replace(/\[img\b([^\]]*)\]([\s\S]*?)\[\/img\]/gi, (_, attrs: string, inner: string) => {
      const raw = /\bsrc\s*=\s*["']([^"']+)["']/i.exec(attrs)?.[1] || inner.trim()
      const url = httpsImage(raw)
      return url ? '<img src="' + url.replace(/&/g, '&amp;').replace(/"/g, '&quot;') + '">' : ''
    })
    .replace(/\[\/?(?:p|h[1-6]|list|olist|quote)(?:[= ][^\]]*)?\]/gi, '\n\n')
    .replace(/\[\*\]/g, '\n• ')
    .replace(/\[\/?(?:b|i|u|s|strike|url|color|size|table|tr|td|th|hr|previewyoutube|spoiler|code|noparse)(?:[= ][^\]]*)?\]/gi, '')
  return articleNodes(parseDocument(html).children)
}

export function publisherArticle(html: string, url: string): NoticeArticle {
  const doc = parseDocument(html)
  const body = DomUtils.findOne(el => el.attribs.itemprop === 'articleBody' || /(?:^|\s)(?:prose|entry-content)(?:\s|$)/.test(el.attribs.class ?? ''), doc.children)
    ?? DomUtils.getElementsByTagName('article', doc.children)[0]
  return body ? articleNodes(body.children, url) : []
}

interface NewswireBlock {
  content?: NewswireBlock[] | string
  _memoq?: { content?: string }
  image?: { sources?: { en_us?: { desktop?: string; mobile?: string } } }
}

/** The Newswire website loads an individual post from its public GraphQL query. */
export async function newswireArticle(id: string, fetchJson: (url: string) => Promise<unknown>): Promise<NoticeArticle> {
  const origin = 'https://www.rockstargames.com'
  const cdn = 'https://media-rockstargames-com.akamaized.net'
  const params = new URLSearchParams({
    origin, operationName: 'NewswirePost', variables: JSON.stringify({ locale: 'en_us', id_hash: id }),
    extensions: JSON.stringify({ persistedQuery: { version: 1, sha256Hash: '555658813abe5acc8010de1a1feddd6fd8fddffbdc35d3723d4dc0fe4ded6810' } }),
  })
  const data = await fetchJson('https://graph.rockstargames.com/?' + params) as {
    data?: { post?: { id: string; content?: string; tina?: { payload?: { content?: NewswireBlock[] } } } }
  }
  const post = data?.data?.post
  if (post?.id !== id) return []
  const result: NoticeArticle = []
  function visit(block: NewswireBlock) {
    const source = block.image?.sources?.en_us
    const raw = source?.desktop || source?.mobile
    const url = raw && httpsImage(raw, cdn)
    if (url) result.push({ type: 'image', url })
    const html = block._memoq?.content ?? block.content
    if (typeof html === 'string') result.push(...articleNodes(parseDocument(html).children, origin))
    if (Array.isArray(block.content)) block.content.forEach(visit)
  }
  post.tina?.payload?.content?.forEach(visit)
  if (!result.some(b => b.type === 'text') && post.content) return articleNodes(parseDocument(post.content).children, origin)
  return result
}
