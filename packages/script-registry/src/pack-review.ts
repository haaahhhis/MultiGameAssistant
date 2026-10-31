/**
 * After a script updates, its pack (the user's or the agent's: built-in ones
 * come with the app) was written for the old version. The user is asked once
 * per version — a chat-channel card and a notice on the 脚本 page — whether
 * the agent should check it. Checking is a conversation of its own, focused on
 * that script, that reads the changelog first (script-analysis 「脚本更新后检查
 * 脚本包」); keeping it marks the pack as checked.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@adg/gateway'
import { sessionConversations } from '@adg/notify'
import type { ScriptInfo } from '@adg/protocol'
import type { ScriptLibrary } from './library.ts'

export const PACK_REVIEW_SCOPE = 'pack-review'
const REVIEW_TIMEOUT_MS = 30 * 60_000

export interface PackReview {
  /** Tell the user a script moved past its pack's version (library onPackReview). */
  ask(script: ScriptInfo): void
  /** `check`: start the agent on it; `keep`: the pack stays as it is. @returns the agent's conversation. */
  decide(id: string, decision: 'check' | 'keep'): Promise<{ sessionId?: string }>
}

export function packReview(ctx: Context, library: () => ScriptLibrary, log: { warn(message: string): void }): PackReview {
  const decide: PackReview['decide'] = async (id, decision) => {
    const lib = library()
    if (decision === 'keep') {
      await lib.packReviewed(id)
      return {}
    }
    const script = lib.get(id)
    const sessions = ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const gateway = ctx.get('adgGateway')
    const conversations = sessionConversations(sessions, () => gateway?.workspaceDir(), (sessionId, focus) => gateway?.skillScope.setFocus(sessionId, focus) ?? Promise.resolve())
    const sessionId = await conversations.create(`检查脚本包：${script.name}`, { focus: { scripts: [id] } })
    const from = script.packReview?.from ?? '旧版本'
    const to = script.packReview?.to ?? script.localVersion?.version ?? script.current ?? '新版本'
    const prompt = [
      `「${script.name}」（脚本 id ${id}）从 ${from} 更新到了 ${to}，它的脚本包 ${script.packId ?? ''} 是按 ${from} 写的。`,
      '请按技能 script-analysis 里「脚本更新后检查脚本包」的步骤做：',
      `1. 先用 script_changelog（id=${id}）读这几个版本的更新日志，挑出可能影响脚本包的改动（任务、参数、配置文件和键、启动方式、日志里的完成和出错文字、运行环境）；`,
      '2. 只针对这些改动核对新版本的文件，更新日志没写清楚的再看代码；',
      '3. 要改就用原来的脚本包 id 提交 pack_propose（summary 写明依据更新日志改了什么）；不用改就调用 pack_reviewed 说明理由；',
      '4. 最后用两三句话告诉用户结论。',
    ].join('\n')
    void conversations.ask(sessionId, prompt, AbortSignal.timeout(REVIEW_TIMEOUT_MS)).catch(error => log.warn(`pack review for ${id}: ${error instanceof Error ? error.message : String(error)}`))
    return { sessionId }
  }

  ctx.inject(['adgNotify'], scoped => {
    scoped.effect(() => scoped.adgNotify.onAction(PACK_REVIEW_SCOPE, async (noticeId, actionId) => {
      const id = noticeId.split(':')[1]
      if (id === undefined || (actionId !== 'check' && actionId !== 'keep')) throw new Error(`未知操作 ${actionId}`)
      const { sessionId } = await decide(id, actionId)
      return sessionId === undefined ? '好的，脚本包保持不变' : '好的，agent 先读更新日志，再检查脚本包；改好的草稿会在「脚本」页等你确认'
    }), 'adg-scripts pack review actions')
  })

  return {
    ask(script) {
      const review = script.packReview
      if (review === undefined) return
      const notify = ctx.get('adgNotify')
      if (notify === undefined) return
      void notify.send({
        id: `${PACK_REVIEW_SCOPE}:${script.id}:${review.to}`,
        scope: PACK_REVIEW_SCOPE,
        title: `${script.name} 更新了：脚本包要不要跟着改？`,
        text: [
          `${script.name} 从 ${review.from ?? '旧版本'} 更新到了 ${review.to}，它的脚本包是按旧版本写的，新版本的任务、配置或日志可能变了。`,
          '要让 agent 先读这次的更新日志，再检查脚本包吗？改动会先作为草稿给你确认。',
        ].join('\n'),
        severity: 'info',
        actions: [{ id: 'check', label: '让 agent 检查', style: 'primary' }, { id: 'keep', label: '不用改' }],
      }).catch(error => log.warn(`pack review notice for ${script.id}: ${error instanceof Error ? error.message : String(error)}`))
    },
    decide,
  }
}
