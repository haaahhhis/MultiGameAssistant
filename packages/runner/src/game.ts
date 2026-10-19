/**
 * Starting the game before a run, for scripts that do not start it
 * themselves, without fighting those that do:
 *
 * - `off`: never; `auto` (default): only when the pack says the script will
 *   not start it in this run (`game.selfLaunch`, checked against the config
 *   the run actually uses); `platform`: whenever it is not running.
 * - Never when it is already running (a process for PC games, `pidof` in the
 *   emulator for Android games).
 * - Android games start in the emulator the task uses (after the emulator
 *   itself is up); PC games from the program path the user set.
 *
 * Settings per script: `<dataDir>/configs/<script>/launch.json`.
 */
import { execFile, spawn } from 'node:child_process'
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import type { Game, ScriptManifest } from '@adg/pack-schema'
import type { LaunchSettings } from '@adg/protocol'
import { parseConfig } from './choices.ts'
import { inside } from './patch.ts'

export const DEFAULT_LAUNCH: LaunchSettings = { mode: 'auto' }

export class LaunchStore {
  readonly #root: string
  constructor(dataDir: string) {
    this.#root = join(dataDir, 'configs')
  }

  async get(scriptId: string): Promise<LaunchSettings> {
    try {
      return { ...DEFAULT_LAUNCH, ...JSON.parse(await readFile(join(this.#root, scriptId, 'launch.json'), 'utf8')) as Partial<LaunchSettings> }
    } catch {
      return DEFAULT_LAUNCH
    }
  }

  async set(scriptId: string, patch: { [K in keyof LaunchSettings]?: LaunchSettings[K] | null | undefined }): Promise<LaunchSettings> {
    const next: Record<string, unknown> = { ...(await this.get(scriptId)) }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (value === null || value === '') delete next[key]
      else next[key] = value
    }
    const dir = join(this.#root, scriptId)
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'launch.json.tmp'), `${JSON.stringify(next, null, 2)}\n`)
    await rename(join(dir, 'launch.json.tmp'), join(dir, 'launch.json'))
    return next as LaunchSettings
  }
}

/** "脚本自己会启动游戏" in words, for the settings page. */
export function describeSelfLaunch(game: Game | undefined): string {
  if (game === undefined || game.selfLaunch === 'never') return '脚本不会自己启动游戏'
  if (game.selfLaunch === 'always') return '脚本自己会启动游戏'
  return `脚本设置里打开了 ${game.selfLaunch.map(c => c.path.at(-1)).join(' / ')} 时，脚本自己会启动游戏`
}

/** Whether the script starts the game itself in this run, judged from the config files now in its directory. */
export async function scriptLaunchesGame(game: Game | undefined, scriptDir: string): Promise<boolean> {
  if (game === undefined || game.selfLaunch === 'never') return false
  if (game.selfLaunch === 'always') return true
  for (const condition of game.selfLaunch) {
    try {
      let node = parseConfig(condition.file, await readFile(inside(scriptDir, condition.file), 'utf8'))
      for (const key of condition.path) node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
      if (node !== undefined && String(node).toLowerCase() === String(condition.equals).toLowerCase()) return true
    } catch { /* missing or unreadable: does not say so */ }
  }
  return false
}

/** What the runner needs to start an Android game. */
export interface AndroidPort {
  appRunning?(address: string, pkg: string): Promise<boolean>
  launchApp?(address: string, pkg: string): Promise<void>
}

export interface GameStart {
  readonly manifest: ScriptManifest
  readonly settings: LaunchSettings
  readonly input: 'desktop' | 'window' | 'adb' | 'none'
  readonly scriptDir: string
  readonly address?: string | undefined
  readonly android: AndroidPort | undefined
  readonly signal: AbortSignal
  readonly line: (text: string) => void
  /** Injected for tests. */
  readonly processRunning?: (name: string) => Promise<boolean>
  readonly startProgram?: (exe: string) => void
  readonly sleep?: (ms: number, signal: AbortSignal) => Promise<void>
}

/**
 * Start the game when it is needed and nobody else will.
 * @throws Error when it was needed but could not be started.
 */
export async function ensureGame(start: GameStart): Promise<void> {
  const { manifest, settings, line } = start
  if (settings.mode === 'off') return
  const game = manifest.game
  const sleep = start.sleep ?? delay
  const startupMs = (game?.startupSeconds ?? 30) * 1000
  const name = game?.name ?? '游戏'
  if (settings.mode === 'auto' && await scriptLaunchesGame(game, start.scriptDir)) {
    if (game !== undefined) line(`${name}由脚本自己启动`)
    return
  }

  if (start.input === 'adb') {
    const pkg = settings.androidPackage ?? game?.android?.package
    if (pkg === undefined || start.address === undefined || start.android?.launchApp === undefined) return
    if (await start.android.appRunning?.(start.address, pkg).catch(() => false)) {
      line(`${name}（${pkg}）已经在模拟器里运行`)
      return
    }
    line(`在模拟器里启动${name}（${pkg}）`)
    await start.android.launchApp(start.address, pkg)
    if (startupMs > 0) {
      line(`等${name}启动 ${startupMs / 1000} 秒`)
      await sleep(startupMs, start.signal)
    }
    return
  }

  if (start.input === 'desktop' || start.input === 'window') {
    const exe = settings.pcExe
    const processName = settings.pcProcess ?? game?.pc?.process ?? (exe === undefined ? undefined : basename(exe))
    if (exe === undefined) return
    const running = start.processRunning ?? processRunning
    if (processName !== undefined && await running(processName)) {
      line(`${name}（${processName}）已经在运行`)
      return
    }
    line(`启动${name}：${exe}`)
    ;(start.startProgram ?? startProgram)(exe)
    // Wait for it to show up (launchers may take a while), then give it time to load.
    for (let waited = 0; processName !== undefined && waited < 90_000 && !(await running(processName)); waited += 2000) await sleep(2000, start.signal)
    if (startupMs > 0) {
      line(`等${name}启动 ${startupMs / 1000} 秒`)
      await sleep(startupMs, start.signal)
    }
  }
}

/** Is a process with this image name running? (Windows `tasklist`.) */
export function processRunning(name: string): Promise<boolean> {
  if (process.platform !== 'win32') return Promise.resolve(false)
  const image = name.toLowerCase().endsWith('.exe') ? name : `${name}.exe`
  return new Promise(resolve => {
    execFile('tasklist.exe', ['/FI', `IMAGENAME eq ${image}`, '/FO', 'CSV', '/NH'], { windowsHide: true, timeout: 15_000 }, (_error, stdout) => {
      resolve(String(stdout).toLowerCase().includes(`"${image.toLowerCase()}"`))
    })
  })
}

/** Start a program on its own, not as our child (it outlives the run). */
export function startProgram(exe: string): void {
  const child = spawn(exe, [], { cwd: dirname(exe), detached: true, stdio: 'ignore', windowsHide: false })
  child.on('error', () => {})
  child.unref()
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(signal.reason)
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(signal.reason) }, { once: true })
  })
}
