/**
 * 优化脚本: once a script has run cleanly often enough to learn from
 * (OPTIMIZE_AFTER_RUNS), or has gone through on a new version, the user is
 * asked once — a card in 助手's conversation and the chat apps, and a notice on
 * the 脚本 page — whether the 脚本 agent should put what the runs showed to use:
 * sum its pack up again, set its stall time from its log rhythm, keep the steps
 * that keep working as skills of its own (protocol `optimizeScriptPrompt`).
 * `/优化脚本` asks the same in any conversation; the 脚本 page starts it any time.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@adg/gateway'
import { sessionConversations } from '@adg/notify'
import { optimizeScriptPrompt, taskMessage, type ScriptInfo } from '@adg/protocol'
import type { ScriptLibrary } from './library.ts'
import { SCRIPT_ROLE } from './role.ts'

export const OPTIMIZE_SCOPE = 'script-optimize'
const OPTIMIZE_TIMEOUT_MS = 30 * 60_000

/** The notice offering one stretch's optimizing. */
const noticeIdOf = (scriptId: string, runs: number, at: number | undefined) => `${OPTIMIZE_SCOPE}:${scriptId}:${at ?? 0}:${runs}`

export interface Optimizer {
  /** Offer it (library onOptimize). */
  ask(script: ScriptInfo): void
  /** `run`: start the 脚本 agent on it; `keep`: not this time. `by`: who asked (你, 飞书 …). @returns the agent's conversation. */
  decide(id: string, decision: 'run' | 'keep', by: string): Promise<{ sessionId?: string }>
}

export function optimizer(ctx: Context, library: () => ScriptLibrary, log: { warn(message: string): void }): Optimizer {
  /** The offer still open per script, closed wherever it is answered. */
  const open = new Map<string, string>()
  const close = (id: string, done: string) => {
    const noticeId = open.get(id)
    if (noticeId === undefined) return
    open.delete(id)
    void ctx.get('adgNotify')?.update(noticeId, { done }).catch(() => {})
  }
  const why = (script: ScriptInfo) => script.optimize?.due === 'updated'
    ? `更新到 ${script.current ?? script.localVersion?.version ?? '新版本'} 后已经跑通了，先读更新日志`
    : script.optimize === undefined ? undefined : `${script.optimize.at === undefined ? '装好以来' : '上次优化以来'}已经跑成功 ${script.optimize.runs} 次`

  const decide: Optimizer['decide'] = async (id, decision, by) => {
    const lib = library()
    const script = lib.get(id)
    if (decision === 'keep') {
      close(id, '这次不优化')
      await lib.optimizeDone(id, 'keep')
      return {}
    }
    const sessions = ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const gateway = ctx.get('adgGateway')
    const conversations = sessionConversations(sessions, () => gateway?.workspaceDir(), (sessionId, focus) => gateway?.skillScope.setFocus(sessionId, focus) ?? Promise.resolve(), () => gateway)
    const sessionId = await conversations.home(SCRIPT_ROLE.id, { focus: { scripts: [id] } })
    const prompt = optimizeScriptPrompt(script.name, why(script), id)
    await lib.optimizeDone(id, 'run')
    void conversations.ask(sessionId, taskMessage(by, `优化脚本：${script.name}`, prompt), AbortSignal.timeout(OPTIMIZE_TIMEOUT_MS)).catch(error => log.warn(`optimizing ${id}: ${error instanceof Error ? error.message : String(error)}`))
    close(id, '已交给「脚本」优化，脚本包的改动会在「脚本」页等你确认')
    return { sessionId }
  }

  ctx.inject(['adgNotify'], scoped => {
    scoped.effect(() => scoped.adgNotify.onAction(OPTIMIZE_SCOPE, async (noticeId, actionId, actor) => {
      const id = noticeId.split(':')[1]
      if (id === undefined || (actionId !== 'run' && actionId !== 'keep')) throw new Error(`未知操作 ${actionId}`)
      const { sessionId } = await decide(id, actionId, actor.channel === 'agent' ? (actor.name ?? '助手') : '你')
      return sessionId === undefined ? '好的，这次不优化，之后跑够了再问' : '好的，「脚本」会重新总结脚本包、调卡住时间、把走通的步骤存成技能；脚本包的改动会在「脚本」页等你确认'
    }), 'adg-scripts optimize actions')
  })

  return {
    ask(script) {
      const notify = ctx.get('adgNotify')
      if (notify === undefined || script.optimize?.due === undefined) return
      const noticeId = noticeIdOf(script.id, script.optimize.runs, script.optimize.at)
      close(script.id, '有了新的提议')
      open.set(script.id, noticeId)
      void notify.send({
        id: noticeId,
        scope: OPTIMIZE_SCOPE,
        title: `要优化「${script.name}」吗？`,
        text: [
          `${script.name} ${why(script) ?? ''}，攒下的运行记录够用来优化它了。`,
          '要让「脚本」agent 一次做完：按这些运行重新总结脚本包、按正常时的日志节奏调「多久没动静算卡住」、把反复走通的步骤存成只给它用的技能吗？脚本包的改动会先作为草稿给你确认。',
        ].join('\n'),
        severity: 'info',
        actions: [{ id: 'run', label: '优化脚本', style: 'primary' }, { id: 'keep', label: '这次不用' }],
      }).catch(error => log.warn(`optimize notice for ${script.id}: ${error instanceof Error ? error.message : String(error)}`))
    },
    decide,
  }
}
