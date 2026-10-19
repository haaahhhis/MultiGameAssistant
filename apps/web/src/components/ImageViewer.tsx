import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { desktop } from '../desktop.ts'

type Tool = 'rect' | 'arrow' | 'line' | 'pen'
/** A mark in image pixels; `width` too, so it looks the same on screen as when drawn and in the copy. */
type Mark =
  | { readonly kind: 'rect' | 'arrow' | 'line'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly color: string; readonly width: number }
  | { readonly kind: 'pen'; readonly points: readonly (readonly [number, number])[]; readonly color: string; readonly width: number }

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#000000', '#ffffff']
const TOOLS: readonly [Tool, string][] = [['rect', '框'], ['arrow', '箭头'], ['line', '直线'], ['pen', '画笔']]
/** Line widths in screen pixels at the moment of drawing. */
const WIDTHS: readonly [number, string][] = [[2, '细'], [4, '中'], [7, '粗']]
const MIN_SCALE = 0.05
const MAX_SCALE = 16
const BAR = 44 // title bar + bottom bar height, roughly, per bar

/**
 * A picture in a floating window, like a chat app's image viewer: zoom and
 * pan, rotate, simple marks (box, arrow, line, pen) in thin lines, copy to
 * the clipboard with the marks drawn in (a finished mark is copied by itself
 * unless turned off), save. The page behind stays usable.
 */
