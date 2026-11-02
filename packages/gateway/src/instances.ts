/**
 * Copies of this app running at the same time on this computer: the desktop
 * app and the dsh plugin, or the plugin in two dsh. Neither knows the other's
 * scripts, resource locks, schedules or Feishu connection, so each says what
 * clashes. Every copy keeps a heartbeat file in a folder of the user's temp
 * folder and reads the others'.
 */
import { mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import type { OtherCopy } from '@adg/protocol'
import { writeFileAtomic } from '@adg/protocol/node'

/** Something a copy uses that another must not use too: a Feishu bot (a hash of its App ID), or whether it has schedules. */
export type Fact = string | boolean | undefined

export interface CopyRecord {
  readonly pid: number
  readonly label: string
  readonly dataDir?: string
  readonly startedAt: number
  readonly updatedAt: number
  readonly facts: Readonly<Record<string, string | boolean>>
}

export const INSTANCES_DIR = join(tmpdir(), 'MultiGameAssistant', 'instances')
/** A copy that has not written for this long is asleep or gone. */
const STALE_MS = 3 * 60_000
/** Files of copies this old are removed even when their process id is in use again. */
const FORGET_MS = 24 * 60 * 60_000

/** What this copy is, in words. */
export function copyLabel(shared: boolean, env: NodeJS.ProcessEnv = process.env): string {
  if (shared) return 'dsh 插件版'
  if (env['ADG_LAUNCH_COMMAND'] !== undefined) return '桌面版'
  return '完整版（dsh 命令行）'
}

function sameDir(a: string | undefined, b: string | undefined): boolean {
  if (a === undefined || b === undefined) return false
  const norm = (dir: string) => (process.platform === 'win32' ? resolve(dir).toLowerCase() : resolve(dir))
  return norm(a) === norm(b)
}

/** What clashes between this copy and another, one sentence each; the first is always the general one. */
export function clashes(self: CopyRecord, other: CopyRecord): string[] {
  const warnings = ['两边各自运行脚本，互相不知道对方在用哪个模拟器或游戏窗口，可能同时操作同一个。建议同一时间只开一个：关掉另一个，或停掉它那边的定时流水线。']
  if (sameDir(self.dataDir, other.dataDir)) warnings.push(`它和这里用的是同一份数据（${other.dataDir}），设置和记录可能被互相覆盖。`)
  const bot = self.facts['feishu']
  if (typeof bot === 'string' && bot === other.facts['feishu']) warnings.push('两边连着同一个飞书机器人：飞书会把消息和卡片按钮随机交给其中一个，回复和按钮可能对不上。只在一边开飞书。')
  if (self.facts['schedules'] === true && other.facts['schedules'] === true) warnings.push('两边都有定时流水线，到点会各跑各的，也会各自执行跑完后的睡眠或关机。')
  return warnings
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export interface InstancesOptions {
  readonly label: string
  readonly dataDir?: string
  /** @default INSTANCES_DIR */
  readonly dir?: string
  readonly pid?: number
  readonly now?: () => number
  readonly alive?: (pid: number) => boolean
  readonly log: { warn(message: string): void }
}

export class Instances {
  readonly #options: InstancesOptions
  readonly #dir: string
  readonly #pid: number
  readonly #startedAt: number
  readonly #facts = new Map<string, () => Fact>()
  #others: OtherCopy[] = []
  #timer: ReturnType<typeof setInterval> | undefined
  #beating: Promise<boolean> | undefined

  constructor(options: InstancesOptions) {
    this.#options = options
    this.#dir = options.dir ?? INSTANCES_DIR
    this.#pid = options.pid ?? process.pid
    this.#startedAt = this.#now()
  }

  /** Report something this copy uses (read at every heartbeat). @returns its removal. */
  fact(key: string, read: () => Fact): () => void {
    this.#facts.set(key, read)
    return () => { if (this.#facts.get(key) === read) this.#facts.delete(key) }
  }

  /** The other copies as of the last heartbeat. */
  others(): OtherCopy[] {
    return this.#others
  }

  /** Write this copy's record and read the others'. @returns whether what the others are or clash with changed. */
  beat(): Promise<boolean> {
    this.#beating ??= this.#beat().finally(() => { this.#beating = undefined })
    return this.#beating
  }

  /** Heartbeats every `intervalMs` from now on; `onChange` when the others changed. */
  start(intervalMs: number, onChange: (others: OtherCopy[]) => void): void {
    const tick = () => void this.beat().then(changed => { if (changed) onChange(this.#others) })
    tick()
    this.#timer = setInterval(tick, intervalMs)
    this.#timer.unref?.()
  }

  /** Stop and take this copy's record away. */
  async stop(): Promise<void> {
    if (this.#timer !== undefined) clearInterval(this.#timer)
    this.#timer = undefined
    await rm(this.#file(this.#pid), { force: true }).catch(() => {})
  }

  #record(): CopyRecord {
    const facts: Record<string, string | boolean> = {}
    for (const [key, read] of this.#facts) {
      try {
        const value = read()
        if (value !== undefined) facts[key] = value
      } catch { /* a reporter that fails says nothing */ }
    }
    return {
      pid: this.#pid, label: this.#options.label, ...(this.#options.dataDir === undefined ? {} : { dataDir: this.#options.dataDir }),
      startedAt: this.#startedAt, updatedAt: this.#now(), facts,
    }
  }

  async #beat(): Promise<boolean> {
    const self = this.#record()
    const others: OtherCopy[] = []
    try {
      await mkdir(this.#dir, { recursive: true })
      await writeFileAtomic(this.#file(this.#pid), JSON.stringify(self))
      const alive = this.#options.alive ?? processAlive
      for (const name of await readdir(this.#dir)) {
        const match = /^(\d+)\.json$/.exec(name)
        if (match === null || Number(match[1]) === this.#pid) continue
        let other: CopyRecord
        try {
          other = JSON.parse(await readFile(join(this.#dir, name), 'utf8')) as CopyRecord
        } catch {
          continue // being written, or not ours
        }
        const age = self.updatedAt - other.updatedAt
        if (!alive(other.pid) || age > FORGET_MS) { await rm(join(this.#dir, name), { force: true }).catch(() => {}); continue }
        if (age > STALE_MS) continue
        others.push({ pid: other.pid, label: other.label, ...(other.dataDir === undefined ? {} : { dataDir: other.dataDir }), startedAt: other.startedAt, warnings: clashes(self, other) })
      }
    } catch (error) {
      this.#options.log.warn(`checking for other copies of the app failed: ${error instanceof Error ? error.message : String(error)}`)
      return false
    }
    others.sort((a, b) => a.startedAt - b.startedAt)
    const changed = JSON.stringify(others) !== JSON.stringify(this.#others)
    this.#others = others
    return changed
  }

  #file(pid: number): string {
    return join(this.#dir, `${pid}.json`)
  }

  #now(): number {
    return (this.#options.now ?? Date.now)()
  }
}
