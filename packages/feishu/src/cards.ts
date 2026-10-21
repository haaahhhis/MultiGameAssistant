/**
 * Feishu message cards (JSON 1.0 schema, `update_multi` so a patch shows for
 * every recipient). Text goes in as `plain_text`, so nothing a script logs can
 * turn into markup. Button values say what a click means:
 *
 *   { kind: 'notice', id, action }        a notice's button (routed by @adg/notify)
 *   { kind: 'approval', id, decision }    an approval answer
 */
import type { ApprovalRequested } from '@adg/protocol'
import type { Notice } from '@adg/notify'

const TEMPLATE: Readonly<Record<Notice['severity'], string>> = { error: 'red', warning: 'orange', success: 'green', info: 'blue' }
const MAX_TEXT = 3000

const plain = (content: string) => ({ tag: 'plain_text', content })
const div = (content: string) => ({ tag: 'div', text: plain(clip(content)) })
const note = (content: string) => ({ tag: 'note', elements: [plain(content)] })

export function noticeCard(notice: Notice, options: { imageKey?: string | undefined; done?: string | undefined; text?: string | undefined } = {}): object {
  const done = options.done
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: done === undefined ? TEMPLATE[notice.severity] : 'grey', title: plain(notice.title) },
    elements: [
      div(options.text ?? notice.text),
      ...(options.imageKey === undefined ? [] : [{ tag: 'img', img_key: options.imageKey, alt: plain('截图') }]),
      ...(done !== undefined
        ? [{ tag: 'hr' }, div(`已处理：${done}`)]
        : (notice.actions?.length ?? 0) > 0
          ? [{
              tag: 'action',
              actions: notice.actions!.map(action => ({
                tag: 'button', text: plain(action.label), type: action.style ?? 'default',
                value: { kind: 'notice', id: notice.id, action: action.id },
              })),
            }]
          : []),
      note(`AutoDailyGamePlay · ${new Date().toLocaleString('zh-CN', { hour12: false })}`),
    ],
  }
}

/** `own`: asked in the person's own Feishu conversation (else a session in the app). */
export function approvalCard(request: ApprovalRequested, options: { outcome?: string | undefined; own?: boolean } = {}): object {
  const reason = request.displayReason?.['zh-CN'] ?? request.displayReason?.['zh'] ?? request.reason
  const lines = [`agent 想要执行：${request.toolName}`, ...(reason === undefined ? [] : [`原因：${reason}`]), options.own === true ? '来自：你在飞书里的对话' : `来自：软件里的会话 ${request.sessionId}`]
  return {
    config: { wide_screen_mode: true, update_multi: true },
    header: { template: options.outcome === undefined ? 'orange' : 'grey', title: plain('需要你确认') },
    elements: [
      div(lines.join('\n')),
      ...(options.outcome !== undefined
        ? [{ tag: 'hr' }, div(options.outcome)]
        : [{
            tag: 'action',
            actions: [
              { tag: 'button', text: plain('允许这一次'), type: 'primary', value: { kind: 'approval', id: request.approvalId, decision: 'allow-once' } },
              { tag: 'button', text: plain('拒绝'), type: 'danger', value: { kind: 'approval', id: request.approvalId, decision: 'reject' } },
            ],
          }]),
      note('也可以在 AutoDailyGamePlay 界面里回答，先回答的生效'),
    ],
  }
}

export const OUTCOME: Readonly<Record<string, string>> = {
  'allowed-once': '已允许这一次',
  rejected: '已拒绝',
  cancelled: 'agent 已取消这个操作',
  unavailable: '已失效',
}

function clip(text: string): string {
  return text.length <= MAX_TEXT ? text : `${text.slice(0, MAX_TEXT)}…`
}
