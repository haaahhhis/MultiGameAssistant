/**
 * 「压缩对话」 in a session: dsh's own `/compact` (dsh-command-compact, mounted
 * by the session's agent preset) run on the session's agent. The older part of
 * the conversation is replaced by a summary the model writes, so details in it
 * are gone for the agent afterwards; the UI says so before asking.
 *
 * dsh runs slash commands for its own web client by session id; a host plugin
 * has to find the session's agent itself. The session controller keeps the one
 * resolver that also resumes a session nobody has open (its `agents`, private
 * in its types), so this reaches it there.
 */
import type { Context } from '@deepseek-ai/cordis'

export interface CompactOutcome {
  /** False when there was nothing to compact yet. */
  readonly compacted: boolean
  /** For the person: what happened, or why it did not. */
  readonly message: string
}

interface AgentResolver { resolveAgent(sessionId: string): Promise<{ agent: unknown } | { error: { code?: string; message?: string } }> }
interface CommandRunner { execute(agent: unknown, line: string, attachments: readonly never[], signal: AbortSignal): Promise<{ result: { kind: 'success' | 'error'; text?: string } } | undefined> }

/** Run `/compact` in `sessionId`. @throws with a message for people when it cannot run at all. */
export async function compactSession(ctx: Context, sessionId: string, signal: AbortSignal): Promise<CompactOutcome> {
  const agents = (ctx.get('sessionController' as never) as { agents?: AgentResolver } | undefined)?.agents
  const commands = ctx.get('commands' as never) as CommandRunner | undefined
  if (agents === undefined || commands === undefined) throw new Error('这个版本的 dsh 不支持从这里压缩对话')
  const found = await agents.resolveAgent(sessionId)
  if ('error' in found) throw new Error(found.error.code === 'session/agent-busy' ? 'agent 正在工作，等它停下再压缩' : `打不开这个对话：${found.error.message ?? found.error.code ?? '未知原因'}`)
  const execution = await commands.execute(found.agent, '/compact', [], signal)
  if (execution === undefined) throw new Error('这个对话的 agent 没有压缩功能')
  return compactOutcome(execution.result)
}

/** dsh-command-compact's English results, for people. */
export function compactOutcome(result: { kind: 'success' | 'error'; text?: string }): CompactOutcome {
  const text = result.text ?? ''
  if (result.kind === 'success') {
    const done = /Compacted (\d+) history items \(~(\d+) tokens\)/.exec(text)
    if (done !== null) return { compacted: true, message: `已压缩：${done[1]} 条较早的记录（约 ${Number(done[2]).toLocaleString('zh-CN')} tokens）换成了一份摘要。` }
    return { compacted: false, message: /No compactable history/.test(text) ? '对话还很短，没有可以压缩的内容。' : text || '已压缩。' }
  }
  if (/active compaction|not idle/.test(text)) throw new Error('agent 正在工作或正在压缩，等它停下再试')
  if (/cancelled/i.test(text)) throw new Error('压缩被取消了')
  if (/useful summary/.test(text)) throw new Error('没能生成有用的摘要，对话没有改动；可以稍后再试')
  if (/could not be saved/.test(text)) throw new Error('压缩完成了，但对话没能保存')
  throw new Error(`压缩没有完成：${text}`)
}
