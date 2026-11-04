/**
 * Reminders the agents set for themselves (dsh's `schedule` service, its
 * schedule_create tool): read for the 定时 tab and the timetable, so a
 * reminder 助手 set in its conversation is seen and can be removed there,
 * next to the app's own timed tasks.
 */
import type { AgentReminder } from '@adg/protocol'

/** The part of dsh's schedule service read here (`ctx.schedule`). */
export interface ScheduleService {
  catalog(): Promise<readonly ScheduleEntry[]>
  delete(request: { sessionId: string; id: string }): Promise<{ deleted: boolean }>
}

export interface ScheduleEntry {
  readonly id: string
  readonly kind: 'at' | 'after' | 'every' | 'daily' | 'weekly' | 'cron' | string
  readonly title?: string
  readonly prompt: string
  readonly scheduledAt: string
  readonly sessionId: string
  readonly status: 'active' | 'inactive' | string
  readonly everySeconds?: number
  readonly time?: string
  readonly weekdays?: readonly number[]
  readonly expression?: string
}

const WEEKDAY = ['', '一', '二', '三', '四', '五', '六', '日']

/** The active ones, soonest first, each under the agent whose conversation it is in. */
export function remindersOf(entries: readonly ScheduleEntry[], agentOf: (sessionId: string) => string): AgentReminder[] {
  return entries
    .filter(e => e.status === 'active')
    .map(e => ({
      id: e.id,
      agent: agentOf(e.sessionId),
      sessionId: e.sessionId,
      title: e.title?.trim() || e.prompt.split('\n')[0]!.slice(0, 40),
      prompt: e.prompt,
      rule: ruleText(e),
      repeats: e.kind !== 'at' && e.kind !== 'after',
      next: Date.parse(e.scheduledAt),
    }))
    .filter(r => Number.isFinite(r.next))
    .sort((a, b) => a.next - b.next)
}

/** When it comes, in words. */
export function ruleText(entry: ScheduleEntry): string {
  const time = (entry.time ?? '').slice(0, 5)
  switch (entry.kind) {
    case 'daily': return `每天 ${time}`
    case 'weekly': return `每周${(entry.weekdays ?? []).map(d => WEEKDAY[d] ?? String(d)).join('、')} ${time}`
    case 'every': return `每 ${duration(entry.everySeconds ?? 0)}`
    case 'cron': return `cron ${entry.expression ?? ''}`.trim()
    default: return '一次'
  }
}

function duration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}
