/**
 * A small copy button under a chat message: copies the message's own text (a
 * reply as its Markdown), and shows a tick for a moment once it is on the clipboard.
 */
import { useEffect, useRef, useState } from 'react'
import { copyText } from './Markdown.tsx'
import { Icon } from './Icons.tsx'

export function CopyButton({ text, label = '复制' }: { text: string; label?: string }) {
  const [state, setState] = useState<'idle' | 'copied' | 'failed'>('idle')
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const copy = async () => {
    const ok = await copyText(text)
    setState(ok ? 'copied' : 'failed')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setState('idle'), 1500)
  }
  const title = state === 'copied' ? '已复制' : state === 'failed' ? '复制失败' : label
  return (
    <button type="button" className={`msg-action ${state === 'idle' ? '' : state}`} title={title} aria-label={title} onClick={() => void copy()}>
      <Icon name={state === 'copied' ? 'check' : 'copy'} />
    </button>
  )
}
