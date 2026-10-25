import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { useStore } from '../hooks.ts'

const STEPS = ['准备环境', '启动服务', '载入界面', '连接 agent']
/** After this long without a connection, say why and offer to go in anyway. */
const SLOW_MS = 8000
const FADE_MS = 400

/**
 * The startup screen's last step (boot.css): it takes over from index.html's
 * first paint with the same markup, stays until the agent is connected and
 * the conversations are loaded, then fades into the app. Shown once per page
 * load; a later reconnect only shows in the rail's connection dot.
 */
export function BootScreen({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const sessions = useStore(client.sessions)
  const [phase, setPhase] = useState<'shown' | 'leaving' | 'gone'>('shown')
  const [slow, setSlow] = useState(false)
  const ready = status.state === 'open' && sessions.loaded

  useEffect(() => {
    const timer = setTimeout(() => setSlow(true), SLOW_MS)
    return () => clearTimeout(timer)
  }, [])
  useEffect(() => {
    if (ready) setPhase(p => p === 'shown' ? 'leaving' : p)
  }, [ready])
  useEffect(() => {
    if (phase !== 'leaving') return
    const timer = setTimeout(() => setPhase('gone'), FADE_MS)
    return () => clearTimeout(timer)
  }, [phase])

  if (phase === 'gone') return null
  const stage = status.state === 'open' ? '正在读取对话'
    : status.state === 'reconnecting' ? `连不上 agent，正在重试（第 ${status.attempt} 次）`
      : status.state === 'connecting' ? '正在连接 agent' : '没有连上 agent'
  const hint = slow ? (status.error !== undefined ? `连接出错：${status.error}` : '比平时慢一些，agent 服务可能还在启动。') : ''

  return (
    <div className={`boot${phase === 'leaving' ? ' leaving' : ''}`} aria-hidden={phase === 'leaving'}>
      <div className="boot-center">
        <div className="boot-mark" aria-hidden="true">
          <svg className="boot-orbit" viewBox="0 0 132 132"><circle className="track" cx="66" cy="66" r="62" /><circle className="comet" cx="66" cy="66" r="62" /></svg>
          <span className="boot-tile">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round">
              <path d="M9.5 8.3v7.4l6.2-3.7-6.2-3.7Z" /><path className="loop" d="M4 12a8 8 0 0 1 14.5-4.7M20 12a8 8 0 0 1-14.5 4.7" />
            </svg>
          </span>
        </div>
        <h1 className="boot-name">MultiGameAssistant</h1>
        <p className="boot-stage" role="status" aria-live="polite"><span>{stage}</span></p>
        <ol className="boot-steps">
          {STEPS.map((label, i) => <li key={label} className={i < 3 ? 'done' : 'now'}><i /><span>{label}</span></li>)}
        </ol>
        <p className={`boot-hint${hint !== '' ? ' shown' : ''}`}>{hint}</p>
        {slow && <button type="button" className="boot-skip" onClick={() => setPhase('leaving')}>先进入界面</button>}
      </div>
      <p className="boot-foot">日常交给 agent · 在本机运行</p>
    </div>
  )
}
