/**
 * Windows' side of power (docs/PLAN.zh.md §5.9):
 *
 * - Holding off sleep: `SetThreadExecutionState` belongs to a thread, and a
 *   Node process cannot call it, so a small hidden PowerShell process makes
 *   the call and then waits on its stdin. Each line sets the level; when the
 *   pipe closes — let go, or this process died — it exits and Windows forgets
 *   the request.
 * - Sleep (`SetSuspendState`, wake timers left on), hibernate (`shutdown /h`),
 *   shut down (`shutdown /s /f`).
 * - Timed wake: a second Task Scheduler task, "AutoDailyGamePlay Wake", with a
 *   one-time trigger shortly before each upcoming scheduled time and "wake the
 *   computer to run this task". It starts the desktop app with `--wake`: a
 *   running app ignores it, a closed one starts in the tray (and runs nothing
 *   on start) so the scheduled time is caught. Belongs to the current user,
 *   no administrator rights needed.
 */
import { spawn, type ChildProcess } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { decode, escape as xml, joinArgs, systemExec, unescape as unxml, type ExecBuffer } from './autostart.ts'
import type { AwakeLevel, PowerPort, SleepAction } from './power.ts'

// ES_CONTINUOUS | ES_SYSTEM_REQUIRED (| ES_DISPLAY_REQUIRED), in decimal: PowerShell 5.1 reads 0x80000001 as a negative Int32.
const HOLD_SCRIPT = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Add-Type -Name Power -Namespace AdgKeepAwake -MemberDefinition '[DllImport("kernel32.dll")] public static extern uint SetThreadExecutionState(uint flags);'
while ($null -ne ($line = [Console]::In.ReadLine())) {
  $flags = if ($line -eq 'display') { 2147483651 } else { 2147483649 }
  [void][AdgKeepAwake.Power]::SetThreadExecutionState($flags)
}
`
const SLEEP_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Add-Type -AssemblyName System.Windows.Forms
if (-not [System.Windows.Forms.Application]::SetSuspendState([System.Windows.Forms.PowerState]::Suspend, $false, $false)) { exit 1 }
`

export interface WindowsPowerOptions {
  readonly exec?: ExecBuffer
  readonly platform?: NodeJS.Platform
  readonly log: { warn(message: string): void }
  /** Given: say what would be done instead of doing it. */
  readonly dryRun?: (message: string) => void
}

export function windowsPower(options: WindowsPowerOptions): PowerPort {
  const platform = options.platform ?? process.platform
  const exec = options.exec ?? systemExec
  let holder: ChildProcess | undefined
  return {
    hold(level: AwakeLevel | undefined) {
      if (platform !== 'win32') return
      if (level === undefined) {
        holder?.stdin?.end()
        holder = undefined
        return
      }
      if (holder === undefined || holder.exitCode !== null) {
        const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(HOLD_SCRIPT)], { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] })
        let stderr = ''
        child.stderr?.setEncoding('utf8').on('data', chunk => { stderr += chunk })
        child.on('error', error => options.log.warn(`keeping the computer awake failed: ${error.message}`))
        child.on('exit', code => { if (code !== 0 && code !== null) options.log.warn(`the keep-awake helper exited (${code}): ${stderr.trim().slice(0, 300)}`) })
        child.stdin?.on('error', () => {})
        holder = child
      }
      holder.stdin?.write(`${level}\n`)
    },
    async perform(action: SleepAction) {
      if (options.dryRun !== undefined) { options.dryRun(`dry run (ADG_POWER_DRY_RUN): would ${action} now`); return }
      if (platform !== 'win32') throw new Error('只支持 Windows')
      if (action === 'shutdown') {
        const result = await exec('shutdown.exe', ['/s', '/f', '/t', '0'])
        if (result === undefined || result.code !== 0) throw new Error(`关机失败：${result === undefined ? '找不到 shutdown.exe' : output(result)}`)
        return
      }
      // Both return only after the computer wakes up again: a quick failure is a failure, a long wait is success.
      const [file, args] = action === 'sleep'
        ? ['powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded(SLEEP_SCRIPT)]] as const
        : ['shutdown.exe', ['/h']] as const
      const result = await Promise.race([exec(file, args), new Promise<'waiting'>(resolve => setTimeout(() => resolve('waiting'), 15_000).unref())])
      if (result === 'waiting' || result?.code === 0) return
      throw new Error(`${action === 'sleep' ? '睡眠' : '休眠'}失败：${result === undefined ? `找不到 ${file}` : output(result) || '系统拒绝了'}${action === 'hibernate' ? '（休眠可能没有开启：管理员运行 powercfg /hibernate on）' : ''}`)
    },
  }
}

