import { memo, useMemo, type MouseEvent } from 'react'
import DOMPurify from 'dompurify'
import { marked } from 'marked'
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

// Model output is untrusted: sanitize, and make every link open externally.
DOMPurify.addHook('afterSanitizeAttributes', node => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank')
    node.setAttribute('rel', 'noopener noreferrer')
  }
})

/** Copy buttons live in sanitized HTML, so one delegated handler serves them all. */
function onCopy(e: MouseEvent<HTMLDivElement>) {
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
