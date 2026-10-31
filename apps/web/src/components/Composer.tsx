import { useEffect, useRef, useState, type ClipboardEvent, type DragEvent, type KeyboardEvent } from 'react'
import { localCommand, MAX_IMAGE_BASE64, type PromptImage, type QueuedPrompt } from '@adg/protocol'
import type { SessionHandle, AdgClient } from '@adg/client-core'
import { readDraft, readDraftImages, saveDraft, saveDraftImages } from '../drafts.ts'
import { usePermissionMode, useStore } from '../hooks.ts'
import { ModelPicker } from './ModelPicker.tsx'
import { Icon, StopGlyph } from './Icons.tsx'
import { useSlash } from './SlashMenu.tsx'
import { ContextMeter } from './ContextMeter.tsx'

export function Composer({ client, session, running, disabled, initialPrompt, onInitialSent }: {
  client: AdgClient
  session: SessionHandle
  running: boolean
  disabled: boolean
  initialPrompt?: string | undefined
  onInitialSent?: (() => void) | undefined
}) {
  const capabilities = useStore(client.capabilities)
  const { queue, context } = useStore(session.state)
  // What was typed here before switching away comes back (drafts.ts).
  const [text, setText] = useState(() => readDraft(session.id))
  const [steer, setSteer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  /** What /压缩 is doing or did. */
  const [note, setNote] = useState<string | null>(null)
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

  // The app's own commands (/压缩): done here, nothing is sent. @returns whether `typed` was one.
  const runLocal = (typed: string): boolean => {
    if (localCommand(typed) !== 'compact') return false
    setText('')
    setError(null)
    if (running) { setError('agent 正在工作，等它停下再压缩'); return true }
    if (!window.confirm(COMPACT_WARNING)) return true
    setNote('正在压缩对话：模型在写摘要，可能要一两分钟…')
    session.compact().then(r => setNote(r.message), e => { setNote(null); setError(e instanceof Error ? e.message : String(e)) })
    return true
  }

  // Slash commands and skills (SlashMenu.tsx): a command goes out as its full instruction, headed by what was typed.
  const slash = useSlash({
    client, text, setText, area, inSession: true,
    submit: typed => {
      if (disabled || runLocal(typed)) return
      setError(null)
      session.prompt(slash.expand(typed), running && steer ? 'steer' : 'queue').catch(e => setError(e instanceof Error ? e.message : String(e)))
    },
  })

  const send = () => {
    if (!disabled && images.length === 0 && runLocal(text)) return
    const value = slash.expand(text)
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
    if (slash.onKeyDown(e)) return
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      send()
    }
  }

  // A waiting message taken back comes back into the box, unless something new is being typed.
  const withdraw = (item: QueuedPrompt) => {
    session.updateQueue(item.id, 'remove').then(() => {
      if (text.trim() === '' && item.text !== '') setText(item.text)
    }, e => setError(e instanceof Error ? e.message : String(e)))
  }
  const insert = (item: QueuedPrompt) => {
    session.updateQueue(item.id, 'steer').catch(e => setError(e instanceof Error ? e.message : String(e)))
  }

  return (
    <div className="composer">
      {error !== null && <div className="error small composer-error">{error}</div>}
      {note !== null && (
        <div className="composer-note small" role="status">
          <span>{note}</span>
          <button type="button" className="ghost small-button" onClick={() => setNote(null)}>知道了</button>
        </div>
      )}
      {queue.length > 0 && (
        <div className="queue" aria-label="等待发送的消息">
          {queue.map(item => (
            <div key={item.id} className="queue-item">
              <span className={`queue-tag ${item.placement}`}>{item.placement === 'next-step' ? '插入中' : '排队中'}</span>
              <span className="queue-text" title={item.text}>{item.text === '' ? '（图片）' : item.text}{item.images !== undefined && <span className="muted"> · {item.images} 张图片</span>}</span>
              <span className="queue-when muted">{item.placement === 'next-step' ? '这一步做完就交给 agent' : '这一轮结束后发送'}</span>
              {item.placement === 'next-turn' && running && <button type="button" className="small-button" title="不等这一轮结束，现在就交给 agent" onClick={() => insert(item)}>现在插入</button>}
              <button type="button" className="small-button" title="撤回这条消息" onClick={() => withdraw(item)}>撤回</button>
            </div>
          ))}
        </div>
      )}
      <div className="slash-anchor">
      {slash.menu}
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
          <ContextMeter context={context} />
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
      </div>
      <div className="composer-hint"><span><kbd>/</kbd> 命令和技能</span><span><kbd>Enter</kbd> 发送</span><span><kbd>Shift+Enter</kbd> 换行</span><span><kbd>Ctrl+V</kbd> 粘贴图片</span></div>
    </div>
  )
}

/** What /压缩 costs, said before it happens. */
const COMPACT_WARNING = [
  '压缩会把这个对话较早的部分换成一份由模型写的摘要，之后 agent 只能看到这份摘要：',
  '',
  '· 会丢失记忆：早先的细节 agent 不再记得（具体的命令和输出、日志、截图、你说过的原话）；',
  '· 摘要可能漏掉或写错内容；',
  '· 不能撤销。界面上的聊天记录还在，但 agent 看不到了。',
  '',
  '对话很长、回复变慢或报上下文超长时再压缩。确定压缩吗？',
].join('\n')

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
