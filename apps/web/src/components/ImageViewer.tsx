import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react'
import { createPortal } from 'react-dom'
import { desktop } from '../desktop.ts'

type Tool = 'move' | 'rect' | 'line' | 'arrow'
/** A mark in image pixels. */
interface Mark { readonly kind: 'rect' | 'line' | 'arrow'; readonly x1: number; readonly y1: number; readonly x2: number; readonly y2: number; readonly color: string }

const COLORS = ['#ff3b30', '#ffcc00', '#34c759', '#0a84ff', '#ffffff']
const TOOLS: readonly [Tool, string, string][] = [['move', '移动', 'V'], ['rect', '框', 'R'], ['line', '线', 'L'], ['arrow', '箭头', 'A']]
const MIN_SCALE = 0.05
const MAX_SCALE = 16

/**
 * A picture over the whole window: zoom (wheel, buttons), pan (drag), simple
 * marks (box, line, arrow), and copy to the clipboard with the marks drawn in;
 * a finished mark is copied by itself unless turned off.
 */
export function ImageViewer({ src, width, height, name, onClose }: { src: string; width: number; height: number; name: string; onClose: () => void }) {
  const stage = useRef<HTMLDivElement>(null)
  const [view, setView] = useState({ scale: 1, x: 0, y: 0 })
  const [tool, setTool] = useState<Tool>('rect')
  const [color, setColor] = useState(COLORS[0]!)
  const [marks, setMarks] = useState<Mark[]>([])
  const [draft, setDraft] = useState<Mark | null>(null)
  const [autoCopy, setAutoCopy] = useState(true)
  const [toast, setToast] = useState<string | null>(null)
  const drag = useRef<{ kind: 'pan'; sx: number; sy: number; ox: number; oy: number } | { kind: 'mark'; x: number; y: number } | null>(null)

  const fit = useCallback(() => {
    const box = stage.current?.getBoundingClientRect()
    if (box === undefined) return
    // Fill the window, small pictures too.
    const scale = Math.min(MAX_SCALE, (box.width - 32) / width, (box.height - 32) / height)
    setView({ scale, x: (box.width - width * scale) / 2, y: (box.height - height * scale) / 2 })
  }, [width, height])
  useLayoutEffect(fit, [fit])

  const zoomAt = (factor: number, cx?: number, cy?: number) => {
    const box = stage.current?.getBoundingClientRect()
    if (box === undefined) return
    const px = cx ?? box.width / 2
    const py = cy ?? box.height / 2
    setView(v => {
      const scale = Math.min(MAX_SCALE, Math.max(MIN_SCALE, v.scale * factor))
      const k = scale / v.scale
      return { scale, x: px - (px - v.x) * k, y: py - (py - v.y) * k }
    })
  }
  const actual = () => {
    const box = stage.current?.getBoundingClientRect()
    if (box === undefined) return
    setView({ scale: 1, x: (box.width - width) / 2, y: (box.height - height) / 2 })
  }

  // Wheel zoom around the pointer; React's wheel listener is passive, so attach it directly.
  useEffect(() => {
    const el = stage.current
    if (el === null) return
    const onWheel = (e: WheelEvent) => {
      e.preventDefault()
      const box = el.getBoundingClientRect()
      zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - box.left, e.clientY - box.top)
    }
    el.addEventListener('wheel', onWheel, { passive: false })
    return () => el.removeEventListener('wheel', onWheel)
  })

  const flash = (text: string) => {
    setToast(text)
    setTimeout(() => setToast(t => (t === text ? null : t)), 1800)
  }

  /** The picture with the marks drawn in, at its own size. */
  const render = useCallback(async (list: readonly Mark[]): Promise<HTMLCanvasElement> => {
    const img = new Image()
    img.src = src
    await img.decode()
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const g = canvas.getContext('2d')!
    g.drawImage(img, 0, 0, width, height)
    for (const m of list) drawMark(g, m, strokeOf(width, height))
    return canvas
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
      flash(list.length > 0 ? '已复制（带标注）' : '已复制到剪贴板')
    } catch (error) {
      flash(`复制失败：${error instanceof Error ? error.message : String(error)}`)
    }
  }, [render])

  const save = async () => {
    const canvas = await render(marks)
    const a = document.createElement('a')
    a.href = canvas.toDataURL('image/png')
    a.download = `${name.replace(/[\\/:*?"<>|]/g, '_').replace(/\.png$/i, '')}${marks.length > 0 ? '-标注' : ''}.png`
    a.click()
  }

  const undo = () => setMarks(list => list.slice(0, -1))

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') { if (draft !== null) { setDraft(null); drag.current = null } else onClose(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); return }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c') { e.preventDefault(); void copy(marks); return }
      const hit = TOOLS.find(([, , key]) => key === e.key.toUpperCase())
      if (hit !== undefined && !e.ctrlKey && !e.metaKey) setTool(hit[0])
      if (e.key === '0') fit()
      if (e.key === '1') actual()
      if (e.key === '+' || e.key === '=') zoomAt(1.25)
      if (e.key === '-') zoomAt(0.8)
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  })

  const toImage = (e: ReactPointerEvent) => {
    const box = stage.current!.getBoundingClientRect()
    const x = (e.clientX - box.left - view.x) / view.scale
    const y = (e.clientY - box.top - view.y) / view.scale
    return { x: Math.max(0, Math.min(width, x)), y: Math.max(0, Math.min(height, y)) }
  }
  const onDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0 && e.button !== 1) return
    e.currentTarget.setPointerCapture(e.pointerId)
    // The 移动 tool or the middle button pans; the other tools draw.
    if (tool === 'move' || e.button === 1) {
      drag.current = { kind: 'pan', sx: e.clientX, sy: e.clientY, ox: view.x, oy: view.y }
      return
    }
    const p = toImage(e)
    drag.current = { kind: 'mark', x: p.x, y: p.y }
    setDraft({ kind: tool, x1: p.x, y1: p.y, x2: p.x, y2: p.y, color })
  }
  const onMove = (e: ReactPointerEvent<HTMLDivElement>) => {
    const d = drag.current
    if (d === null) return
    if (d.kind === 'pan') { setView(v => ({ ...v, x: d.ox + e.clientX - d.sx, y: d.oy + e.clientY - d.sy })); return }
    const p = toImage(e)
    setDraft(m => (m === null ? m : { ...m, x2: p.x, y2: p.y }))
  }
  const onUp = () => {
    const d = drag.current
    drag.current = null
    if (d?.kind !== 'mark' || draft === null) return
    setDraft(null)
    // A click without a drag is not a mark.
    if (Math.hypot(draft.x2 - draft.x1, draft.y2 - draft.y1) * view.scale < 4) return
    const next = [...marks, draft]
    setMarks(next)
    if (autoCopy) void copy(next)
  }

  const stroke = strokeOf(width, height)
  return createPortal(
    <div className="image-viewer" role="dialog" aria-modal="true" aria-label={name}>
      <div className="viewer-bar">
        <div className="viewer-group" role="radiogroup" aria-label="工具">
          {TOOLS.map(([id, label, key]) => (
            <button key={id} role="radio" aria-checked={tool === id} className={tool === id ? 'active' : ''} title={`${label}（${key}）`} onClick={() => setTool(id)}>{label}</button>
          ))}
        </div>
        <div className="viewer-group" role="radiogroup" aria-label="颜色">
          {COLORS.map(c => <button key={c} role="radio" aria-checked={color === c} aria-label={c} className={`swatch ${color === c ? 'active' : ''}`} style={{ background: c }} onClick={() => setColor(c)} />)}
        </div>
        <div className="viewer-group">
          <button disabled={marks.length === 0} onClick={undo} title="撤销（Ctrl+Z）">撤销</button>
          <button disabled={marks.length === 0} onClick={() => setMarks([])}>清除标注</button>
        </div>
        <div className="viewer-group">
          <button onClick={() => zoomAt(0.8)} title="缩小（-）">−</button>
          <span className="viewer-zoom">{Math.round(view.scale * 100)}%</span>
          <button onClick={() => zoomAt(1.25)} title="放大（+）">＋</button>
          <button onClick={fit} title="适应窗口（0）">适应</button>
          <button onClick={actual} title="原始大小（1）">1:1</button>
        </div>
        <span className="viewer-spacer" />
        <label className="viewer-check"><input type="checkbox" checked={autoCopy} onChange={e => setAutoCopy(e.target.checked)} />标注后自动复制</label>
        <button className="viewer-primary" onClick={() => void copy(marks)} title="复制（Ctrl+C）">复制</button>
        <button onClick={() => void save()}>保存</button>
        <button onClick={onClose} title="关闭（Esc）" aria-label="关闭">✕</button>
      </div>
      <div ref={stage} className={`viewer-stage tool-${tool}`} onPointerDown={onDown} onPointerMove={onMove} onPointerUp={onUp} onPointerCancel={onUp}
        onDoubleClick={e => { if (tool === 'move' && e.target === e.currentTarget) onClose() }}>
        <div className="viewer-canvas" style={{ width, height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})` }}>
          <img src={src} alt={name} width={width} height={height} draggable={false} />
          <svg viewBox={`0 0 ${width} ${height}`} width={width} height={height} aria-hidden="true">
            {[...marks, ...(draft === null ? [] : [draft])].map((m, i) => <MarkShape key={i} mark={m} stroke={stroke} />)}
          </svg>
        </div>
        {toast !== null && <div className="viewer-toast" role="status">{toast}</div>}
      </div>
      <div className="viewer-hint">{width}×{height} · 滚轮缩放，「移动」或鼠标中键拖动画面；画好框或线后会自动复制，可以直接粘贴到对话或别的程序里 · Esc 关闭</div>
    </div>,
    document.body,
  )
}

/** Line width in image pixels: visible at any picture size. */
function strokeOf(width: number, height: number): number {
  return Math.max(2, Math.round(Math.max(width, height) / 400))
}

function arrowHead(m: Mark, stroke: number): [number, number][] {
  const angle = Math.atan2(m.y2 - m.y1, m.x2 - m.x1)
  const size = stroke * 5
  return [-0.45, 0.45].map(d => [m.x2 - size * Math.cos(angle + d), m.y2 - size * Math.sin(angle + d)])
}

function MarkShape({ mark: m, stroke }: { mark: Mark; stroke: number }) {
  if (m.kind === 'rect') {
    return <rect x={Math.min(m.x1, m.x2)} y={Math.min(m.y1, m.y2)} width={Math.abs(m.x2 - m.x1)} height={Math.abs(m.y2 - m.y1)} fill="none" stroke={m.color} strokeWidth={stroke} />
  }
  const head = m.kind === 'arrow' ? arrowHead(m, stroke) : []
  return (
    <g stroke={m.color} strokeWidth={stroke} strokeLinecap="round" strokeLinejoin="round" fill="none">
      <line x1={m.x1} y1={m.y1} x2={m.x2} y2={m.y2} />
      {head.length > 0 && <polyline points={`${head[0]![0]},${head[0]![1]} ${m.x2},${m.y2} ${head[1]![0]},${head[1]![1]}`} />}
    </g>
  )
}

function drawMark(g: CanvasRenderingContext2D, m: Mark, stroke: number): void {
  g.strokeStyle = m.color
  g.lineWidth = stroke
  g.lineCap = 'round'
  g.lineJoin = 'round'
  g.beginPath()
  if (m.kind === 'rect') {
    g.rect(Math.min(m.x1, m.x2), Math.min(m.y1, m.y2), Math.abs(m.x2 - m.x1), Math.abs(m.y2 - m.y1))
  } else {
    g.moveTo(m.x1, m.y1)
    g.lineTo(m.x2, m.y2)
    if (m.kind === 'arrow') {
      const [a, b] = arrowHead(m, stroke)
      g.moveTo(a![0], a![1])
      g.lineTo(m.x2, m.y2)
      g.lineTo(b![0], b![1])
    }
  }
  g.stroke()
}
