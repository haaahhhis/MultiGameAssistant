import { useState } from 'react'
import type { ApprovalRequested } from '@adg/protocol'
import type { AdgClient } from '@adg/client-core'
import { useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'

/** Pending approvals: the current session's in full, others as a count. */
export function ApprovalDock({ client, sessionId, onSelect }: {
  client: AdgClient
  sessionId: string | null
  onSelect: (sessionId: string) => void
}) {
  const approvals = useStore(client.approvals)
  if (approvals.length === 0) return null
  const here = approvals.filter(a => a.sessionId === sessionId)
  const elsewhere = approvals.filter(a => a.sessionId !== sessionId)
  return (
    <div className="approval-dock">
      {here.map(request => <ApprovalCard key={request.approvalId} client={client} request={request} />)}
      {elsewhere.length > 0 && (
        <button className="approval-elsewhere" onClick={() => onSelect(elsewhere[0]!.sessionId)}>
          <span className="approval-dot" />另有 {elsewhere.length} 个会话在等待审批<Icon name="chevron" />
        </button>
      )}
    </div>
  )
}

function ApprovalCard({ client, request }: { client: AdgClient; request: ApprovalRequested }) {
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const reason = request.displayReason?.['zh'] ?? request.displayReason?.['zh-CN'] ?? request.displayReason?.['en'] ?? request.reason
  const answer = async (decision: 'allow-once' | 'reject') => {
    setBusy(true)
    try {
      await client.respondApproval(request.approvalId, decision)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  return (
    <div className="approval-card" role="alertdialog" aria-label="需要审批">
      <div className="approval-head">
        <Icon name="shield" />
        <div className="approval-text">
          <div className="approval-title">需要你的批准</div>
          <code className="approval-tool">{request.toolName}</code>
        </div>
      </div>
      {reason !== undefined && <div className="approval-reason">{reason}</div>}
      {error !== null && <div className="error small">{error}</div>}
      <div className="approval-actions">
        <button disabled={busy} onClick={() => void answer('reject')}>拒绝</button>
        <button className="inverse" disabled={busy} onClick={() => void answer('allow-once')}>允许本次</button>
      </div>
    </div>
  )
}
