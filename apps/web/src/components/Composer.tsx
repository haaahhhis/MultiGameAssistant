import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { MAX_IMAGE_BASE64, type PromptImage } from '@adg/protocol'
import type { SessionHandle, AdgClient } from '@adg/client-core'
import { readDraft, readDraftImages, saveDraft, saveDraftImages } from '../drafts.ts'
import { usePermissionMode, useStore } from '../hooks.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { Icon, StopGlyph } from './Icons.tsx'

export function Composer({ client, session, running, disabled, initialPrompt, onInitialSent }: {
  client: AdgClient
  session: SessionHandle
  running: boolean
  disabled: boolean
  initialPrompt?: string | undefined
  onInitialSent?: (() => void) | undefined
}) {
  const capabilities = useStore(client.capabilities)
  // What was typed here before switching away comes back (drafts.ts).
  const [text, setText] = useState(() => readDraft(session.id))
  const [steer, setSteer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const picker = useRef<HTMLInputElement>(null)
  const handedOff = useRef(false)
  const [images, setImages] = useState<(PromptImage & { url: string })[]>(() => readDraftImages(session.id))
  useEffect(() => saveDraft(session.id, text), [session.id, text])
  useEffect(() => saveDraftImages(session.id, images), [session.id, images])
  const permission = usePermissionMode(client)
  const [dragging, setDragging] = useState(false)

  const addFiles = async (files: readonly File[]) => {
    const pictures = files.filter(f => f.type.startsWith('image/'))
    if (pictures.length === 0) return
    setError(null)
    const room = MAX_IMAGES - images.length
    if (room <= 0) { setError(`一条消息最多 ${MAX_IMAGES} 张图片`); return }
    try {
      const made = await Promise.all(pictures.slice(0, room).map(toPromptImage))
      setImages(list => [...list, ...made].slice(0, MAX_IMAGES))
      if (pictures.length > room) setError(`一条消息最多 ${MAX_IMAGES} 张图片，多的没有加上`)
    } catch (e) {
      setError(`图片没能加上：${e instanceof Error ? e.message : String(e)}`)
    }
  }
  const onPaste = (e: ClipboardEvent<HTMLTextAreaElement>) => {
    const files = [...e.clipboardData.items].filter(i => i.kind === 'file' && i.type.startsWith('image/')).map(i => i.getAsFile()).filter((f): f is File => f !== null)
    if (files.length === 0) return
    e.preventDefault()
    void addFiles(files)
  }
  const onDrop = (e: DragEvent<HTMLDivElement>) => {
    setDragging(false)
    if (e.dataTransfer.files.length === 0) return
    e.preventDefault()
    void addFiles([...e.dataTransfer.files])
  }

  // The home page's first message: sent once, through the same path as a typed one.
  useEffect(() => {
    if (initialPrompt === undefined || handedOff.current || disabled) return
    handedOff.current = true
    session.prompt(initialPrompt, 'queue').catch(e => setError(e instanceof Error ? e.message : String(e)))
    onInitialSent?.()
    area.current?.focus()
  }, [initialPrompt, disabled, session, onInitialSent])

  const send = () => {
    const value = text.trim()
    if ((value === '' && images.length === 0) || disabled) return
    const sending = images.map(({ url: _url, ...image }) => image)
    setText('')
    setImages([])
    setError(null)
    // The echo shows immediately; a failure is marked on it and reported here.
    session.prompt(value, running && steer ? 'steer' : 'queue', sending).catch(e => setError(e instanceof Error ? e.message : String(e)))
    area.current?.focus()
  }

  const onKeyDown = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="composer">
      {error !== null && <div className="error small composer-error">{error}</div>}
      <div className={`composer-box ${dragging ? 'dragging' : ''}`}
        onDragOver={e => { if ([...e.dataTransfer.items].some(i => i.kind === 'file')) { e.preventDefault(); setDragging(true) } }}
        onDragLeave={() => setDragging(false)} onDrop={onDrop}>
        {images.length > 0 && (
          <div className="composer-images">
            {images.map((image, index) => (
              <span key={index} className="composer-image">
                <img src={image.url} alt={image.name ?? `图片 ${index + 1}`} />
                <button type="button" aria-label="移除这张图片" onClick={() => setImages(list => list.filter((_x, i) => i !== index))}>✕</button>
              </span>
            ))}
          </div>
        )}
        <textarea
          onPaste={onPaste}
          ref={area}
          aria-label="消息内容"
          value={text}
          onChange={e => setText(e.target.value)}
          onKeyDown={onKeyDown}
          rows={Math.min(8, Math.max(2, text.split('\n').length))}
          placeholder={disabled ? '未连接到 agent' : running ? '运行中：消息会排队到下一轮' : '继续追问，或描述下一步要做的事'}
          disabled={disabled}
        />
        <div className="composer-actions">
          {capabilities.has('models') && <ModelPicker client={client} sessionId={session.id} disabled={disabled} />}
          <button type="button" className="attach-button" title="添加图片（也可以直接粘贴或拖进来）" aria-label="添加图片" disabled={disabled || images.length >= MAX_IMAGES} onClick={() => picker.current?.click()}><Icon name="image" /></button>
          <input ref={picker} type="file" accept="image/png,image/jpeg,image/gif,image/webp" multiple hidden onChange={e => { void addFiles([...(e.target.files ?? [])]); e.target.value = '' }} />
          {permission === 'full' && (
            <button type="button" className="full-access-chip" title="agent 做事不再请求确认，点这里修改" onClick={() => { location.hash = '#/settings/permissions' }}><Icon name="alert" />完全访问</button>
          )}
          <span className="spacer" />
          {running && (
            <label className="steer-toggle" title="把消息插入正在进行的轮次，而不是等下一轮">
              <input type="checkbox" checked={steer} onChange={e => setSteer(e.target.checked)} />插入当前轮次
            </label>
          )}
          {running && (
            <button className="stop-button" onClick={() => void session.cancel().catch(e => setError(String(e)))} disabled={disabled}>
              <StopGlyph />停止
            </button>
          )}
          <button className="send-button" aria-label="发送" title="发送（Enter）" onClick={send} disabled={disabled || (text.trim() === '' && images.length === 0)}><Icon name="arrow" /></button>
        </div>
      </div>
      <div className="composer-hint"><span><kbd>Enter</kbd> 发送</span><span><kbd>Shift+Enter</kbd> 换行</span><span><kbd>Ctrl+V</kbd> 粘贴图片</span></div>
    </div>
  )
}

