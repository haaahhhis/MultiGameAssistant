import { useState } from 'react'
import type { ChatItem, SessionHandle } from '@adg/client-core'
import { Icon } from '../../components/Icons.tsx'

/** A turn with at least this many successful steps worked something out worth keeping. */
const MIN_STEPS = 3
/** Sessions the app runs by itself (pipelines, reading a game, interventions) follow their own guides. */
const AUTOMATIC = /^(编排|游戏信息|干预)[：:]/
const OFF_KEY = 'adg:skill-offer:off'
const dismissedKey = (sessionId: string) => `adg:skill-offer:${sessionId}`

/** What the agent is asked to do when the offer is taken. */
export const SAVE_SKILL_PROMPT = [
  '把这次走通的做法保存成技能（用 skill_save），让下次同样的事可以直接照着做、少调用模型。要求：',
  '- 只写最后成功的路径，不写失败的尝试和闲聊；',
  '- 写清楚适用场景（用户会怎么说）、一步一步的操作（用到的工具、命令、路径、参数照实写，会变的写成「把 X 换成…」）、怎样算成功、注意事项和踩过的坑；',
  '- 名字用简短的英文小写加短横线，description 一两句话说清楚做什么、什么时候用；',
  '- 保存后告诉我技能名，以及以后我说什么时会用到它。',
].join('\n')

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
