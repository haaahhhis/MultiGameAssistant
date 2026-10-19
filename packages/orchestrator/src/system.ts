/**
 * What this computer can carry, for deciding how many games run at once
 * (`system_info`): CPU, memory, graphics cards, screens, free disk, and how
 * busy it is now. Read by this plugin itself, so it works when the agent's
 * sandboxed shell cannot start (PowerShell 7 under the restricted token).
 */
import { execFile } from 'node:child_process'
import { cpus, freemem, loadavg, totalmem, release, version } from 'node:os'

export interface SystemInfo {
  readonly os: string
  readonly cpu: { readonly name: string; readonly cores?: number; readonly threads: number; readonly loadPercent?: number }
  readonly memory: { readonly totalGB: number; readonly freeGB: number }
  readonly gpus: readonly { readonly name: string; readonly memoryGB?: number }[]
  readonly screens: readonly { readonly width: number; readonly height: number }[]
  readonly systemDiskFreeGB?: number
  /** Rough guidance from the numbers above; the agent explains it to the user. */
  readonly advice: string
}

const GB = 1024 ** 3
const round = (n: number) => Math.round(n * 10) / 10

const PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$cpu = Get-CimInstance Win32_Processor | Select-Object -First 1
$load = (Get-CimInstance Win32_Processor | Measure-Object -Property LoadPercentage -Average).Average
$gpus = @(Get-CimInstance Win32_VideoController | ForEach-Object {
  $mem = $null
  $key = Get-ChildItem 'HKLM:\\SYSTEM\\ControlSet001\\Control\\Class\\{4d36e968-e325-11ce-bfc1-08002be10318}' | Where-Object { (Get-ItemProperty $_.PSPath).DriverDesc -eq $_.Name } | Select-Object -First 1
  if ($key) { $mem = (Get-ItemProperty $key.PSPath).'HardwareInformation.qwMemorySize' }
  if (-not $mem -and $_.AdapterRAM -gt 0) { $mem = [uint64]$_.AdapterRAM }
  @{ name = [string]$_.Name; memory = $mem }
})
Add-Type -AssemblyName System.Windows.Forms
$screens = @([System.Windows.Forms.Screen]::AllScreens | ForEach-Object { @{ width = $_.Bounds.Width; height = $_.Bounds.Height } })
$disk = Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='$env:SystemDrive'"
@{ cpu = [string]$cpu.Name; cores = $cpu.NumberOfCores; threads = $cpu.NumberOfLogicalProcessors; load = $load; gpus = $gpus; screens = $screens; diskFree = $disk.FreeSpace } | ConvertTo-Json -Depth 4 -Compress
`

interface Probe { cpu?: string; cores?: number; threads?: number; load?: number; gpus?: { name?: string; memory?: number }[] | { name?: string; memory?: number }; screens?: { width: number; height: number }[] | { width: number; height: number }; diskFree?: number }

function windowsProbe(): Promise<Probe> {
  if (process.platform !== 'win32') return Promise.resolve({})
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROBE], { windowsHide: true, timeout: 30_000 }, (_error, stdout) => {
      try { resolve(JSON.parse(String(stdout).trim()) as Probe) } catch { resolve({}) }
    })
  })
}

const list = <T>(v: T | T[] | undefined): T[] => (v === undefined || v === null ? [] : Array.isArray(v) ? v : [v])

export async function systemInfo(probe: () => Promise<Probe> = windowsProbe): Promise<SystemInfo> {
  const p = await probe().catch((): Probe => ({}))
  const threads = p.threads ?? cpus().length
  const totalGB = round(totalmem() / GB)
  const gpus = list(p.gpus).filter(g => typeof g.name === 'string' && g.name !== '').map(g => ({
    name: g.name!,
    ...(typeof g.memory === 'number' && g.memory > 0 ? { memoryGB: round(g.memory / GB) } : {}),
  }))
  const load = typeof p.load === 'number' ? Math.round(p.load) : process.platform === 'win32' ? undefined : Math.round(loadavg()[0]! / threads * 100)
  const info = {
    os: `${process.platform === 'win32' ? 'Windows' : process.platform} ${release()} ${version()}`.trim(),
    cpu: { name: p.cpu?.trim() || cpus()[0]?.model.trim() || '未知', ...(p.cores === undefined ? {} : { cores: p.cores }), threads, ...(load === undefined ? {} : { loadPercent: load }) },
    memory: { totalGB, freeGB: round(freemem() / GB) },
    gpus,
    screens: list(p.screens),
    ...(typeof p.diskFree === 'number' ? { systemDiskFreeGB: round(p.diskFree / GB) } : {}),
  }
  return { ...info, advice: advise(info) }
}

/** How many games at once, from memory and the best graphics card (games and emulators are heavy). */
export function advise(info: Pick<SystemInfo, 'memory' | 'gpus' | 'cpu'>): string {
  const vram = Math.max(0, ...info.gpus.map(g => g.memoryGB ?? 0))
  const discrete = info.gpus.some(g => /nvidia|geforce|rtx|gtx|radeon rx|radeon pro|arc a/i.test(g.name))
  const ram = info.memory.totalGB
  if (ram >= 30 && discrete && vram >= 8 && info.cpu.threads >= 12) {
    return `内存 ${ram} GB、独立显卡显存 ${vram} GB：可以同时跑一个模拟器游戏和一个 PC 游戏；两个以上 PC 游戏同时开仍不建议。`
  }
  if (ram >= 16 && discrete && vram >= 6) {
    return `内存 ${ram} GB、独立显卡显存 ${vram} GB：可以试一个模拟器游戏 + 一个 PC 游戏并行，但稳妥起见建议一次只跑一个游戏。`
  }
  return `内存 ${ram} GB${discrete ? `、显卡显存 ${vram || '未知'} GB` : '、没有识别到独立显卡'}：建议一次只跑一个游戏（串行），并在每个游戏跑完后关掉它再跑下一个。`
}