export function ImageViewer({ src: original, width: w0, height: h0, name, onClose }: { src: string; width: number; height: number; name: string; onClose: () => void }) {
  const [image, setImage] = useState({ src: original, width: w0, height: h0 })
  const { src, width, height } = image
  const stage = useRef<HTMLDivElement>(null)
  const frame = useRef<HTMLDivElement>(null)
  const [box, setBox] = useState(() => initialBox(w0, h0))
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [marking, setMarking] = useState(false)
  const [tool, setTool] = useState<Tool>('rect')
  const [color, setColor] = useState(COLORS[0]!)
  const [lineWidth, setLineWidth] = useState(WIDTHS[0]![0])
  const [marks, setMarks] = useState<Mark[]>([])
  const [draft, setDraft] = useState<Mark | null>(null)
  const [autoCopy, setAutoCopy] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const drag = useRef<{ kind: 'pan'; sx: number; sy: number; ox: number; oy: number } | { kind: 'mark' } | null>(null)
  const move = useRef<{ sx: number; sy: number; ox: number; oy: number } | null>(null)

  const fit = useCallback(() => {
    const area = stage.current?.getBoundingClientRect()
    if (area === undefined || area.width === 0) return
    const scale = Math.min(MAX_SCALE, (area.width - 24) / width, (area.height - 24) / height)
    setView({ scale, x: (area.width - width * scale) / 2, y: (area.height - height * scale) / 2 })
  }, [width, height])
  useLayoutEffect(fit, [fit])
  // Refit when the window is resized by its corner.
  useEffect(() => {
    const el = stage.current
    if (el === null || typeof ResizeObserver === 'undefined') return
    const observer = new ResizeObserver(() => fit())
    observer.observe(el)
    return () => observer.disconnect()
  }, [fit])

  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const area = stage.current?.getBoundingClientRect()
    if (area === undefined) return
    const px = cx ?? area.width / 2
    const py = cy ?? area.height / 2
    setView(v => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
      const k = scale / v.scale
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    })
  }
  const actual = () => {
    const area = stage.current?.getBoundingClientRect()
    if (area === undefined) return
    setView({ scale: 1, x: (area.width - width) / 2, y: (area.height - height) / 2 })
  }

  // Wheel zoom around the pointer; React's wheel listener is passive, so attach it directly.
  useEffect(() => {
    const el = stage.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const area = el.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - area.left, e.clientY - area.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const flash = (text: string) => {
    setToast(text)
    setTimeout(() => setToast(t => (t === text ? null : t)), 1800)
  }

  /** The picture with the marks drawn in, at its own size. */
  const render = useCallback(async (list: readonly Mark[], rotate = 0): Promise<HTMLCanvasElement> => {
    const img = new Image()
    img.src = src
    await img.decode()
    const flat = document.createElement('canvas')
    flat.width = width
    flat.height = height
    const g = flat.getContext('2d')!
    g.drawImage(img, 0, 0, width, height)
    for (const m of list) drawMark(g, m)
    if (rotate === 0) return flat
    const out = document.createElement('canvas')
    out.width = height
    out.height = width
    const r = out.getContext('2d')!
    r.translate(height / 2, width / 2)
    r.rotate(rotate)
    r.drawImage(flat, -width / 2, -height / 2)
    return out
  }, [src, width, height])

  const copy = useCallback(async (list: readonly Mark[]) => {
    try {
      const canvas = await render(list)
      const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob(b => (b === null ? reject(new Error('没能生成图片')) : resolve(b)), 'image/png'))
      try {
        await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })])
      } catch (error) {
        const bridge = desktop()
        if (bridge?.copyImage === undefined) throw error
        await bridge.copyImage(canvas.toDataURL('image/png'))
      }
      flash(list.length > 0 ? '已复制（带标注）' : '已复制')
    } catch (error) {
      flash(`复制失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [render])

  const save = async () => {
    const canvas = await render(marks)
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `${name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.\w+$/, '')}${marks.length > 0 ? '-标注' : ''}.png`
    a.click()
  }

  // Rotating bakes the marks into the picture.
  const rotate = async () => {
    const canvas = await render(marks, Math.PI / 2)
    setMarks([])
    setImage({ src: canvas.toDataURL('image/png'), width: canvas.width, height: canvas.height })
  }

  const undo = () => setMarks(list => list.slice(0, -1))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (frame.current === null || !frame.current.contains(document.activeElement)) return
      if (e.key === 'Escape') { if (draft !== null) { setDraft(null); drag.current = null } else if (marking) setMarking(false); else onClose(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); void copy(marks); return }
      if (e.key === '0') fit()
      if (e.key === '+' || e.key === '=') zoomAt(1.25)
      if (e.key === '-') zoomAt(0.8)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const toImage = (e: ReactPointerEvent): [number, number] => {
    const area = stage.current!.getBoundingClientRect()
    const x = (e.clientX - area.left - view.x) / view.scale
    const y = (e.clientY - area.top - view.y) / view.scale
    return [Math.max(0, Math.min(width, x)), Math.max(0, Math.min(height, y))]
  }
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    if (!marking || e.button === 1) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }
      return
    }
    const [x, y] = toImage(e)
    const width_ = lineWidth / view.scale
    drag.current = { kind: 'mark' }
    setDraft(tool === 'pen' ? { kind: 'pen', points: [[x, y]], color, width: width_ } : { kind: tool, x1: x, y1: y, x2: x, y2: y, color, width: width_ })
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d === null) return
    if (d.kind === 'pan') { setView(v => ({ ...v, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy })); return }
    const [x, y] = toImage(e)
    setDraft(m => (m === null ? m : m.kind === 'pen' ? { ...m, points: [...m.points, [x, y]] } : { ...m, x2: x, y2: y }))
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (d?.kind !== 'mark' || draft === null) return
    setDraft(null)
    // A click without a drag is not a mark.
    const size = draft.kind === 'pen' ? draft.points.length > 2 ? 99 : 0 : Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) * view.scale
    if (size < 4) return
    const next = [...marks, draft]
    setMarks(next)
    if (autoCopy) void copy(next)
  }

  // The window moves by its title bar.
  const onTitleDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if ((e.target as HTMLElement).closest('button') !== null) return
    e.currentTarget.setPointerCapture(e.pointerId)
    move.current = { sx: e.clientX, sy: e.clientY, ox: box.x, oy: box.y }
    // Keep a size set by dragging the corner (CSS resize), which React does not know about.
    const el = frame.current
    if (el !== null) setBox(b => ({ ...b, w: el.offsetWidth, h: el.offsetHeight }))
  }
  const onTitleMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const m = move.current
    if (m === null) return
    setBox(b => ({ ...b, x: Math.max(-b.w + 120, Math.min(window.innerWidth - 120, m.ox + e.clientX - m.sx)), y: Math.max(0, Math.min(window.innerHeight - 40, m.oy + e.clientY - m.sy)) }))
  }

  useEffect(() => { frame.current?.focus() }, [])

  return createPortal(
    <div ref={frame} className="image-viewer" role="dialog" aria-label={name} tabIndex={-1} style={{ left: box.x, top: box.y, width: box.w, height: box.h }}>
      <div className="viewer-title" onPointerDown={onTitleDown} onPointerMove={onTitleMove} onPointerUp={() => { move.current = null }} onDoubleClick={fit}>
        <span className="viewer-name">{name}</span>
        <span className="viewer-dim">{width}×{height}</span>
        <button className="viewer-icon" onClick={onClose} title="关闭（Esc）" aria-label="关闭">✕</button>
      </div>
      <div ref={stage} className={`viewer-stage ${marking ? 'marking' : ''}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}>
        <div className="viewer-canvas" style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <img src={src} alt={name} width={width} height={height} draggable={false} />
          <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
            {[...marks, ...(draft === null ? [] : [draft])].map((m, i) => <MarkShape key={i} mark={m} />)}
          </svg>
        </div>
        {toast !== null && <div className="viewer-toast" role="status">{toast}</div>}
      </div>
      {marking && (
        <div className="viewer-marks">
          <div className="viewer-group" role="radiogroup" aria-label="标注工具">
            {TOOLS.map(([id, label]) => <button key={id} role="radio" aria-checked={tool === id} className={`viewer-icon ${tool === id ? 'active' : ''}`} title={label} onClick={() => setTool(id)}><ToolGlyph tool={id} /></button>)}
          </div>
          <span className="viewer-sep" />
          <div className="viewer-group" role="radiogroup" aria-label="粗细">
            {WIDTHS.map(([px, label]) => (
              <button key={px} role="radio" aria-checked={lineWidth === px} className={`viewer-icon ${lineWidth === px ? 'active' : ''}`} title={label} onClick={() => setLineWidth(px)}>
                <span className="width-dot" style={{ width: px + 3, height: px + 3 }} />
              </button>
            ))}
          </div>
          <span className="viewer-sep" />
          <div className="viewer-group" role="radiogroup" aria-label="颜色">
            {COLORS.map(c => <button key={c} role="radio" aria-checked={color === c} aria-label={c} className={`swatch ${color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />)}
          </div>
          <span className="viewer-sep" />
          <button className="viewer-icon" disabled={marks.length === 0} onClick={undo} title="撤销（Ctrl+Z）">↶</button>
          <label className="viewer-check" title="每画完一笔就把带标注的图片复制到剪贴板"><input type="checkbox" checked={autoCopy} onChange={e => setAutoCopy(e.target.checked)} />自动复制</label>
        </div>
      )}
      <div className="viewer-bar">
        <button className="viewer-icon" onClick={() => zoomAt(0.8)} title="缩小">－</button>
        <button className="viewer-zoom" onClick={fit} title="适应窗口（0）">{Math.round(view.scale * 100)}%</button>
        <button className="viewer-icon" onClick={() => zoomAt(1.25)} title="放大">＋</button>
        <button className="viewer-icon" onClick={actual} title="原始大小">1:1</button>
        <span className="viewer-sep" />
        <button className="viewer-icon" onClick={() => void rotate()} title="旋转">⟳</button>
        <button className={`viewer-icon ${marking ? 'active' : ''}`} onClick={() => setMarking(m => !m)} title="标注：画框、箭头、直线">✎</button>
        <button className="viewer-icon" onClick={() => void copy(marks)} title="复制（Ctrl+C）">⧉</button>
        <button className="viewer-icon" onClick={() => void save()} title="保存">⤓</button>
      </div>
    </div>,
    document.body,
  )
}

function initialBox(width: number, height: number): { x: number; y: number; w: number; h: number } {
  const maxW = Math.round(window.innerWidth * 0.7)
  const maxH = Math.round(window.innerHeight * 0.78) - BAR * 2
  const scale = Math.min(1, maxW / width, maxH / height)
  const w = Math.max(420, Math.round(width * scale) + 24)
  const h = Math.max(300, Math.round(height * scale) + 24 + BAR * 2)
  return { x: Math.round((window.innerWidth - w) / 2), y: Math.max(16, Math.round((window.innerHeight - h) / 2)), w, h }
}

function ToolGlyph({ tool }: { tool: Tool }) {
  const d = { rect: 'M5 6h14v12H5z', arrow: 'M5 19 19 5M10 5h9v9', line: 'M5 19 19 5', pen: 'M4 20c3-1 4-5 7-8s6-6 9-8' }[tool]
  return <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true"><path d={d} /></svg>
}

function arrowHead(m: { x1: number; y1: number; x2: number; y2: number; width: number }): [number, number][] {
  const angle = Math.atan2(m.y2 - m.y1, m.x2 - m.x1)
  const size = m.width * 4.5
  return [-0.5, 0.5].map(d => [m.x2 - size * Math.cos(angle + d), m.y2 - size * Math.sin(angle + d)])
}

function MarkShape({ mark: m }: { mark: Mark }) {
  const common = { stroke: m.color, strokeWidth: m.width, strokeLinecap: 'round' as const, strokeLinejoin: 'round' as const, fill: 'none' }
  if (m.kind === 'pen') return <polyline {...common} points={m.points.map(p => p.join(',')).join(' ')} />
  if (m.kind === 'rect') return <rect {...common} x={Math.min(m.x1, m.x2)} y={Math.min(m.y1, m.y2)} width={Math.abs(m.x2 - m.x1)} height={Math.abs(m.y2 - m.y1)} />
  const head = m.kind === 'arrow' ? arrowHead(m) : []
  return (
    <g {...common}>
      <line x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} />
      {head.length > 0 && <polyline points={`${head[0]![0]},${head[0]![1]} ${m.x2},${m.y2} ${head[1]![0]},${head[1]![1]}`} />}
    </g>
  )
}

function drawMark(g: CanvasRenderingContext2D, m: Mark): void {
  g.strokeStyle = m.color
  g.lineWidth = m.width
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.beginPath()
  if (m.kind === 'pen') {
    m.points.forEach(([x, y], i) => (i === 0 ? g.moveTo(x, y) : g.lineTo(x, y)))
  } else if (m.kind === 'rect') {
    g.rect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1))
  } else {
    g.moveTo(m.x1, m.y1)
    g.lineTo(m.x2, m.y2)
    if (m.kind === 'arrow') {
      const [a, b] = arrowHead(m)
      g.moveTo(a![0], a![1])
      g.lineTo(m.x2, m.y2)
      g.lineTo(b![0], b![1])
    }
  }
  g.stroke()
}
