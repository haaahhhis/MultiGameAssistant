/**
 * Setup programs: some projects publish their full package only as an
 * installer (NSIS or Inno Setup `setup.exe`), not an archive, Mirror酱 too.
 * There is nothing to unpack; the installer has to run. Both kinds install
 * quietly into a chosen folder, or show their own window for someone (the
 * agent, through the screen tools) to click through.
 */
import { spawn } from 'node:child_process'
import { open } from 'node:fs/promises'

export type SetupKind = 'nsis' | 'inno'

/** The installer's manifest and data headers sit in the first few megabytes of the exe. */
const SNIFF_BYTES = 8 * 1024 * 1024
const MARKERS: readonly { kind: SetupKind; text: string }[] = [
  { kind: 'nsis', text: 'Nullsoft.NSIS.exehead' },
  { kind: 'nsis', text: 'NullsoftInst' },
  { kind: 'inno', text: 'JR.Inno.Setup' },
  { kind: 'inno', text: 'Inno Setup Setup Data' },
]

/** Which installer `file` is; undefined for anything else (an ordinary program, not an exe). */
export async function setupKind(file: string): Promise<SetupKind | undefined> {
  const handle = await open(file, 'r').catch(() => undefined)
  if (handle === undefined) return undefined
  try {
    const buffer = Buffer.alloc(SNIFF_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, SNIFF_BYTES, 0)
    const head = buffer.subarray(0, bytesRead)
    if (head.length < 2 || head[0] !== 0x4d || head[1] !== 0x5a) return undefined // MZ
    const text = head.toString('latin1')
    return MARKERS.find(m => text.includes(m.text))?.kind
  } finally {
    await handle.close()
  }
}

export const SETUP_NAMES: Readonly<Record<SetupKind, string>> = { nsis: 'NSIS', inno: 'Inno Setup' }

/**
 * The command line after the exe. Quiet: no window, into `dir`. With a
 * window, `dir` is only the folder it suggests. NSIS takes `/D=` last and
 * unquoted, even with spaces.
 */
export function setupCommandLine(kind: SetupKind, dir: string, quiet: boolean): string {
  if (kind === 'nsis') return `${quiet ? '/S ' : ''}/D=${dir}`
  return `${quiet ? '/VERYSILENT /SUPPRESSMSGBOXES /NORESTART /SP- ' : ''}/DIR="${dir}"`
}

/** What the exit code means, for people. */
export function setupExitText(kind: SetupKind, code: number): string {
  if (code === 0) return '安装完成'
  const nsis: Record<number, string> = { 1: '安装被取消了', 2: '安装中途出错' }
  const inno: Record<number, string> = { 1: '安装程序没能启动', 2: '安装还没开始就被取消了', 3: '准备安装时出错', 4: '安装中途出错', 5: '安装被取消了', 6: '安装程序被强行结束', 7: '安装前检查没通过', 8: '安装前检查没通过，需要重启电脑' }
  return (kind === 'nsis' ? nsis : inno)[code] ?? `安装程序退出码 ${code}`
}

export interface RunSetupOptions {
  readonly kind: SetupKind
  readonly dir: string
  /** No window, waiting until it is done; otherwise its window opens and this returns right away. */
  readonly quiet: boolean
  readonly signal?: AbortSignal
  /** @default 30 minutes */
  readonly timeoutMs?: number
}

/** @returns the exit code (quiet), or undefined once the window was started. */
export function runSetup(file: string, options: RunSetupOptions): Promise<number | undefined> {
  const commandLine = setupCommandLine(options.kind, options.dir, options.quiet)
  return new Promise((resolve, reject) => {
    // Verbatim, for NSIS's /D=; the exe quoted by hand for that reason.
    const child = spawn(file, [commandLine], {
      argv0: `"${file}"`,
      windowsVerbatimArguments: true,
      windowsHide: options.quiet,
      detached: !options.quiet,
      stdio: 'ignore',
      ...(options.signal === undefined ? {} : { signal: options.signal }),
    })
    child.once('error', reject)
    if (!options.quiet) {
      child.once('spawn', () => { child.unref(); resolve(undefined) })
      return
    }
    const timer = setTimeout(() => { child.kill(); reject(new Error('安装程序 30 分钟还没结束，已经停掉')) }, options.timeoutMs ?? 30 * 60_000)
    child.once('exit', code => { clearTimeout(timer); resolve(code ?? 1) })
  })
}
