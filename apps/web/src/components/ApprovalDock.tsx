import { useState } from 'react'
import type { ApprovalRequested, QuestionAnswerItem, QuestionItem, QuestionRequested } from '@adg/protocol'
import type { AdgClient } from '@adg/client-core'
import { useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'
import { PowerCard, usePowerStatus } from './PowerCard.tsx'
import { UpdateCard } from './Updates.tsx'

/**
 * Pending approvals and the agent's questions: the current session's in full,
 * others as a count; and a sleep or shutdown on its way after a pipeline, on
 * every page.
 */
export function ApprovalDock({ client, sessionId, onSelect }: {
  client: AdgClient
  sessionId: string | null
  onSelect: (sessionId: string) => void
}) {
  const approvals = useStore(client.approvals)
  const questions = useStore(client.questions)
  const pending = usePowerStatus(client)?.pending
  const here = approvals.filter(a => a.sessionId === sessionId)
  const asked = questions.filter(q => q.sessionId === sessionId)
  const elsewhere = [...approvals, ...questions].filter(a => a.sessionId !== sessionId)
  const waiting = elsewhere.some(e => 'approvalId' in e) ? (elsewhere.some(e => 'questionId' in e) ? '审批或回答' : '审批') : '回答'
  return (
    <div className="approval-dock">
      {pending !== undefined && <PowerCard client={client} pending={pending} />}
      {asked.map(request => <QuestionCard key={request.questionId} client={client} request={request} />)}
      {here.map(request => <ApprovalCard key={request.approvalId} client={client} request={request} />)}
      {elsewhere.length > 0 && (
        <button className="approval-elsewhere" onClick={() => onSelect(elsewhere[0]!.sessionId)}>
          <span className="approval-dot" />另有 {new Set(elsewhere.map(e => e.sessionId)).size} 个会话在等你{waiting}<Icon name="chevron" />
        </button>
      )}
      <UpdateCard />
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

/** A choice per question (several where allowed), or text typed instead. */
interface Draft { selected: string[]; custom: string }

/**
 * The agent's question (dsh's ask_user_question). One question with plain
 * choices answers on the click; otherwise choose, then 「回答」.
 */
function QuestionCard({ client, request }: { client: AdgClient; request: QuestionRequested }) {
  const [drafts, setDrafts] = useState<Record<string, Draft>>({})
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const single = request.questions.length === 1 && request.questions[0]!.multiSelect !== true && (request.questions[0]!.options?.length ?? 0) > 0
  const draft = (id: string): Draft => drafts[id] ?? { selected: [], custom: '' }
  const send = async (answers: QuestionAnswerItem[]) => {
    setBusy(true)
    setError(null)
    try {
      await client.answerQuestion(request.questionId, answers)
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e))
      setBusy(false)
    }
  }
  const choose = (item: QuestionItem, label: string) => {
    if (single) return void send([{ id: item.id, selected: [label] }])
    setDrafts(d => {
      const current = d[item.id] ?? { selected: [], custom: '' }
      const selected = item.multiSelect === true
        ? (current.selected.includes(label) ? current.selected.filter(l => l !== label) : [...current.selected, label])
        : (current.selected.includes(label) ? [] : [label])
      return { ...d, [item.id]: { ...current, selected } }
    })
  }
  const typed = (item: QuestionItem, custom: string) => setDrafts(d => ({ ...d, [item.id]: { ...(d[item.id] ?? { selected: [] }), custom } }))
  const answers = (): QuestionAnswerItem[] => request.questions.map(q => {
    const { selected, custom } = draft(q.id)
    const text = custom.trim()
    // Text typed for a one-choice question replaces the choice.
    return { id: q.id, selected: text !== '' && q.multiSelect !== true ? [] : selected, ...(text === '' ? {} : { custom: text }) }
  })
  const complete = request.questions.every(q => draft(q.id).selected.length > 0 || draft(q.id).custom.trim() !== '')
  return (
    <div className="approval-card question-card" role="alertdialog" aria-label="agent 在问你">
      <div className="approval-head">
        <Icon name="chat" />
        <div className="approval-text"><div className="approval-title">agent 在问你</div></div>
      </div>
      {request.questions.map(item => (
        <div key={item.id} className="question-item">
          {item.header !== undefined && <span className="question-header">{item.header}</span>}
          <div className="question-text">{item.question}</div>
          {item.detail !== undefined && <div className="question-detail">{item.detail}</div>}
          {(item.options?.length ?? 0) > 0 && (
            <div className="question-options" role={item.multiSelect === true ? 'group' : 'radiogroup'}>
              {item.options!.map(option => {
                const on = draft(item.id).selected.includes(option.label)
                return (
                  <button key={option.label} className={`question-option${on ? ' on' : ''}`} disabled={busy}
                    role={item.multiSelect === true ? 'checkbox' : 'radio'} aria-checked={on} onClick={() => choose(item, option.label)}>
                    <span className="question-option-label">{option.label}</span>
                    {option.description !== undefined && <span className="question-option-desc">{option.description}</span>}
                  </button>
                )
              })}
            </div>
          )}
          <input className="text-input question-custom" value={draft(item.id).custom} disabled={busy}
            placeholder={(item.options?.length ?? 0) > 0 ? '或者直接写你的回答' : '写下你的回答'}
            onChange={e => typed(item, e.target.value)}
            onKeyDown={e => { if (e.key === 'Enter' && !e.nativeEvent.isComposing && complete) void send(answers()) }} />
        </div>
      ))}
      {error !== null && <div className="error small">{error}</div>}
      <div className="approval-actions">
        <button disabled={busy} onClick={() => void send(request.questions.map(q => ({ id: q.id, selected: [] })))}>跳过</button>
        <button className="inverse" disabled={busy || !complete} onClick={() => void send(answers())}>回答</button>
      </div>
    </div>
  )
}
