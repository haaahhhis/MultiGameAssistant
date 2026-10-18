/**
 * Apply a {@link FixPlan}. Callers gate this behind the user's approval; an
 * installer fix additionally shows the system UAC prompt, which only the user
 * can answer.
 */
import { execFile } from 'node:child_process'
import { rename, rm } from 'node:fs/promises'
import { basename, join } from 'node:path'
import type { FixPlan } from './env.ts'
import { extract } from './extract.ts'

export interface FixDeps {
  /** Shared tools directory; downloads go to `<sharedDir>/downloads`. */
  readonly sharedDir: string
  /** Download `url` to `dest` (resumable, mirrors as configured). */
  download(url: string, dest: string, onProgress: (received: number, total: number | undefined) => void): Promise<void>
  /** Run a program elevated and return its exit code. Default: PowerShell `Start-Process -Verb RunAs`. */
  runElevated?(file: string, args: readonly string[]): Promise<number>
  readonly onPhase?: (phase: 'downloading' | 'extracting' | 'running', received?: number, total?: number) => void
  readonly signal?: AbortSignal
}

export class ManualFixError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ManualFixError'
  }
}

export async function applyFix(plan: FixPlan, deps: FixDeps): Promise<void> {
  if (plan.kind === 'manual') throw new ManualFixError(`需要手动处理：${plan.description}`)
  const downloads = join(deps.sharedDir, 'downloads')
  const fileName = plan.kind === 'run-installer' ? plan.fileName : basename(new URL(plan.url).pathname)
  const file = join(downloads, fileName)
  deps.onPhase?.('downloading')
  await deps.download(plan.url, file, (received, total) => deps.onPhase?.('downloading', received, total))
  deps.signal?.throwIfAborted()

  if (plan.kind === 'download-extract') {
    deps.onPhase?.('extracting')
    const fresh = `${plan.into}.new`
    await rm(fresh, { recursive: true, force: true })
    await extract(file, fresh, deps.signal === undefined ? {} : { signal: deps.signal })
    await rm(plan.into, { recursive: true, force: true })
    await rename(fresh, plan.into)
    return
  }

  deps.onPhase?.('running')
  const code = await (deps.runElevated ?? runElevated)(file, plan.args)
  if (!plan.okCodes.includes(code)) {
    throw new Error(code === 1223 ? '已取消管理员授权，安装没有进行' : `安装程序退出码 ${code}`)
  }
}

/**
 * Start `file` elevated and wait. The arguments travel inside an encoded
 * PowerShell command, so no quoting of user-visible paths can break out.
 * @returns the program's exit code; 1223 when the user declined UAC.
 */
export function runElevated(file: string, args: readonly string[]): Promise<number> {
  const quote = (value: string) => `'${value.replaceAll("'", "''")}'`
  const script = [
    '$ErrorActionPreference = "Stop"',
    'try {',
    `  $p = Start-Process -FilePath ${quote(file)} -ArgumentList @(${args.map(quote).join(', ') || "''"}) -Verb RunAs -Wait -PassThru`,
    '  exit $p.ExitCode',
    '} catch [System.InvalidOperationException] { exit 1223 } catch { if ($_.Exception.HResult -eq -2147467259) { exit 1223 } ; exit 1 }',
  ].join('\n')
  const encoded = Buffer.from(script, 'utf16le').toString('base64')
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], { windowsHide: true }, error => {
      resolve(error === null ? 0 : typeof error.code === 'number' ? error.code : 1)
    })
  })
}
