import { memo, useMemo, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
import { desktop } from '../desktop.ts'
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

DOMPurify.addHook('beforeSanitizeAttributes', node => {
  if (node.tagName !== 'A') return
  const path = localPath(node.getAttribute('href') ?? '')
  if (path === undefined) return
  node.removeAttribute('href')
  node.setAttribute('data-local-path', path)
  node.setAttribute('title', path)
  node.classList.add('local-path')
})

// Model output is untrusted: sanitize, and make every link open externally.
DOMPurify.addHook('afterSanitizeAttributes', node => {
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
  const text = code.innerText
  const done = (ok: boolean) => {
    button.textContent = ok ? '已复制' : '复制失败'
    button.classList.toggle('copied', ok)
    setTimeout(() => { button.textContent = '复制'; button.classList.remove('copied') }, 1600)
  }
  const write = navigator.clipboard?.writeText(text) ?? Promise.reject(new Error('no clipboard'))
  write.then(() => done(true), () => done(legacyCopy(text)))
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

export const Markdown = memo(function Markdown({ text, className }: { text: string; className?: string }) {
  const html = useMemo(() => DOMPurify.sanitize(marked.parse(text, { async: false })), [text])
  return <div className={`markdown ${className ?? ''}`} onClick={onCopy} dangerouslySetInnerHTML={{ __html: html }} />
})
