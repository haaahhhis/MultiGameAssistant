/**
 * Find MuMu's manager program: from the Windows uninstall registry (what an
 * installer records) and from the usual install locations. Read-only.
 */
import { stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { Exec } from './mumu.ts'

export interface Found {
  readonly manager: string
  readonly name: string
  readonly version?: string
}

/** DisplayName substrings of MuMu installs (bare "MuMu" would also match plugins). */
const NAMES = /(mumu player|mumuplayer|netease mumu|mumu模拟器|mumu 模拟器)/i
const MANAGER = 'MuMuManager.exe'
const SUBDIRS = ['shell', 'nx_main', '']

/** Read the uninstall entries of all three hives in one PowerShell call. */
const QUERY = [
  "$roots = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'",
  'Get-ItemProperty $roots -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName } |',
  'Select-Object DisplayName, DisplayVersion, InstallLocation, DisplayIcon, UninstallString | ConvertTo-Json -Compress',
].join(' ')

interface UninstallEntry {
  DisplayName?: string
  DisplayVersion?: string
  InstallLocation?: string
  DisplayIcon?: string
  UninstallString?: string
}

export async function findMuMu(exec: Exec, extraRoots: readonly string[] = defaultRoots()): Promise<Found[]> {
  const found = new Map<string, Found>()
  const result = await exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', QUERY], { timeoutMs: 30_000 })
  if (result?.code === 0 && result.stdout.trim() !== '') {
    let parsed: unknown
    try { parsed = JSON.parse(result.stdout) } catch { parsed = [] }
    const list = (Array.isArray(parsed) ? parsed : [parsed]) as UninstallEntry[]
    for (const entry of list) {
      if (entry.DisplayName === undefined || !NAMES.test(entry.DisplayName)) continue
      for (const root of rootsOf(entry)) {
        const manager = await managerUnder(root)
        if (manager !== undefined && !found.has(manager.toLowerCase())) {
          found.set(manager.toLowerCase(), { manager, name: entry.DisplayName, ...(entry.DisplayVersion === undefined ? {} : { version: entry.DisplayVersion }) })
        }
      }
    }
  }
  for (const root of extraRoots) {
    const manager = await managerUnder(root)
    if (manager !== undefined && !found.has(manager.toLowerCase())) found.set(manager.toLowerCase(), { manager, name: 'MuMu 模拟器' })
  }
  return [...found.values()]
}

/** Install directories an uninstall entry points at. */
function rootsOf(entry: UninstallEntry): string[] {
  const roots: string[] = []
  if (entry.InstallLocation !== undefined && entry.InstallLocation.trim() !== '') roots.push(entry.InstallLocation.trim())
  for (const value of [entry.DisplayIcon, entry.UninstallString]) {
    const path = /^"?([^",]+\.exe)/i.exec(value ?? '')?.[1]
    if (path !== undefined) roots.push(dirname(path), dirname(dirname(path)))
  }
  return roots
}

async function managerUnder(root: string): Promise<string | undefined> {
  for (const sub of SUBDIRS) {
    const candidate = join(root, sub, MANAGER)
    if (await stat(candidate).then(s => s.isFile(), () => false)) return candidate
  }
  return undefined
}

function defaultRoots(): string[] {
  const programFiles = [process.env['ProgramFiles'] ?? 'C:\\Program Files', 'D:\\Program Files', 'E:\\Program Files']
  return programFiles.flatMap(base => [join(base, 'Netease', 'MuMu Player 12'), join(base, 'Netease', 'MuMuPlayer-12.0'), join(base, 'Netease', 'MuMuPlayer'), join(base, 'Netease', 'MuMu')])
}
