import { useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ScriptInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow } from '../../hooks.ts'
import { errorText } from './data.ts'

/** A summary still "running" after this long was cut off (the app restarted, say). */
const STALE_MS = 15 * 60_000

/** 简介: what the agent made of the script (its README, files, pack), on request. */
export function SummaryCard({ client, script, openSession }: { client: AdgClient; script: ScriptInfo; openSession: (sessionId: string) => void }) {
  const now = useNow(30_000)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const summary = script.summary
  const running = summary?.state === 'running' && now - summary.at < STALE_MS
  const text = summary?.state === 'failed' ? undefined : summary?.text

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      await client.connection.call('scripts/summarize', { id: script.id })
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section className="card script-summary">
      <div className="card-head">
        <div>
          <h3>简介</h3>
          <p className="muted small">
            {running ? 'agent 正在看它的说明和文件…'
              : summary === undefined ? '让 AI 看看它的说明（README）、文件和脚本包，用几句话说清楚它是什么、能做什么。'
                : summary.state === 'failed' || summary.state === 'running' ? '上次总结没有完成'
                  : `AI 总结 · ${relativeTime(summary.at, now)}`}
          </p>
        </div>
        <div className="key-actions">
          {summary?.sessionId !== undefined && <button className="ghost small-button" onClick={() => openSession(summary.sessionId!)}>{running ? '看看进度' : '查看对话'}</button>}
          <button className={`${summary === undefined ? 'primary ' : ''}small-button`} disabled={busy || running} onClick={() => void start()}>
            <Icon name="sparkles" />{running ? '总结中…' : summary === undefined ? '让 AI 总结' : '重新总结'}
          </button>
        </div>
      </div>
      {text !== undefined && <p className={`summary-text ${running ? 'muted' : ''}`}>{text}</p>}
      {summary?.state === 'failed' && summary.text !== undefined && <div className="notice error left small"><Icon name="alert" /><span>{summary.text}</span></div>}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}
