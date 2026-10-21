/**
 * The agent's answers are markdown; Feishu shows a plain text message as is
 * (`**18000**`, `- 积分…`). Rich text (`post`) with an `md` block renders
 * bold, italics, strikethrough, links, lists, quotes, code blocks and
 * dividers; this turns the rest into something it shows well.
 */

/** Markdown the `md` block renders: headings become bold lines, images their links, tables stay as text. */
export function toFeishuMarkdown(text: string): string {
  const lines = text.replace(/\r\n?/g, '\n').split('\n')
  let fenced = false
  const out = lines.map(line => {
    if (/^\s*(```|~~~)/.test(line)) { fenced = !fenced; return line }
    if (fenced) return line
    const heading = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/.exec(line)
    if (heading !== null) return `**${heading[1]!.replace(/\*\*/g, '')}**`
    return line.replace(/!\[([^\]]*)\]\(([^)\s]+)[^)]*\)/g, (_m, alt: string, url: string) => `[${alt === '' ? '图片' : alt}](${url})`)
  })
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/** The `post` content for one markdown answer. */
export function markdownPost(text: string): object {
  return { zh_cn: { content: [[{ tag: 'md', text: toFeishuMarkdown(text) }]] } }
}
