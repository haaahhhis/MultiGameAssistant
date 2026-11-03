/**
 * What goes back to a person in a chat channel, independent of the channel:
 * the turn as the app's session view has it — what the agent said, in order,
 * with the steps it took in between (each as the app names it: the tool and
 * its most telling argument). Channels send only the round's summary: the
 * agent's last words (it is asked to close each round with one), how many
 * steps it took, and why it stopped early if it did — as markdown where they
 * can (Feishu), as plain text where they cannot. The whole turn stays in the
 * app's session view.
 */

export interface ReplyStep {
  readonly name: string
  readonly summary: string
  readonly status: 'ok' | 'error' | 'running'
}

export type ReplyBlock =
  | { readonly kind: 'text'; readonly text: string }
  | { readonly kind: 'steps'; readonly steps: readonly ReplyStep[] }

export interface Reply {
  readonly blocks: readonly ReplyBlock[]
  /** Said before the summary (e.g. that the conversation had to start again). */
  readonly note?: string
  /** Why the turn ended before the agent finished, when it had already said something. */
  readonly ended?: string
}

export function textReply(text: string): Reply {
  return { blocks: [{ kind: 'text', text }] }
}

/** The agent's last words: what a pipeline step or an intervention takes as the answer, and a chat channel as the round's summary. */
export function finalText(reply: Reply): string {
  for (let i = reply.blocks.length - 1; i >= 0; i--) {
    const block = reply.blocks[i]!
    if (block.kind === 'text' && block.text.trim() !== '') return block.text
  }
  return ''
}

/** Markdown for channels that render it. */
export function replyMarkdown(reply: Reply): string {
  return render(reply)
}

/** Plain text for channels that do not. */
export function replyPlain(reply: Reply): string {
  return render(reply)
}

function render(reply: Reply): string {
  const summary = finalText(reply).trim() || '（agent 没有回复文字）'
  return [reply.note, summary, reply.ended, tally(reply)].filter(p => p !== undefined && p !== '').join('\n\n')
}

/** 「（执行了 12 个步骤，1 个失败）」, or nothing for a turn without steps. */
function tally(reply: Reply): string | undefined {
  const steps = reply.blocks.flatMap(b => (b.kind === 'steps' ? b.steps : []))
  if (steps.length === 0) return undefined
  const failed = steps.filter(s => s.status === 'error').length
  return `（执行了 ${steps.length} 个步骤${failed > 0 ? `，${failed} 个失败` : ''}；完整过程在软件的对话记录里）`
}
