/**
 * Starting MultiGameAssistant when the user logs on, with a Windows Task
 * Scheduler task rather than a Run registry key: no
 * execution time limit, runs on battery, starts as soon as possible when a
 * logon was missed. The task belongs to the current user and runs without
 * elevation, so registering it needs no administrator rights.
 *
 * The command comes from the desktop app (`ADG_LAUNCH_COMMAND`); a host
 * started from a terminal or opened in a browser cannot start itself.
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import type { AutostartPort } from './scheduler.ts'

export type ExecBuffer = (file: string, args: readonly string[]) => Promise<{ code: number; stdout: Buffer; stderr: Buffer } | undefined>

export const systemExec: ExecBuffer = (file, args) => new Promise(resolve => {
  execFile(file, [...args], { windowsHide: true, timeout: 30_000, encoding: 'buffer' }, (error, stdout, stderr) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve(undefined)
    resolve({ code: typeof error?.code === 'number' ? error.code : error === null ? 0 : 1, stdout, stderr })
  })
})

export interface WindowsAutostartOptions {
  /** Program and arguments, the last one being `--auto-start`. Undefined: not available. */
  readonly command?: readonly string[] | undefined
  readonly taskName?: string
  readonly user?: string
  readonly exec?: ExecBuffer
  readonly platform?: NodeJS.Platform
  /** Whether a file is there (the registered program). */
  readonly exists?: (file: string) => boolean
}

export function windowsAutostart(options: WindowsAutostartOptions): AutostartPort {
  const taskName = options.taskName ?? 'MultiGameAssistant'
  const exec = options.exec ?? systemExec
  const exists = options.exists ?? existsSync
  const command = options.command
  const user = options.user ?? `${process.env['USERDOMAIN'] ?? ''}\\${process.env['USERNAME'] ?? ''}`.replace(/^\\/, '')
  const platform = options.platform ?? process.platform
  return {
    available: () => platform === 'win32' && command !== undefined && command.length > 0,
    async status() {
      if (platform !== 'win32') return { registered: false, detail: '开机自启目前只支持 Windows' }
      const result = await exec('schtasks.exe', ['/Query', '/TN', taskName, '/XML'])
      if (result === undefined || result.code !== 0) return { registered: false }
      const xml = decode(result.stdout)
      const program = unescape(/<Command>([^<]*)<\/Command>/.exec(xml)?.[1] ?? '')
      const args = unescape(/<Arguments>([^<]*)<\/Arguments>/.exec(xml)?.[1] ?? '')
      if (command !== undefined && (program.toLowerCase() !== command[0]!.toLowerCase() || args !== joinArgs(command.slice(1)))) {
        // A program that is gone (folder moved or renamed, dependencies reinstalled), or this same app
        // started another way: the task is out of date. Otherwise it starts another copy of the app.
        const stale = !exists(program) || args === joinArgs(command.slice(1))
        return { registered: true, stale, detail: `已注册的启动命令和当前程序位置不一致（${program}），关掉再打开一次开机自启即可更新` }
      }
      return { registered: true }
    },
    async register() {
      if (platform !== 'win32' || command === undefined || command.length === 0) throw new Error('只有桌面版能设置开机自启')
      const dir = await mkdtemp(join(tmpdir(), 'adg-task-'))
      try {
        const file = join(dir, 'task.xml')
        // schtasks reads UTF-16 task files reliably.
        await writeFile(file, Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from(taskXml(command, user), 'utf16le')]))
        const result = await exec('schtasks.exe', ['/Create', '/TN', taskName, '/XML', file, '/F'])
        if (result === undefined) throw new Error('找不到 schtasks.exe')
        if (result.code !== 0) throw new Error(`注册开机自启失败：${(decode(result.stderr) || decode(result.stdout)).trim()}`)
      } finally {
        await rm(dir, { recursive: true, force: true }).catch(() => {})
      }
    },
    async unregister() {
      if (platform !== 'win32') return
      const result = await exec('schtasks.exe', ['/Delete', '/TN', taskName, '/F'])
      if (result !== undefined && result.code !== 0 && (await this.status()).registered) {
        throw new Error(`取消开机自启失败：${(decode(result.stderr) || decode(result.stdout)).trim()}`)
      }
    },
  }
}

/** The task definition: at this user's logon, no time limit, battery is fine, catch up when missed. */
export function taskXml(command: readonly string[], user: string): string {
  return `<?xml version="1.0" encoding="UTF-16"?>
<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">
  <RegistrationInfo>
    <Description>MultiGameAssistant：登录 Windows 后启动，并按设置自动运行流水线</Description>
  </RegistrationInfo>
  <Triggers>
    <LogonTrigger>
      <Enabled>true</Enabled>
      <UserId>${escape(user)}</UserId>
      <Delay>PT15S</Delay>
    </LogonTrigger>
  </Triggers>
  <Principals>
    <Principal id="Author">
      <UserId>${escape(user)}</UserId>
      <LogonType>InteractiveToken</LogonType>
      <RunLevel>LeastPrivilege</RunLevel>
    </Principal>
  </Principals>
  <Settings>
    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>
    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>
    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>
    <StartWhenAvailable>true</StartWhenAvailable>
    <ExecutionTimeLimit>PT0S</ExecutionTimeLimit>
    <AllowStartOnDemand>true</AllowStartOnDemand>
    <Enabled>true</Enabled>
  </Settings>
  <Actions Context="Author">
    <Exec>
      <Command>${escape(command[0]!)}</Command>
      <Arguments>${escape(joinArgs(command.slice(1)))}</Arguments>
      <WorkingDirectory>${escape(dirname(command[0]!))}</WorkingDirectory>
    </Exec>
  </Actions>
</Task>
`
}

export function joinArgs(args: readonly string[]): string {
  return args.map(a => (/[\s"]/.test(a) ? `"${a.replace(/"/g, '\\"')}"` : a)).join(' ')
}

export function escape(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;')
}

export function unescape(text: string): string {
  return text.replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&')
}

/** schtasks prints UTF-16 for /XML on some systems and the console code page otherwise. */
export function decode(bytes: Buffer): string {
  if (bytes.length >= 2 && bytes[0] === 0xff && bytes[1] === 0xfe) return bytes.subarray(2).toString('utf16le')
  if (bytes.length >= 4 && bytes[1] === 0 && bytes[3] === 0) return bytes.toString('utf16le')
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return new TextDecoder('gb18030').decode(bytes)
  }
}
