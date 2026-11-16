import { memo, useContext, useEffect, useMemo, useRef, useState, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import type { AdgClient } from '@adg/client-core'
import { desktop } from '../desktop.ts'
import { ImageViewer } from './ImageViewer.tsx'
import { ImageClient } from './StoredImage.tsx'
import hljs from 'highlight.js/lib/core'
import bash from 'highlight.js/lib/languages/bash'
import css from 'highlight.js/lib/languages/css'
import diff from 'highlight.js/lib/languages/diff'
import go from 'highlight.js/lib/languages/go'
import java from 'highlight.js/lib/languages/java'
import javascript from 'highlight.js/lib/languages/javascript'
import json from 'highlight.js/lib/languages/json'
import markdown from 'highlight.js/lib/languages/markdown'
import python from 'highlight.js/lib/languages/python'
import rust from 'highlight.js/lib/languages/rust'
import sql from 'highlight.js/lib/languages/sql'
import typescript from 'highlight.js/lib/languages/typescript'
import xml from 'highlight.js/lib/languages/xml'
import yaml from 'highlight.js/lib/languages/yaml'

for (const [name, language] of Object.entries({ bash, css, diff, go, java, javascript, json, markdown, python, rust, sql, typescript, xml, yaml })) {
  hljs.registerLanguage(name, language)
}
hljs.registerAliases(['sh', 'shell', 'zsh', 'console'], { languageName: 'bash' })
hljs.registerAliases(['ts', 'tsx', 'mts', 'cts'], { languageName: 'typescript' })
hljs.registerAliases(['js', 'jsx', 'mjs', 'cjs'], { languageName: 'javascript' })
hljs.registerAliases(['html', 'svg', 'vue'], { languageName: 'xml' })
hljs.registerAliases(['py'], { languageName: 'python' })
hljs.registerAliases(['yml'], { languageName: 'yaml' })
hljs.registerAliases(['rs'], { languageName: 'rust' })
hljs.registerAliases(['md'], { languageName: 'markdown' })

const escapeHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')

marked.setOptions({ gfm: true, breaks: false })
// Fenced code: a header with the language and a copy button, then highlighted source.
marked.use({
  renderer: {
    code({ text, lang }) {
      const name = (lang ?? '').trim().split(/\s+/)[0] ?? ''
      const known = name !== '' && hljs.getLanguage(name) !== undefined
      const body = known ? hljs.highlight(text, { language: name, ignoreIllegals: true }).value : escapeHtml(text)
      return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(name === '' ? 'text' : name)}</span>`
        + `<button type="button" class="code-copy" data-copy="">复制</button></div>`
        + `<pre><code class="hljs">${body}</code></pre></div>`
    },
  },
})

/**
 * A link to a file or folder on this computer (file:///C:/…, C:\…, /c/…, \\server\share),
 * as a Windows path; undefined for web links. The sanitizer drops such hrefs, so they are
 * kept aside before it runs and opened through the desktop app.
 */
export function localPath(href: string): string | undefined {
  let path = href.trim()
  if (/^file:/i.test(path)) {
    try { path = decodeURIComponent(path.replace(/^file:\/{2,3}/i, '')) } catch { return undefined }
    if (/^[A-Za-z]:/.test(path) === false && /^[^/]+\//.test(path)) path = `//${path}` // file://server/share
  }
  const drive = /^\/([A-Za-z])\/(.*)$/.exec(path) // /c/Users/… (Git Bash)
  if (drive !== null) path = `${drive[1]!.toUpperCase()}:/${drive[2]}`
  if (!/^[A-Za-z]:[\\/]/.test(path) && !/^(\\\\|\/\/)[^\\/]/.test(path)) return undefined
  return path.replace(/\//g, '\\').replace(/[#?].*$/, '')
}

/** A file name an image viewer shows: png, jpg, gif, webp, bmp. */
const IMAGE_FILE = /\.(png|jpe?g|gif|webp|bmp)$/i
/** Not a file on this computer: a web address, a link into the app, a page anchor. */
const NOT_A_FILE = /^(#|\?|\/\/|[a-z][a-z0-9+.-]*:)/i

/**
 * Where an image (`![…](src)`) or a link to one points on this computer: a
 * local path, or one relative to the agents' workspace (the gateway resolves
 * it); undefined for web addresses.
 */
export function localImage(src: string): string | undefined {
  const written = src.trim()
  const local = localPath(written)
  if (local !== undefined) return local
  if (written === '' || NOT_A_FILE.test(written)) return undefined
  return written
}

/**
 * The sanitizer drops hrefs and srcs to files on this computer, and the page
 * may only show its own and data: images: such images and links are kept
 * aside here, and the Markdown component loads them through the gateway.
 */
DOMPurify.addHook('beforeSanitizeAttributes', node => {
  if (node.tagName === 'IMG') {
    const src = node.getAttribute('src') ?? ''
    if (/^data:image\//i.test(src)) return
    node.removeAttribute('src')
    node.classList.add('md-image')
    const local = localImage(src)
    if (local !== undefined) node.setAttribute('data-local-image', local)
    else if (/^https?:/i.test(src)) node.setAttribute('data-remote-image', src)
    return
  }
  if (node.tagName !== 'A') return
  const href = node.getAttribute('href') ?? ''
  const path = localPath(href)
  if (path !== undefined) {
    node.removeAttribute('href')
    node.setAttribute('data-local-path', path)
    node.setAttribute('title', path)
    node.classList.add('local-path')
    if (IMAGE_FILE.test(path)) node.setAttribute('data-image-preview', path)
    return
  }
  // An image named relative to the workspace (`[shot.png](shot.png)`): its preview, not a page of this app.
  const relative = localImage(href)
  if (relative !== undefined && IMAGE_FILE.test(relative)) {
    node.removeAttribute('href')
    node.setAttribute('data-image-preview', relative)
    node.setAttribute('title', relative)
    node.classList.add('local-path')
  }
})

// Model output is untrusted: sanitize, and make every link open externally — except links into this app (#/…).
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A' && /^#\/(p|s|settings)(\/|$)/.test(node.getAttribute('href') ?? '')) {
    node.classList.add('app-link')
    return
  }
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** A local file link: open it (the desktop app decides how), or copy the path in a browser. */
function openLocal(link: HTMLElement): void {
  const path = link.dataset['localPath']
  if (path === undefined) return
  const flash = (text: string) => {
    link.dataset['note'] = text
    setTimeout(() => { delete link.dataset['note'] }, 2200)
  }
  const bridge = desktop()
  if (bridge?.openPath !== undefined) {
    bridge.openPath(path).then(r => flash(r === 'missing' ? '找不到这个文件' : r === 'revealed' ? '已在文件夹中显示' : '已打开'), () => flash('打不开'))
    return
  }
  const write = navigator.clipboard?.writeText(path) ?? Promise.reject(new Error('no clipboard'))
  write.then(() => flash('浏览器里打不开本地文件，路径已复制'), () => flash(legacyCopy(path) ? '浏览器里打不开本地文件，路径已复制' : path))
}

/** Copy buttons and local file links live in sanitized HTML, so one delegated handler serves them all. */
function onCopy(e: MouseEvent<HTMLDivElement>) {
  const local = (e.target as HTMLElement).closest<HTMLElement>('a[data-local-path]')
  if (local !== null) {
    e.preventDefault()
    openLocal(local)
    return
  }
  const button = (e.target as HTMLElement).closest<HTMLButtonElement>('button[data-copy]')
  const code = button?.closest('.code-block')?.querySelector('pre')
  if (button == null || code == null) return
  const done = (ok: boolean) => {
    button.textContent = ok ? '已复制' : '复制失败'
    button.classList.toggle('copied', ok)
    setTimeout(() => { button.textContent = '复制'; button.classList.remove('copied') }, 1600)
  }
  void copyText(code.innerText).then(done)
}

/** Put text on the clipboard. @returns whether it got there. */
export function copyText(text: string): Promise<boolean> {
  const write = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'))
  return write.then(() => true, () => legacyCopy(text))
}

/** Clipboard API can be denied (embedded or non-secure contexts); fall back to a selection copy. */
function legacyCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.opacity = '0'
  document.body.appendChild(area)
  area.select()
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
  }
}

/** Image files already read, by the path as written; a file a reply shows rarely changes while it is on screen. */
const files = new Map<string, Promise<string>>()

function readImage(client: AdgClient, path: string): Promise<string> {
  let url = files.get(path)
  if (url === undefined) {
    url = client.connection.call('attachments/file', { path }).then(r => `data:${r.mediaType};base64,${r.data}`)
    url.catch(() => files.delete(path))
    files.set(path, url)
  }
  return url
}

/**
 * Show the images a reply kept aside (see the sanitizer hook): a local one is
 * read through the gateway; a link to an image file gets its picture under
 * it; a web image, which this page may not load, becomes a link to it.
 */
function showImages(root: HTMLElement, client: AdgClient | null): () => void {
  let live = true
  const available = client?.capabilities.get().has('attachments') === true
  const fill = (img: HTMLImageElement, path: string) => {
    if (!available || client === null) { img.replaceWith(missing(path, '当前后端不支持显示图片')); return }
    img.classList.add('loading')
    readImage(client, path).then(
      src => { if (live) { img.src = src; img.classList.remove('loading') } },
      e => { if (live) img.replaceWith(missing(path, e instanceof Error ? e.message : String(e))) },
    )
  }
  for (const img of root.querySelectorAll<HTMLImageElement>('img[data-local-image]')) {
    if (img.src === '') fill(img, img.dataset['localImage']!)
  }
  for (const link of root.querySelectorAll<HTMLAnchorElement>('a[data-image-preview]')) {
    if (link.nextElementSibling?.classList.contains('md-link-preview') === true) continue
    const img = document.createElement('img')
    img.className = 'md-image md-link-preview'
    img.alt = link.textContent ?? ''
    img.dataset['localImage'] = link.dataset['imagePreview']!
    link.after(img)
    fill(img, img.dataset['localImage']!)
  }
  for (const img of root.querySelectorAll<HTMLImageElement>('img[data-remote-image]')) {
    const link = document.createElement('a')
    link.href = img.dataset['remoteImage']!
    link.target = '_blank'
    link.rel = 'noopener noreferrer'
    link.textContent = `🖼 ${img.alt !== '' ? img.alt : '网络图片'}`
    link.title = link.href
    img.replaceWith(link)
  }
  return () => { live = false }
}

function missing(path: string, why: string): HTMLElement {
  const note = document.createElement('span')
  note.className = 'md-image-missing'
  note.textContent = `图片没能显示：${why}`
  note.title = path
  return note
}

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text])
  const client = useContext(ImageClient)
  const root = useRef<HTMLDivElement>(null)
  const [zoomed, setZoomed] = useState<{ src: string; width: number; height: number; name: string } | null>(null)
  useEffect(() => root.current === null ? undefined : showImages(root.current, client), [html, client])
  const onClick = (e: MouseEvent<HTMLDivElement>) => {
    const target = e.target as HTMLElement
    const preview = target.closest<HTMLAnchorElement>('a[data-image-preview]:not([data-local-path])')
    const img = target instanceof HTMLImageElement && target.classList.contains('md-image') && target.src !== '' ? target
      : preview?.nextElementSibling instanceof HTMLImageElement && preview.nextElementSibling.src !== '' ? preview.nextElementSibling : null
    if (img !== null) {
      e.preventDefault()
      const path = img.dataset['localImage'] ?? ''
      setZoomed({ src: img.src, width: img.naturalWidth, height: img.naturalHeight, name: path.split(/[\\/]/).pop() || 'image.png' })
      return
    }
    onCopy(e)
  }
  return (
    <>
      <div ref={root} className={`markdown ${className ?? ''}`} onClick={onClick} dangerouslySetInnerHTML={{ __html: html }} />
      {zoomed !== null && <ImageViewer src={zoomed.src} width={zoomed.width} height={zoomed.height} name={zoomed.name} onClose={() => setZoomed(null)} />}
    </>
  )
})
