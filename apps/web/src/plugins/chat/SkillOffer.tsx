import { useState } from 'react'
import type { ChatItem, SessionHandle } from '@adg/client-core'
import { SAVE_SKILL_PROMPT } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'

/** A turn with at least this many successful steps worked something out worth keeping. */
const MIN_STEPS = 3
/** Sessions the app runs by itself (pipelines, reading a game, interventions) follow their own guides. */
const AUTOMATIC = /^(编排|游戏信息|干预)[：:]/
const OFF_KEY = 'adg:skill-offer:off'
const dismissedKey = (sessionId: string) => `adg:skill-offer:${sessionId}`


function read(key: string): string | null {
  try { return localStorage.getItem(key) } catch { return null }
}
function write(key: string, value: string): void {
  try { localStorage.setItem(key, value) } catch { /* private window: the offer comes back next time */ }
}

/**
 * The last turn's steps when it did something new: finished, several steps
 * all done, no skill followed (then the way was already known) and none saved.
 * @returns the id of the turn's user message, or undefined.
 */
export function offerFor(items: readonly ChatItem[]): string | undefined {
  let start = items.length - 1
  while (start >= 0 && items[start]!.kind !== 'user') start--
  if (start < 0) return undefined
  const turn = items.slice(start + 1)
  const tools = turn.filter((i): i is Extract<ChatItem, { kind: 'tool' }> => i.kind === 'tool')
  if (tools.some(t => t.name === 'skill' || t.name === 'skill_save' || t.status !== 'ok')) return undefined
  if (turn.some(i => i.kind === 'notice' && i.tone === 'error')) return undefined
  if (turn.some(i => i.kind === 'context')) return undefined // a skill the user called in
  if (tools.length < MIN_STEPS || turn.at(-1)?.kind !== 'assistant') return undefined
  return items[start]!.id
}

/** After a new multi-step job: offer to keep the way as a skill. */
export function SkillOffer({ session, title, items }: { session: SessionHandle; title: string | null; items: readonly ChatItem[] }) {
  const turn = offerFor(items)
  const [hidden, setHidden] = useState(() => read(OFF_KEY) === '1')
  const [dismissed, setDismissed] = useState(() => read(dismissedKey(session.id)))
  const [busy, setBusy] = useState(false)
  if (turn === undefined || hidden || dismissed === turn || (title !== null && AUTOMATIC.test(title))) return null
  const dismiss = () => { write(dismissedKey(session.id), turn); setDismissed(turn) }
  const save = async () => {
    setBusy(true)
    try {
      await session.prompt(SAVE_SKILL_PROMPT)
      dismiss()
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="skill-offer" role="region" aria-label="存成技能">
      <Icon name="sparkles" />
      <div className="skill-offer-text">
        <strong>要把这次的做法存成技能吗？</strong>
        <span>agent 会把刚才走通的步骤浓缩成一份技能；下次做同样的事直接照着做，不用重新摸索，少调用模型。</span>
      </div>
      <div className="skill-offer-actions">
        <button className="link-button small" onClick={() => { write(OFF_KEY, '1'); setHidden(true) }}>不再提示</button>
        <button className="small-button" disabled={busy} onClick={dismiss}>这次不用</button>
        <button className="small-button primary" disabled={busy} onClick={() => void save()}>存成技能</button>
      </div>
    </div>
  )
}
