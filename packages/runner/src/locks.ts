/**
 * What running tasks occupy: the desktop's mouse and
 * keyboard, one emulator, one game account. Two runs may overlap only when
 * their resources do not. A conflicting start is refused with a BusyError;
 * the orchestrator waits and tries again.
 */

export interface Holder {
  readonly runId: string
  readonly label: string
}

/** A resource is held by another run; nothing was started. */
export class BusyError extends Error {
  readonly key: string
  readonly holder: Holder
  constructor(key: string, holder: Holder) {
    super(`${describe(key)}正被「${holder.label}」占用，请等它结束后再运行`)
    this.name = 'BusyError'
    this.key = key
    this.holder = holder
  }

  /** "桌面鼠标键盘（MAA · 日常）", for "等待资源：…". */
  get resource(): string {
    return `${describe(this.key).trim()}（${this.holder.label}）`
  }
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
   * @throws BusyError naming the resource and who holds it.
   */
  acquire(keys: readonly string[], holder: Holder): () => void {
    const busy = this.conflict(keys)
    if (busy !== undefined) throw new BusyError(busy.key, busy.holder)
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
