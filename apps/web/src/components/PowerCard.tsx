import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { PowerStatus } from '@adg/protocol'
import { useNow, useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'

const WORD: Readonly<Record<NonNullable<PowerStatus['pending']>['action'], string>> = { sleep: '睡眠', hibernate: '休眠', shutdown: '关机' }

/** The scheduler's power state (kept awake, a sleep or shutdown on its way); undefined without the scheduler. */
export function usePowerStatus(client: AdgClient): PowerStatus | undefined {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const available = capabilities.has('schedule')
  const [power, setPower] = useState<PowerStatus | undefined>(undefined)
  useEffect(() => client.connection.on('schedule/power', setPower), [client])
  useEffect(() => {
    if (status.state !== 'open' || !available) { setPower(undefined); return }
    let live = true
    client.connection.call('schedule/power', {}).then(p => { if (live) setPower(p) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, available])
  return power
}

/** A sleep / hibernate / shutdown after a pipeline: the countdown and a button to call it off. */
export function PowerCard({ client, pending }: { client: AdgClient; pending: NonNullable<PowerStatus['pending']> }) {
  const now = useNow(1000)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const word = WORD[pending.action]
  const cancel = async () => {
    setBusy(true)
    setError(null)
    try {
      await client.connection.call('schedule/power/cancel', {})
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
    } finally {
      setBusy(false)
    }
  }
  const seconds = pending.at === undefined ? undefined : Math.max(0, Math.ceil((pending.at - now) / 1000))
  return (
    <div className="approval-card power-card" role="alertdialog" aria-label={`即将${word}`}>
      <div className="approval-head">
        <Icon name="power" />
        <div className="approval-text">
          <div className="approval-title">{seconds === undefined ? `其他任务结束后${word}` : `${seconds} 秒后${word}`}</div>
          <span className="approval-tool">「{pending.pipelineName}」设置了结束后{word}</span>
        </div>
      </div>
      {pending.action === 'shutdown' && seconds !== undefined && <div className="approval-reason">关机会强制关闭所有程序，没保存的内容会丢失。</div>}
      {error !== null && <div className="error small">{error}</div>}
      <div className="approval-actions">
        <button className="inverse" disabled={busy} onClick={() => void cancel()}>取消{word}</button>
      </div>
    </div>
  )
}