const MAX_IMAGES = 4
const KEEP_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp'])

/** A pasted or picked image as the protocol sends it: kept as is when it fits, otherwise shrunk (JPEG). */
async function toPromptImage(file: File): Promise<PromptImage & { url: string }> {
  const url = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => resolve(String(reader.result))
    reader.onerror = () => reject(reader.error ?? new Error('读取失败'))
    reader.readAsDataURL(file)
  })
  const name = file.name === '' || file.name === 'image.png' ? `粘贴的图片.${file.type.split('/')[1] ?? 'png'}` : file.name
  const data = url.slice(url.indexOf(',') + 1)
  if (KEEP_TYPES.has(file.type) && data.length <= MAX_IMAGE_BASE64) return { mediaType: file.type as PromptImage['mediaType'], data, name, url }
  const img = new Image()
  img.src = url
  await img.decode()
  for (let edge = 2560; edge >= 640; edge = Math.round(edge * 0.75)) {
    const scale = Math.min(1, edge / Math.max(img.naturalWidth, img.naturalHeight))
    const canvas = document.createElement('canvas')
    canvas.width = Math.max(1, Math.round(img.naturalWidth * scale))
    canvas.height = Math.max(1, Math.round(img.naturalHeight * scale))
    canvas.getContext('2d')!.drawImage(img, 0, 0, canvas.width, canvas.height)
    const shrunk = canvas.toDataURL('image/jpeg', 0.88)
    const body = shrunk.slice(shrunk.indexOf(',') + 1)
    if (body.length <= MAX_IMAGE_BASE64) return { mediaType: 'image/jpeg', data: body, name: name.replace(/\.\w+$/, '.jpg'), url: shrunk }
  }
  throw new Error('图片太大')
}
