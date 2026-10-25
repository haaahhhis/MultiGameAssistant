/**
 * The computer's power around pipelines.
 *
 * - Keep awake: while a pipeline or a script runs, or a scheduled time is
 *   minutes away (a timed wake-up must not doze off again before it), Windows
 *   does not go to sleep by itself; with a desktop script running the screen
 *   stays on too, since the script works on it.
 * - After a pipeline: the sleep / hibernate / shutdown it asks for waits until
 *   nothing runs (a chained pipeline may be starting), then counts down —
 *   shown in the UI and sent to Feishu with a button to call it off — and is
 *   done. Not after a run started by hand in the UI (the user is at the
 *   computer) or one that was cancelled; skipped when a scheduled time is near.
 */
import type { Pipeline, PipelineRun, PowerAction } from '@adg/protocol'

export type SleepAction = Exclude<PowerAction, 'none'>
/** What has to stay on: the system (no sleep), or the screen as well. */
export type AwakeLevel = 'system' | 'display'

export interface PowerPort {
  /** Hold off sleep at this level; undefined lets go. */
  hold(level: AwakeLevel | undefined): void
  /** @throws Error when Windows refused (hibernation off, no permission). */
  perform(action: SleepAction): Promise<void>
}

export interface PowerNotice {
  readonly id: string
  readonly scope: 'power'
  readonly title: string
  readonly text: string
  readonly severity: 'info' | 'warning'
  readonly actions?: readonly { id: string; label: string; style?: 'danger' }[]
}

export interface PowerDeps {
  readonly port: PowerPort
  /** What is going on now: undefined when nothing runs. */
  readonly activity: () => AwakeLevel | undefined
  /** The next scheduled time, if any. */
  readonly nextSlot: () => number | undefined
  readonly countdownMs: () => number
  readonly notices: () => { send(notice: PowerNotice): Promise<readonly string[]>; update(id: string, patch: { done?: string }): Promise<void> } | undefined
  readonly changed: () => void
  /** Quiet time before counting down, for whatever starts right after a pipeline. @default 20000 */
  readonly settleMs?: number
  readonly now?: () => number
  readonly log: { info(message: string): void; warn(message: string): void }
}

export const POWER_WORD: Readonly<Record<SleepAction, string>> = { sleep: '睡眠', hibernate: '休眠', shutdown: '关机' }
const STRENGTH: Readonly<Record<SleepAction, number>> = { sleep: 1, hibernate: 2, shutdown: 3 }
/** No sleep or shutdown when a scheduled time is this close. */
const NEAR_SLOT_MS = 15 * 60_000

interface Wanted {
  action: SleepAction
  pipelineName: string
  runId: string
  /** When nothing was running any more. */
  idleSince?: number
  countdown?: { at: number; noticeId: string; timer: ReturnType<typeof setTimeout> }
}

export class Power {
  readonly #deps: PowerDeps
  readonly #now: () => number
  #level: AwakeLevel | undefined
  #wanted: Wanted | undefined
  #notices = 0

  constructor(deps: PowerDeps) {
    this.#deps = deps
    this.#now = deps.now ?? Date.now
  }

  status(): { awake: boolean; pending?: { action: SleepAction; pipelineName: string; at?: number } } {
    const w = this.#wanted
    return {
      awake: this.#level !== undefined,
      ...(w === undefined ? {} : { pending: { action: w.action, pipelineName: w.pipelineName, ...(w.countdown === undefined ? {} : { at: w.countdown.at }) } }),
    }
  }

