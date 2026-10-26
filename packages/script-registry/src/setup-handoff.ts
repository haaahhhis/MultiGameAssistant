/**
 * An install or update from the UI downloaded a setup program instead of an
 * archive (see ScriptLibrary.runSetup): an agent session runs it — quietly,
 * or clicking through its window with the screen tools — and imports the
 * folder it installed into, which finishes the install. The session stays in
 * the chat list to follow or continue. When the turn ends with the installer
 * still waiting (no model set up yet, cut off, gave up), the setup says why, and
 * the scripts page offers the user to install it themselves.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from '@adg/gateway'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import { SETUP_NAMES } from '@adg/installer'
import { sessionConversations } from '@adg/notify'
import type { PendingSetup } from './state.ts'
import type { ScriptLibrary } from './library.ts'
import { TOOL_NAMES } from './tools.ts'

const SETUP_TIMEOUT_MS = 60 * 60_000

/** @returns the conversation, once it is created (the agent then works on in the background). */
export function setupHandOff(ctx: Context, library: () => ScriptLibrary, log: { info(message: string): void; warn(message: string): void }): (setup: PendingSetup) => Promise<string> {
  return async setup => {
    const sessions = ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const conversations = sessionConversations(sessions, () => ctx.get('adgGateway')?.workspaceDir())
    const sessionId = await conversations.create(`安装脚本：${setup.name}`)
    log.info(`${setup.scriptId}: setup program handed to session ${sessionId}`)
    await library().setSetupAgent(setup.scriptId, { sessionId, state: 'running' })
    // Still waiting once the turn is over, and still this session's: the agent did not finish it.
    const failed = async (reason: string) => {
      if (library().pendingSetup(setup.scriptId)?.agent?.sessionId !== sessionId) return
      log.warn(`${setup.scriptId}: setup session ${sessionId}: ${reason}`)
      await library().setSetupAgent(setup.scriptId, { sessionId, state: 'failed', reason })
    }
    void (async () => {
      const prompt = [
        `用户在脚本库里${setup.update ? '更新' : '安装'}「${setup.name}」${setup.version}，下载到的是 ${SETUP_NAMES[setup.kind]} 安装程序（${setup.file}），不是压缩包，需要你把它装好：`,
        `1. 用 ${TOOL_NAMES.setupRun}（id=${setup.scriptId}）运行它，先用默认的静默安装：会装进 ${setup.dir}，等它结束；`,
        `2. 静默安装失败或装出来的目录是空的，就用 ${TOOL_NAMES.setupRun}（quiet=false）打开安装窗口，用 screen_capture / screen_tap 一步步点完：安装位置保持 ${setup.dir}，不勾选「立即运行」，其他保持默认；遇到要管理员授权的弹窗就停下告诉用户；`,
        `3. 装好后用 ${TOOL_NAMES.import}（path=${setup.dir}，id=${setup.scriptId}）导入，脚本库会把它记为 ${setup.version}${setup.update ? '' : '，并接上更新渠道'}；`,
        '4. 最后用一两句话告诉用户结果（装在哪、是否成功）。',
        '不要运行装好的程序，不要改它的文件，不要向用户提问；做不到时说明卡在哪一步。',
      ].join('\n')
      const answer = await conversations.ask(sessionId, prompt, AbortSignal.timeout(SETUP_TIMEOUT_MS))
      const cut = /^（这一轮没有完成：(.*)）$/s.exec(answer.trim())
      await failed(cut !== null ? cut[1]! : 'agent 停下了，但没有导入装好的目录')
    })().catch(error => failed(error instanceof Error ? error.message : String(error)))
    return sessionId
  }
}
