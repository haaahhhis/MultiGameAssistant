/**
 * What goes back to a person in a chat channel, independent of the channel:
 * the same turn the app's session view shows — what the agent said, in order,
 * with the steps it took in between (each as the app names it: the tool and
 * its most telling argument). Channels only render it: as markdown where
 * they can (Feishu), as plain text where they cannot.
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
}

/** Steps listed one by one up to this many; longer groups keep the first and last few. */
const MAX_STEPS = 6

export function textReply(text: string): Reply {
  return { blocks: [{ kind: 'text', text }] }
}

/** The agent's last words: what a pipeline step or an intervention takes as the answer. */
export function finalText(reply: Reply): string {
  for (let i = reply.blocks.length - 1; i >= 0; i--) {
    const block = reply.blocks[i]!
    if (block.kind === 'text' && block.text.trim() !== '') return block.text
  }
  return ''
}

/** Markdown for channels that render it. */
export function replyMarkdown(reply: Reply): string {
  return render(reply, steps => [`**${heading(steps)}**`, ...listed(steps).map(line => `- ${line}`)].join('\n'))
}

/** Plain text for channels that do not. */
export function replyPlain(reply: Reply): string {
  return render(reply, steps => [`【${heading(steps)}】`, ...listed(steps).map(line => `· ${line}`)].join('\n'))
}

function render(reply: Reply, steps: (steps: readonly ReplyStep[]) => string): string {
  const parts = reply.blocks.map(b => (b.kind === 'text' ? b.text.trim() : steps(b.steps))).filter(p => p !== '')
  return parts.length === 0 ? '（agent 没有回复文字）' : parts.join('\n\n')
}

function heading(steps: readonly ReplyStep[]): string {
  const failed = steps.filter(s => s.status === 'error').length
  return `执行了 ${steps.length} 个步骤${failed > 0 ? `（${failed} 个失败）` : ''}`
}

function listed(steps: readonly ReplyStep[]): string[] {
  const line = (s: ReplyStep) => `${s.status === 'ok' ? '✓' : s.status === 'error' ? '✗' : '…'} ${s.name}${s.summary === '' ? '' : `：${s.summary.slice(0, 80)}`}`
  if (steps.length <= MAX_STEPS) return steps.map(line)
  const head = steps.slice(0, 3).map(line)
  const tail = steps.slice(-2).map(line)
  return [...head, `…另外 ${steps.length - 5} 个`, ...tail]
}
