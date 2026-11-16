/**
 * Reminders the agents set for themselves (dsh's `schedule` service, its
 * schedule_create tool): read for the 定时 tab and the timetable, so a
 * reminder 助手 set in its conversation is seen and can be removed there,
 * next to the app's own timed tasks.
 *
 * dsh's schedule holds every Host task (its 自动化 page's too) by id; a task
 * is a reminder in a conversation when it is delivered to one (`target`).
 */
import type { AgentReminder } from '@adg/protocol'

/** The part of dsh's schedule service used here (`ctx.schedule`, dsh-schedule's ScheduleService). */
export interface ScheduleService {
  catalog(): Promise<readonly ScheduleEntry[]>
  edit(request: { id: string; action: 'delete' }): Promise<{ deleted?: boolean; code?: string }>
}

/** dsh-schedule's ScheduleCatalogEntry, the fields read here. */
export interface ScheduleEntry {
  readonly id: string
  readonly kind: 'at' | 'after' | 'every' | 'daily' | 'weekly' | 'cron' | 'rrule' | string
  readonly title?: string
  readonly prompt: string
  readonly scheduledAt: string
  /** Where each delivery goes: one conversation (`session`, or `new_once` once made), or a new one each time (`new`). */
  readonly target?: { readonly kind: string; readonly sessionId?: string }
  readonly status: 'active' | 'paused' | 'ended' | string
  readonly everySeconds?: number
  readonly time?: string
  readonly weekdays?: readonly number[]
  readonly expression?: string
  /** One DTSTART line and one RRULE line (what schedule_create makes). */
  readonly rrule?: string
}

const WEEKDAY = ['', '一', '二', '三', '四', '五', '六', '日']
const BYDAY: Record<string, number> = { MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6, SU: 7 }

/** The active ones delivered to a conversation, soonest first, each under the agent whose conversation it is. */
export function remindersOf(entries: readonly ScheduleEntry[], agentOf: (sessionId: string) => string): AgentReminder[] {
  return entries
    .filter(e => e.status === 'active' && typeof e.target?.sessionId === 'string')
    .map(e => {
      const sessionId = e.target!.sessionId!
      return {
        id: e.id,
        agent: agentOf(sessionId),
        sessionId,
        title: e.title?.trim() || e.prompt.split('\n')[0]!.slice(0, 40),
        prompt: e.prompt,
        rule: ruleText(e),
        repeats: repeats(e),
        next: Date.parse(e.scheduledAt),
      }
    })
    .filter(r => Number.isFinite(r.next))
    .sort((a, b) => a.next - b.next)
}

function repeats(entry: ScheduleEntry): boolean {
  if (entry.kind === 'rrule') return rruleParts(entry.rrule).get('COUNT') !== '1'
  return entry.kind !== 'at' && entry.kind !== 'after'
}

/** When it comes, in words. */
export function ruleText(entry: ScheduleEntry): string {
  const time = (entry.time ?? '').slice(0, 5)
  switch (entry.kind) {
    case 'daily': return `每天 ${time}`
    case 'weekly': return `每周${weekdays(entry.weekdays ?? [])} ${time}`
    case 'every': return `每 ${duration(entry.everySeconds ?? 0)}`
    case 'cron': return `cron ${entry.expression ?? ''}`.trim()
    case 'rrule': return rruleText(entry.rrule)
    default: return '一次'
  }
}

/** The RRULE line's parts (FREQ, INTERVAL, BYDAY, COUNT, …). */
function rruleParts(rrule: string | undefined): Map<string, string> {
  const line = (rrule ?? '').split(/\r?\n/).find(l => l.startsWith('RRULE:'))
  return new Map((line?.slice('RRULE:'.length) ?? '').split(';').filter(p => p.includes('=')).map(p => p.split('=', 2) as [string, string]))
}

/** The common rules in words (as schedule_create makes them); any other as the rule itself. */
function rruleText(rrule: string | undefined): string {
  const parts = rruleParts(rrule)
  if (parts.get('COUNT') === '1') return '一次'
  // DTSTART;TZID=Asia/Shanghai:20261013T090000 → 09:00
  const start = /^DTSTART[^:]*:\d{8}T(\d{2})(\d{2})/m.exec(rrule ?? '')
  const time = start === null ? '' : ` ${start[1]}:${start[2]}`
  const interval = Number(parts.get('INTERVAL') ?? '1')
  const plain = [...parts.keys()].every(k => ['FREQ', 'INTERVAL', 'BYDAY', 'WKST'].includes(k))
  const every = (unit: string, seconds: number) => interval === 1 ? `每${unit}` : `每 ${duration(interval * seconds)}`
  if (plain && Number.isInteger(interval) && interval > 0) {
    switch (parts.get('FREQ')) {
      case 'DAILY': if (!parts.has('BYDAY')) return `${interval === 1 ? '每天' : `每 ${interval} 天`}${time}`; break
      case 'WEEKLY': {
        const days = (parts.get('BYDAY') ?? '').split(',').filter(d => d !== '').map(d => BYDAY[d])
        if (interval === 1 && days.length > 0 && days.every(d => d !== undefined)) return `每周${weekdays(days as number[])}${time}`
        break
      }
      case 'HOURLY': if (!parts.has('BYDAY')) return every('小时', 3600); break
      case 'MINUTELY': if (!parts.has('BYDAY')) return every('分钟', 60); break
    }
  }
  const line = (rrule ?? '').split(/\r?\n/).find(l => l.startsWith('RRULE:'))
  return line === undefined ? '重复' : line.slice('RRULE:'.length)
}

function weekdays(days: readonly number[]): string {
  return days.map(d => WEEKDAY[d] ?? String(d)).join('、')
}

function duration(seconds: number): string {
  if (seconds % 86_400 === 0) return `${seconds / 86_400} 天`
  if (seconds % 3600 === 0) return `${seconds / 3600} 小时`
  if (seconds % 60 === 0) return `${seconds / 60} 分钟`
  return `${seconds} 秒`
}
