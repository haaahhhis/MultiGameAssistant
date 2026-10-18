import { useEffect, useRef, useState, type KeyboardEvent } from 'react'
import type { SessionHandle, AdgClient } from '@adg/client-core'
import { useStore } from '../hooks.ts'
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
  const [text, setText] = useState('')
  const [steer, setSteer] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const area = useRef<HTMLTextAreaElement>(null)
  const handedOff = useRef(false)

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
    if (value === '' || disabled) return
    setText('')
    setError(null)
    // The echo shows immediately; a failure is marked on it and reported here.
    session.prompt(value, running && steer ? 'steer' : 'queue').catch(e => setError(e instanceof Error ? e.message : String(e)))
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
      <div className="composer-box">
        <textarea
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
          <button className="send-button" aria-label="发送" title="发送（Enter）" onClick={send} disabled={disabled || text.trim() === ''}><Icon name="arrow" /></button>
        </div>
      </div>
      <div className="composer-hint"><span><kbd>Enter</kbd> 发送</span><span><kbd>Shift+Enter</kbd> 换行</span></div>
    </div>
  )
}
