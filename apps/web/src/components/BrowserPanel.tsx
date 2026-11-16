import { useEffect, useRef, useState, type KeyboardEvent, type MouseEvent, type WheelEvent } from 'react'
import type { BrowserBridge, BrowserInput, BrowserState } from '../desktop.ts'
import { Icon } from './Icons.tsx'

/**
 * The built-in browser beside a conversation (apps/desktop/browser.mjs): the
 * agent's pages drawn live, a toolbar, and the user's mouse and keys sent
 * back, so the user can watch the agent or take over (log in, solve what it
 * cannot).
 */
export function BrowserPanel({ bridge, onClose }: { bridge: BrowserBridge; onClose: () => void }) {
  const [state, setState] = useState<BrowserState | null>(null)
  /** The size of the last frame drawn (the page's size), or null before the first. */
  const [frame, setFrame] = useState<{ width: number; height: number } | null>(null)
  const canvas = useRef<HTMLCanvasElement | null>(null)
  const latest = useRef<ImageBitmap | null>(null)
  const [address, setAddress] = useState('')
  const [editing, setEditing] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const viewport = useRef<HTMLDivElement | null>(null)
  const typing = useRef<HTMLTextAreaElement | null>(null)
  const composing = useRef(false)
  const lastMove = useRef(0)

  const shown = state?.tabs.find(t => t.id === state.shown)
  useEffect(() => { if (!editing) setAddress(shown?.url === 'about:blank' ? '' : shown?.url ?? '') }, [shown?.url, editing])

  useEffect(() => {
    let alive = true
    void bridge.state().then(s => { if (alive && s !== null) setState(s) })
    const offState = bridge.onChange(setState)
    // Drawn on a canvas: the page's CSP takes images from itself and data: only, and a bitmap is cheaper anyway.
    const offFrame = bridge.onFrame(f => {
      void createImageBitmap(new Blob([f.data as BlobPart], { type: 'image/jpeg' })).then(bitmap => {
        if (!alive) return bitmap.close()
        latest.current?.close()
        latest.current = bitmap
        draw()
        setFrame(previous => (previous?.width === f.width && previous.height === f.height ? previous : { width: f.width, height: f.height }))
      }, () => {})
    })
    return () => {
      alive = false
      offState(); offFrame()
      latest.current?.close()
      latest.current = null
    }
  }, [bridge])

  // The page is drawn at the viewport's size; no frames while the panel is gone.
  useEffect(() => {
    const element = viewport.current
    if (element === null) return
    const report = () => {
      const { width, height } = element.getBoundingClientRect()
      void bridge.show(width > 50 && height > 50 ? { width: Math.floor(width), height: Math.floor(height) } : null)
    }
    const observer = new ResizeObserver(report)
    observer.observe(element)
    report()
    return () => { observer.disconnect(); void bridge.show(null) }
  }, [bridge])

  /** The latest frame onto the canvas, at the page's own size (CSS stretches it to the viewport). */
  function draw() {
    const target = canvas.current
    const bitmap = latest.current
    if (target === null || bitmap === null) return
    if (target.width !== bitmap.width || target.height !== bitmap.height) { target.width = bitmap.width; target.height = bitmap.height }
    target.getContext('2d')?.drawImage(bitmap, 0, 0)
  }
  // A canvas mounted after the frame arrived (the first one) gets it now.
  useEffect(draw, [frame])

  const act = (work: Promise<unknown>) => { setError(null); work.catch(e => setError(e instanceof Error ? e.message : String(e))) }

  /** Where the pointer is on the page (the frame may be drawn at another size than the page). */
  const at = (e: MouseEvent | WheelEvent) => {
    const box = (e.currentTarget as HTMLElement).getBoundingClientRect()
    const scaleX = frame === null ? 1 : frame.width / box.width
    const scaleY = frame === null ? 1 : frame.height / box.height
    return { x: Math.round((e.clientX - box.left) * scaleX), y: Math.round((e.clientY - box.top) * scaleY) }
  }
  const modifiers = (e: { shiftKey: boolean; ctrlKey: boolean; altKey: boolean; metaKey: boolean }) =>
    [e.shiftKey && 'shift', e.ctrlKey && 'control', e.altKey && 'alt', e.metaKey && 'meta'].filter((m): m is string => m !== false)
  const button = (n: number) => (n === 1 ? 'middle' : n === 2 ? 'right' : 'left') as 'left' | 'middle' | 'right'
  const send = (event: BrowserInput) => bridge.input(event)

  const onMouseDown = (e: MouseEvent) => {
    e.preventDefault()
    // Keys go to the page through the hidden field (an input method needs a real one).
    typing.current?.focus()
    send({ type: 'mouseDown', ...at(e), button: button(e.button), clickCount: e.detail, modifiers: modifiers(e) })
  }
  const onMouseUp = (e: MouseEvent) => send({ type: 'mouseUp', ...at(e), button: button(e.button), clickCount: e.detail, modifiers: modifiers(e) })
  const onMouseMove = (e: MouseEvent) => {
    const now = Date.now()
    if (e.buttons === 0 && now - lastMove.current < 50) return
    lastMove.current = now
    send({ type: 'mouseMove', ...at(e), modifiers: modifiers(e) })
  }
  const onWheel = (e: WheelEvent) => send({ type: 'mouseWheel', ...at(e), deltaX: -e.deltaX, deltaY: -e.deltaY, canScroll: true, modifiers: modifiers(e) })

  /** Keys the page gets as keys; everything printable comes as text. */
  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (composing.current || e.nativeEvent.isComposing) return
    const named: Record<string, string> = {
      Enter: 'Enter', Backspace: 'Backspace', Tab: 'Tab', Escape: 'Escape', Delete: 'Delete', Home: 'Home', End: 'End',
      PageUp: 'PageUp', PageDown: 'PageDown', ArrowUp: 'Up', ArrowDown: 'Down', ArrowLeft: 'Left', ArrowRight: 'Right',
    }
    const shortcut = (e.ctrlKey || e.metaKey || e.altKey) && e.key.length === 1
    const keyCode = named[e.key] ?? (shortcut ? e.key.toUpperCase() : undefined)
    if (keyCode === undefined) return
    e.preventDefault()
    const mods = modifiers(e)
    send({ type: 'keyDown', keyCode, modifiers: mods })
    if (keyCode === 'Enter') send({ type: 'char', keyCode: '\r', modifiers: mods })
    send({ type: 'keyUp', keyCode, modifiers: mods })
  }
  const flushText = () => {
    const field = typing.current
    if (field === null || field.value === '') return
    const text = field.value
    field.value = ''
    void bridge.text(text)
  }

  const go = () => {
    const url = address.trim()
    if (url === '') return
    setEditing(false)
    act(bridge.navigate({ url, ...(shown === undefined ? { newTab: true } : {}) }))
  }

  const working = state !== null && Date.now() - state.agentAt < 5000
  // The note goes once the agent has been quiet a while: draw again then.
  const [, redraw] = useState(0)
  useEffect(() => {
    if (!working || state === null) return
    const timer = setTimeout(() => redraw(n => n + 1), state.agentAt + 5000 - Date.now() + 50)
    return () => clearTimeout(timer)
  }, [working, state])

  return (
    <aside className="browser-panel" aria-label="内置浏览器">
      <div className="browser-toolbar">
        <button type="button" className="icon-button" title="后退" aria-label="后退" disabled={shown?.canGoBack !== true} onClick={() => act(bridge.navigate({ action: 'back' }))}><Icon name="back" /></button>
        <button type="button" className="icon-button" title="前进" aria-label="前进" disabled={shown?.canGoForward !== true} onClick={() => act(bridge.navigate({ action: 'forward' }))}><Icon name="chevron" /></button>
        <button type="button" className="icon-button" title="刷新" aria-label="刷新" disabled={shown === undefined} onClick={() => act(bridge.navigate({ action: 'reload' }))}><Icon name="refresh" /></button>
        <input className="text-input browser-address" value={address} placeholder="输入网址，回车打开" aria-label="网址"
          onFocus={e => { setEditing(true); e.target.select() }} onBlur={() => setEditing(false)}
          onChange={e => setAddress(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing) go(); if (e.key === 'Escape') (e.target as HTMLInputElement).blur() }} />
        <button type="button" className="icon-button" title="关闭浏览器面板（页面保留）" aria-label="关闭浏览器面板" onClick={onClose}><Icon name="close" /></button>
      </div>
      {state !== null && state.tabs.length > 0 && (
        <div className="browser-tabs" role="tablist" aria-label="标签页">
          {state.tabs.map(tab => (
            <span key={tab.id} className={`browser-tab${tab.id === state.shown ? ' active' : ''}`}>
              <button type="button" role="tab" aria-selected={tab.id === state.shown} title={tab.url} onClick={() => act(bridge.select(tab.id))}>
                {tab.loading && <span className="pill-dot" />}{tab.title === '' ? tab.url : tab.title}
              </button>
              <button type="button" className="browser-tab-close" title="关闭标签页" aria-label={`关闭 ${tab.title}`} onClick={() => act(bridge.close(tab.id))}><Icon name="close" /></button>
            </span>
          ))}
          <button type="button" className="browser-tab-new" title="新标签页" aria-label="新标签页" onClick={() => { setAddress(''); act(bridge.navigate({ url: 'about:blank', newTab: true })) }}><Icon name="plus" /></button>
        </div>
      )}
      {working && <div className="browser-status"><span className="pill-dot" />agent 正在操作这个页面，你也可以直接接手</div>}
      {error !== null && <div className="banner error">{error}</div>}
      <div className="browser-viewport" ref={viewport}>
        {shown === undefined ? (
          <div className="empty">还没有打开网页：在上面输入网址，或者让 agent 去打开。<br />内置浏览器不保存登录，也不能下载文件。</div>
        ) : frame === null ? (
          <div className="empty">正在载入…</div>
        ) : (
          <canvas ref={canvas} className="browser-frame" aria-label={shown.title}
            onMouseDown={onMouseDown} onMouseUp={onMouseUp} onMouseMove={onMouseMove} onWheel={onWheel}
            onContextMenu={e => e.preventDefault()} />
        )}
        <textarea ref={typing} className="browser-typing" aria-label="在页面里输入" tabIndex={-1}
          onKeyDown={onKeyDown}
          onCompositionStart={() => { composing.current = true }}
          onCompositionEnd={() => { composing.current = false; flushText() }}
          onInput={() => { if (!composing.current) flushText() }} />
      </div>
    </aside>
  )
}

