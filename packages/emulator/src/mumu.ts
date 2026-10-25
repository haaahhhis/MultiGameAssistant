/**
 * MuMu emulator control through its command-line manager, `MuMuManager.exe`:
 *
 *   MuMuManager.exe info -v <index|all>      instance facts (JSON)
 *   MuMuManager.exe control -v <index> launch
 *   MuMuManager.exe control -v <index> shutdown
 *   MuMuManager.exe adb -v <index>           ADB endpoint (JSON)
 *
 * The output is JSON, sometimes with log noise around it, and is a single
 * object for one instance or a map of objects for `all`. Field names follow
 * what MuMu prints (`index`, `name`, `is_process_started`,
 * `is_android_started`, `adb_host_ip`, `adb_port`).
 */
import type { EmulatorInstance } from '@adg/protocol'

export type Exec = (file: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<{ code: number; stdout: string; stderr: string } | undefined>

/** MuMu 12's documented default port for instance N when `info` does not say. */
export function defaultMumuPort(index: number): number {
  return 16384 + 32 * index
}

export class MuMuManager {
  readonly path: string
  readonly #exec: Exec

  constructor(path: string, exec: Exec) {
    this.path = path
    this.#exec = exec
  }

  async instances(): Promise<EmulatorInstance[]> {
    const data = await this.#json(['info', '-v', 'all'])
    return entries(data).map(toInstance).sort((a, b) => a.index - b.index)
  }

  async instance(index: number): Promise<EmulatorInstance | undefined> {
    const data = await this.#json(['info', '-v', String(index)])
    return entries(data).map(toInstance).find(i => i.index === index)
  }

  async launch(index: number): Promise<void> {
    await this.#run(['control', '-v', String(index), 'launch'], '启动')
  }

  /**
   * Shut an instance down and make sure it went: MuMu's `shutdown` only asks,
   * and a busy or hung instance can ignore it. Wait, ask once more, and as a
   * last resort end the instance's own processes (`pid`, `headless_pid` from
   * `info`).
   * @throws Error when it is still running after all that.
   */
  async shutdown(index: number, options: { waitMs?: number; pollMs?: number } = {}): Promise<void> {
    const wait = options.waitMs ?? 30_000
    const down = async (ms: number) => {
      for (const deadline = Date.now() + ms; Date.now() < deadline;) {
        await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 1500))
        if ((await this.instance(index).catch(() => undefined))?.running !== true) return true
      }
      return false
    }
    if ((await this.instance(index).catch(() => undefined))?.running === false) return
    await this.#run(['control', '-v', String(index), 'shutdown'], '关闭')
    if (await down(wait)) return
    await this.#run(['control', '-v', String(index), 'shutdown'], '关闭').catch(() => '')
    if (await down(wait / 2)) return
    const raw = entries(await this.#json(['info', '-v', String(index)]).catch(() => ({}))).find(e => Number(e['index']) === index) ?? {}
    const pids = ['pid', 'headless_pid'].map(k => Number(raw[k])).filter(p => Number.isInteger(p) && p > 0)
    for (const pid of pids) await this.#exec('taskkill', ['/PID', String(pid), '/T', '/F'], { timeoutMs: 15_000 })
    if (pids.length > 0 && await down(10_000)) return
    throw new Error(`MuMu 实例 ${index} 关不掉：发了两次关闭命令${pids.length > 0 ? `，也结束了它的进程（${pids.join('、')}）` : ''}，它还在运行。可能需要用管理员身份运行本软件，或者在 MuMu 多开器里手动关闭`)
  }

  /** The instance's ADB address: from `info`, else `adb -v`, else the default port. */
  async adbAddress(index: number): Promise<string> {
    const known = (await this.instance(index))?.adb
    if (known !== undefined) return known
    try {
      const data = await this.#json(['adb', '-v', String(index)])
      const address = addressOf(data as Record<string, unknown>)
      if (address !== undefined) return address
    } catch {
      // fall through to the default
    }
    return `127.0.0.1:${defaultMumuPort(index)}`
  }

  /**
   * Launch if needed and wait until Android has booted.
   * @throws Error when it does not become ready within `timeoutMs`.
   */
  async ensureReady(index: number, options: { timeoutMs: number; signal?: AbortSignal; onStatus?: (text: string) => void; pollMs?: number }): Promise<EmulatorInstance> {
    let state = await this.instance(index)
    if (state === undefined) throw new Error(`MuMu 没有实例 ${index}；可用实例：${(await this.instances()).map(i => `${i.index}（${i.name}）`).join('、') || '无'}`)
    if (state.ready) return state
    if (!state.running) {
      options.onStatus?.(`启动 MuMu 实例 ${index}（${state.name}）`)
      await this.launch(index)
    }
    options.onStatus?.('等待安卓系统启动完成…')
    const deadline = Date.now() + options.timeoutMs
    while (Date.now() < deadline) {
      options.signal?.throwIfAborted()
      await new Promise(resolve => setTimeout(resolve, options.pollMs ?? 2000))
      state = await this.instance(index)
      if (state?.ready === true) return state
    }
    throw new Error(`MuMu 实例 ${index} 在 ${Math.round(options.timeoutMs / 1000)} 秒内没有启动完成`)
  }

  async #run(args: readonly string[], what: string): Promise<string> {
    const result = await this.#exec(this.path, args, { timeoutMs: 60_000 })
    if (result === undefined) throw new Error(`找不到 MuMuManager：${this.path}`)
    if (result.code !== 0) throw new Error(`MuMu ${what}失败（退出码 ${result.code}）：${(result.stderr || result.stdout).trim().slice(0, 300)}`)
    return result.stdout
  }

  async #json(args: readonly string[]): Promise<unknown> {
    return parsePolluted(await this.#run(args, '查询'))
  }
}

/** Parse the JSON object in `text`, ignoring log lines printed around it. */
export function parsePolluted(text: string): unknown {
  const start = text.indexOf('{')
  const end = text.lastIndexOf('}')
  if (start < 0 || end < start) throw new Error(`MuMu 输出里没有 JSON：${text.trim().slice(0, 200)}`)
  return JSON.parse(text.slice(start, end + 1))
}

function entries(data: unknown): Record<string, unknown>[] {
  if (typeof data !== 'object' || data === null) return []
  const object = data as Record<string, unknown>
  if ('index' in object && 'name' in object) return [object]
  return Object.values(object).filter((v): v is Record<string, unknown> => typeof v === 'object' && v !== null && 'index' in v && 'name' in v)
}

function toInstance(entry: Record<string, unknown>): EmulatorInstance {
  const index = Number(entry['index'])
  const address = addressOf(entry)
  return {
    index,
    name: String(entry['name']),
    running: entry['is_process_started'] === true,
    ready: entry['is_android_started'] === true,
    ...(address === undefined ? {} : { adb: address }),
  }
}

function addressOf(entry: Record<string, unknown>): string | undefined {
  const host = entry['adb_host_ip'] ?? entry['adb_host']
  const port = entry['adb_port']
  return typeof host === 'string' && host !== '' && (typeof port === 'number' || (typeof port === 'string' && port !== '')) ? `${host}:${port}` : undefined
}