  /** A pipeline finished: does it put the computer to sleep or shut it down? */
  pipelineEnded(run: PipelineRun, pipeline: Pipeline | undefined): void {
    const action = pipeline?.powerAfter ?? 'none'
    if (action === 'none') return
    if (run.trigger.kind === 'manual') { this.#deps.log.info(`${run.pipelineId} was run by hand: no ${action}`); return }
    if (run.state === 'cancelled') { this.#deps.log.info(`${run.pipelineId} was cancelled: no ${action}`); return }
    // Two pipelines asking: the stronger action wins (shutdown over sleep).
    if (this.#wanted !== undefined && STRENGTH[this.#wanted.action] >= STRENGTH[action]) return
    this.#stopCountdown('换成了更后面的流水线要求的动作')
    this.#wanted = { action, pipelineName: run.pipelineName, runId: run.id }
    this.#deps.log.info(`${action} after ${run.pipelineId}, once nothing runs`)
    this.check()
    this.#deps.changed()
  }

  /** Every second: keep awake while things run; count down once they stop. */
  check(): void {
    const level = this.#deps.activity()
    if (level !== this.#level) {
      this.#level = level
      this.#deps.port.hold(level)
      this.#deps.changed()
    }
    const w = this.#wanted
    if (w === undefined) return
    const now = this.#now()
    if (level !== undefined) {
      delete w.idleSince
      if (w.countdown !== undefined) {
        this.#stopCountdown('又有任务开始了：等它结束后重新倒计时')
        this.#deps.changed()
      }
      return
    }
    w.idleSince ??= now
    if (w.countdown === undefined && now - w.idleSince >= (this.#deps.settleMs ?? 20_000)) this.#begin(w)
  }

  /** @returns false when nothing was on its way. */
  cancel(by: string): boolean {
    const w = this.#wanted
    if (w === undefined) return false
    this.#stopCountdown(`已取消${POWER_WORD[w.action]}（${by}）`)
    this.#wanted = undefined
    this.#deps.log.info(`${w.action} cancelled by ${by}`)
    this.#deps.changed()
    return true
  }

  dispose(): void {
    if (this.#wanted?.countdown !== undefined) clearTimeout(this.#wanted.countdown.timer)
    this.#wanted = undefined
    if (this.#level !== undefined) this.#deps.port.hold(undefined)
    this.#level = undefined
  }

  #begin(w: Wanted): void {
    const word = POWER_WORD[w.action]
    const now = this.#now()
    const next = this.#deps.nextSlot()
    if (next !== undefined && next - now < NEAR_SLOT_MS) {
      this.#wanted = undefined
      this.#send({ id: `power:${w.runId}:${++this.#notices}`, scope: 'power', severity: 'info', title: `这次不${word}`, text: `「${w.pipelineName}」结束了，但 ${Math.max(1, Math.round((next - now) / 60_000))} 分钟后还有定时任务，所以没有${word}。` })
      this.#deps.changed()
      return
    }
    const ms = this.#deps.countdownMs()
    const noticeId = `power:${w.runId}:${++this.#notices}`
    w.countdown = { at: now + ms, noticeId, timer: setTimeout(() => void this.#fire(w), ms) }
    w.countdown.timer.unref?.()
    const label = `取消${word}`
    this.#send({
      id: noticeId, scope: 'power', severity: 'warning', title: `${Math.round(ms / 1000)} 秒后${word}`,
      text: [
        `「${w.pipelineName}」已结束，没有别的任务在运行，${Math.round(ms / 1000)} 秒后电脑${word}。`,
        ...(w.action === 'shutdown' ? ['关机会强制关闭所有程序，没保存的内容会丢失。'] : []),
        `不要${word}就点「${label}」，或回复「${label}」。`,
      ].join('\n'),
      actions: [{ id: 'cancel', label, style: 'danger' }],
    })
    this.#deps.log.info(`${w.action} in ${Math.round(ms / 1000)} s`)
    this.#deps.changed()
  }

  async #fire(w: Wanted): Promise<void> {
    if (this.#wanted !== w) return
    const word = POWER_WORD[w.action]
    const noticeId = w.countdown?.noticeId
    this.#wanted = undefined
    this.#deps.changed()
    this.#deps.log.info(`${w.action} now (after ${w.pipelineName})`)
    if (noticeId !== undefined) await this.#deps.notices()?.update(noticeId, { done: `正在${word}` }).catch(() => {})
    try {
      await this.#deps.port.perform(w.action)
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error)
      this.#deps.log.warn(`${w.action} failed: ${text}`)
      this.#send({ id: `power:${w.runId}:${++this.#notices}`, scope: 'power', severity: 'warning', title: `没能${word}`, text })
    }
  }

  #stopCountdown(done: string): void {
    const c = this.#wanted?.countdown
    if (c === undefined) return
    clearTimeout(c.timer)
    delete this.#wanted!.countdown
    void this.#deps.notices()?.update(c.noticeId, { done }).catch(() => {})
  }

  #send(notice: PowerNotice): void {
    void this.#deps.notices()?.send(notice).catch(error => this.#deps.log.warn(`power notice not sent: ${error instanceof Error ? error.message : String(error)}`))
  }
}
