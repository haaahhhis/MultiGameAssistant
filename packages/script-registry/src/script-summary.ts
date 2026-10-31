/**
 * 「让 AI 总结」 on the script page: an agent session reads what the library
 * knows about a script (its source, pack, files, README) and writes a few
 * sentences on what it is. The answer is kept with the script and shown on
 * its page; the session stays in the chat list to look at or continue.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@adg/gateway'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { sessionConversations } from '@adg/notify'
import type { ScriptLibrary } from './library.ts'

const SUMMARY_TIMEOUT_MS = 10 * 60_000
const MAX_SUMMARY = 800

export function scriptSummaries(ctx: Context, library: ScriptLibrary, log: { warn(message: string): void }) {
  const running = new Set<string>()
  return {
    async summarize(id: string): Promise<string> {
      const sessions = ctx.get('sessionController')
      if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
      const previous = library.get(id).summary
      if (running.has(id) && previous?.state === 'running' && previous.sessionId !== undefined) return previous.sessionId
      const material = await library.summaryMaterial(id)
      const name = library.get(id).name
      const conversations = sessionConversations(sessions, () => ctx.get('adgGateway')?.workspaceDir(), (sessionId, focus) => ctx.get('adgGateway')?.skillScope.setFocus(sessionId, focus) ?? Promise.resolve())
      const sessionId = await conversations.create(`脚本介绍：${name}`, { focus: { scripts: [id] } })
      running.add(id)
      await library.setSummary(id, { state: 'running', at: Date.now(), sessionId, ...(previous?.text === undefined || previous.state !== 'done' ? {} : { text: previous.text }) })
      const prompt = [
        `用户想知道脚本库里的「${name}」是什么。根据下面的材料写一段简介，给不懂技术的玩家看：`,
        '1. 它是什么（自动化工具、辅助、启动器……）、给哪个游戏用、在电脑上还是模拟器里跑；',
        '2. 主要能做什么（日常、刷体力、活动……挑最重要的几项）；',
        '3. 怎么用：有界面还是命令行，需要注意什么（要管理员、要开模拟器、分辨率、会占用鼠标键盘等，材料里提到的才写）。',
        '材料不够时可以用网页工具看它的 GitHub 仓库或官网说明；不要运行它，不要改任何文件，不要向用户提问。',
        `最后只输出简介本身：三到五句中文，不加标题、不用列表，不超过 ${MAX_SUMMARY / 2} 字。`,
        '',
        '材料：',
        material,
      ].join('\n')
      void conversations.ask(sessionId, prompt, AbortSignal.timeout(SUMMARY_TIMEOUT_MS)).then(
        // A turn that did not finish (no model set up, cut off) comes back as a note, not a summary.
        answer => library.setSummary(id, answer.startsWith('（这一轮没有完成') || answer.startsWith('（agent 没有回复文字')
          ? { state: 'failed', at: Date.now(), sessionId, text: answer.replace(/^（这一轮没有完成：?|）$/g, '') }
          : { state: 'done', at: Date.now(), sessionId, text: tidy(answer) }),
        error => {
          log.warn(`script summary ${id}: ${error instanceof Error ? error.message : String(error)}`)
          return library.setSummary(id, { state: 'failed', at: Date.now(), sessionId, text: error instanceof Error ? error.message : String(error) })
        },
      ).finally(() => running.delete(id))
      return sessionId
    },
  }
}

/** The answer as one plain paragraph (models sometimes add a heading or quote it). */
function tidy(answer: string): string {
  const text = answer.trim().replace(/^#+\s.*\n+/, '').replace(/^["“「](.*)["”」]$/s, '$1').trim()
  return text.length > MAX_SUMMARY ? `${text.slice(0, MAX_SUMMARY)}…` : text
}
