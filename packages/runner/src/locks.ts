/**
 * What running tasks occupy (docs/PLAN.zh.md §3.2): the desktop's mouse and
 * keyboard, one emulator, one game account. Two runs may overlap only when
 * their resources do not. M2 refuses a conflicting start; the orchestrator
 * (M4) queues it instead.
 */

export interface Holder {
  readonly runId: string
  readonly label: string
}

export class ResourceLocks {
  readonly #held = new Map<string, Holder>()

  /** The first held resource among `keys`, with its holder. */
  conflict(keys: readonly string[]): { key: string; holder: Holder } | undefined {
    for (const key of keys) {
      const holder = this.#held.get(key)
      if (holder !== undefined) return { key, holder }
    }
    return undefined
  }

  /**
   * Take every key or none.
   * @throws Error naming the resource and who holds it.
   */
  acquire(keys: readonly string[], holder: Holder): () => void {
    const busy = this.conflict(keys)
    if (busy !== undefined) throw new Error(`${describe(busy.key)}正被「${busy.holder.label}」占用，请等它结束后再运行`)
    for (const key of keys) this.#held.set(key, holder)
    return () => {
      for (const key of keys) if (this.#held.get(key)?.runId === holder.runId) this.#held.delete(key)
    }
  }

  held(): ReadonlyMap<string, Holder> {
    return this.#held
  }
}

export function describe(key: string): string {
  if (key === 'desktop') return '桌面鼠标键盘'
  if (key.startsWith('adb:')) return `模拟器 ${key.slice(4)} `
  if (key.startsWith('account:')) return `游戏账号 ${key.slice(8)} `
  if (key.startsWith('script:')) return `脚本 ${key.slice(7)} `
  return key
}