/** Waking the computer from sleep shortly before scheduled times. */
export interface WakePort {
  available(): boolean
  status(): Promise<{ registered: boolean; next?: number; detail?: string }>
  /** Replace the wake-up times (local instants). */
  sync(times: readonly number[]): Promise<void>
  remove(): Promise<void>
}

export interface WindowsWakeOptions {
  /** Program and arguments, ending with `--wake`. Undefined: not available. */
  readonly command?: readonly string[] | undefined
  readonly taskName?: string
  readonly user?: string
  readonly exec?: ExecBuffer
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
}

export function windowsWake(options: WindowsWakeOptions): WakePort {
  const taskName = options.taskName ?? 'AutoDailyGamePlay Wake'
  const exec = options.exec ?? systemExec
  const command = options.command
  const user = options.user ?? `${process.env['USERDOMAIN'] ?? ''}\\${process.env['USERNAME'] ?? ''}`.replace(/^\\/, '')
  const platform = options.platform ?? process.platform
  const now = options.now ?? Date.now
  return {
    available: () => platform === 'win32' && command !== undefined && command.length > 0,
    async status() {
      if (platform !== 'win32') return { registered: false, detail: '定时唤醒目前只支持 Windows' }
      const result = await exec('schtasks.exe', ['/Query', '/TN', taskName, '/XML'])
      if (result === undefined || result.code !== 0) return { registered: false }
      const xmlText = decode(result.stdout)
      const times = [...xmlText.matchAll(/<StartBoundary>([^<]+)<\/StartBoundary>/g)].map(m => new Date(unxml(m[1]!)).getTime()).filter(t => t > now()).sort((a, b) => a - b)
      return { registered: true, ...(times.length > 0 ? { next: times[0]! } : {}) }
    },
    async sync(times) {
      if (platform !== 'win32' || command === undefined || command.length === 0) throw new Error('只有桌面版能设置定时唤醒')
      const dir = await mkdtemp(join(tmpdir(), 'adg-wake-'))
      try {
        const file = join(dir, 'wake.xml')
        await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(wakeTaskXml(command, user, times), 'utf16le')]))
        const result = await exec('schtasks.exe', ['/Create', '/TN', taskName, '/XML', file, '/F'])
        if (result === undefined) throw new Error('找不到 schtasks.exe')
        if (result.code !== 0) throw new Error(`注册定时唤醒失败：${output(result)}`)
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
    async remove() {
      if (platform !== 'win32') return
      const result = await exec('schtasks.exe', ['/Delete', '/TN', taskName, '/F'])
      if (result !== undefined && result.code !== 0 && (await this.status()).registered) throw new Error(`取消定时唤醒失败：${output(result)}`)
    },
  }
}

/** One-time triggers at `times` that wake the computer; the action starts the app quietly. */
export function wakeTaskXml(command: readonly string[], user: string, times: readonly number[]): string {
  const triggers = times.map(t => `    <TimeTrigger>
      <StartBoundary>${localIso(t)}</StartBoundary>
      <Enabled>true</Enabled>
    </TimeTrigger>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>AutoDailyGamePlay：在定时任务开始前把电脑从睡眠中唤醒</Description>
  </RegistrationInfo>
  <Triggers>
${triggers}
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${xml(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>Parallel</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>false</StartWhenAvailable>
    <WakeToRun>true</WakeToRun>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${xml(command[0]!)}</Command>
      <Arguments>${xml(joinArgs(command.slice(1)))}</Arguments>
      <WorkingDirectory>${xml(dirname(command[0]!))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

/** `2026-10-25T04:28:00`: local wall-clock time, which Task Scheduler reads as local. */
export function localIso(at: number): string {
  const d = new Date(at)
  const p = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
}

function encoded(script: string): string {
  return Buffer.from(script, 'utf16le').toString('base64')
}

function output(result: { stdout: Buffer; stderr: Buffer }): string {
  return (decode(result.stderr) || decode(result.stdout)).trim()
}
