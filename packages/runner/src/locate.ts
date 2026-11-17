/**
 * Find a PC game's program, for 「自动查找」 and the agent's `game_locate`:
 *
 *   1. the game is running: the path of its process;
 *   2. where Windows has noted the program by name: programs run before
 *      (MuiCache, the Program Compatibility Assistant's list), App Paths,
 *      and the Windows Search index (what the Start menu's search finds);
 *   3. the registry's uninstall entries whose name matches (their icon is
 *      often the game itself; otherwise their install folder is searched),
 *      and the folders the game launchers note games in (HoYoPlay's
 *      GameInstallPath, …);
 *   4. Start-menu and desktop shortcuts whose name matches (often the
 *      game's launcher: the folders beside and above it are searched);
 *   5. the usual game folders on every drive (Program Files, Games, the
 *      launchers' folders), into folders whose name matches.
 *
 * Only files named like the game's process count, so a launcher is never
 * taken for the game. The disk walk is bounded (folders and time).
 */
import { execFile } from 'node:child_process'
import { existsSync } from 'node:fs'
import { readdir } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'

export interface GameCandidate {
  readonly path: string
  /** Where it was found, in words. */
  readonly source: string
}

/** What the Windows probe reports. */
export interface GameProbe {
  readonly running: readonly string[]
  readonly entries: readonly { readonly name: string; readonly location?: string; readonly icon?: string }[]
  readonly shortcuts: readonly { readonly name: string; readonly target: string }[]
  /** Paths of programs with the game's file name that Windows has noted: run before, App Paths, the search index. */
  readonly known?: readonly { readonly path: string; readonly source: string }[]
  /** Folders game launchers say they installed a game in. */
  readonly installs?: readonly string[]
}

export interface LocateOptions {
  /** The game's program, e.g. `Endfield.exe`. */
  readonly exe: string
  /** Names to look for in the registry, shortcuts and folder names. */
  readonly keywords: readonly string[]
  readonly signal?: AbortSignal
  /** Tests: instead of PowerShell. */
  readonly probe?: (exe: string) => Promise<GameProbe>
  /** Tests: instead of every drive. */
  readonly roots?: readonly string[]
  /** @default 40000 */
  readonly maxFolders?: number
  /** @default 20000 */
  readonly maxMs?: number
}

/** Folders games and their launchers live in; searched even when their name does not match. */
const CONTAINERS = new Set([
  'program files', 'program files (x86)', 'games', 'game', 'steam', 'steamlibrary', 'steamapps', 'common', 'epic games',
  'mihoyo launcher', 'hoyoplay', 'mihoyo', 'hypergryph launcher', 'hypergryph', 'wegameapps', 'netease', '网易', '腾讯游戏', '游戏',
])
const SKIP = new Set(['windows', '$recycle.bin', 'system volume information', 'node_modules', '.git', 'appdata', 'windowsapps', 'winsxs', 'recovery', 'perflogs'])

/** Keywords from the pack: its own, the process name, and the game's name and its parts (「崩坏：星穹铁道」 → 星穹铁道). */
export function gameKeywords(game: { name?: string | undefined; pc?: { process?: string | undefined; keywords?: readonly string[] | undefined } | undefined }): string[] {
  const out = new Set<string>(game.pc?.keywords ?? [])
  const stem = game.pc?.process?.replace(/\.exe$/i, '')
  if (stem !== undefined && stem.length >= 3) out.add(stem)
  if (game.name !== undefined) {
    out.add(game.name)
    for (const part of game.name.split(/[：:·\s-]+/)) if (part.length >= 3) out.add(part)
  }
  return [...out]
}

export async function locateGame(options: LocateOptions): Promise<GameCandidate[]> {
  const exe = options.exe.toLowerCase().endsWith('.exe') ? options.exe : `${options.exe}.exe`
  const want = exe.toLowerCase()
  const keywords = options.keywords.map(k => k.toLowerCase()).filter(k => k !== '')
  const matches = (text: string) => { const t = text.toLowerCase(); return keywords.some(k => t.includes(k)) }
  const found = new Map<string, GameCandidate>()
  const add = (path: string, source: string) => {
    const key = path.toLowerCase()
    if (!found.has(key) && existsSync(path)) found.set(key, { path, source })
  }

  const probe = await (options.probe ?? windowsProbe)(exe).catch((): GameProbe => ({ running: [], entries: [], shortcuts: [] }))
  for (const path of probe.running) if (basename(path).toLowerCase() === want) add(path, '游戏正在运行')
  for (const { path, source } of probe.known ?? []) if (basename(path).toLowerCase() === want) add(path, source)

  const seeds: { dir: string; source: string }[] = []
  for (const dir of probe.installs ?? []) if (dir.trim() !== '' && matches(dir)) seeds.push({ dir: dir.trim(), source: '游戏启动器记下的安装目录' })
  for (const entry of probe.entries) {
    if (!matches(entry.name)) continue
    const icon = entry.icon === undefined ? '' : entry.icon.replace(/^"|"?,\s*-?\d+$|"$/g, '').trim()
    if (icon !== '' && basename(icon).toLowerCase() === want) add(icon, `已安装程序：${entry.name}`)
    for (const dir of [entry.location ?? '', icon === '' ? '' : dirname(icon)]) if (dir.trim() !== '') seeds.push({ dir: dir.trim().replace(/^"|"$/g, ''), source: `已安装程序「${entry.name}」的目录` })
  }
  for (const link of probe.shortcuts) {
    if (link.target === '' || !(matches(link.name) || matches(link.target))) continue
    if (basename(link.target).toLowerCase() === want) add(link.target, `快捷方式「${link.name}」`)
    else {
      // A launcher's: the game is often beside it, not under it (HoYoPlay\launcher\…, HoYoPlay\games\…).
      seeds.push({ dir: dirname(link.target), source: `快捷方式「${link.name}」所在的目录` })
      // The folder above only when it is named for the game or its launcher (not a whole drive or Program Files).
      const above = dirname(dirname(link.target))
      if (above !== dirname(above) && matches(basename(above))) seeds.push({ dir: above, source: `快捷方式「${link.name}」的上一级目录` })
    }
  }

  // The disk: the seeds first (any folder under them), then the usual places on every drive.
  const budget = { folders: options.maxFolders ?? 40_000, until: Date.now() + (options.maxMs ?? 20_000) }
  const walk = async (dir: string, depth: number, matched: boolean, source: string): Promise<void> => {
    if (budget.folders-- <= 0 || Date.now() > budget.until || options.signal?.aborted === true) return
    let entries
    try { entries = await readdir(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) if (entry.isFile() && entry.name.toLowerCase() === want) add(join(dir, entry.name), source)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const name = entry.name.toLowerCase()
      if (SKIP.has(name)) continue
      const hit = matches(entry.name)
      const go = matched ? depth < 5 : hit ? true : CONTAINERS.has(name) && depth < 3
      if (go) await walk(join(dir, entry.name), depth + 1, matched || hit, source)
    }
  }
  const seen = new Set<string>()
  for (const seed of seeds) {
    if (seen.has(seed.dir.toLowerCase())) continue
    seen.add(seed.dir.toLowerCase())
    await walk(seed.dir, 1, true, seed.source)
  }
  if (found.size === 0) for (const root of options.roots ?? drives()) await walk(root, 0, false, '在磁盘上找到')
  return [...found.values()]
}

function drives(): string[] {
  if (process.platform !== 'win32') return []
  return 'CDEFGHIJKLMNOPQRSTUVWXYZ'.split('').map(l => `${l}:\\`).filter(d => existsSync(d))
}

const PROBE = `
$ErrorActionPreference = 'SilentlyContinue'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
$exe = $env:ADG_GAME_EXE
$stem = [IO.Path]::GetFileNameWithoutExtension($exe)
$running = @(Get-Process -Name $stem | ForEach-Object { $_.Path } | Where-Object { $_ })
$keys = 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'
$entries = @(Get-ItemProperty $keys | Where-Object { $_.DisplayName } | ForEach-Object { @{ name = [string]$_.DisplayName; location = [string]$_.InstallLocation; icon = [string]$_.DisplayIcon } })
$shell = New-Object -ComObject WScript.Shell
$dirs = @([Environment]::GetFolderPath('CommonStartMenu'), [Environment]::GetFolderPath('StartMenu'), [Environment]::GetFolderPath('Desktop'), [Environment]::GetFolderPath('CommonDesktopDirectory'))
$shortcuts = @(foreach ($d in $dirs) { if ($d) { Get-ChildItem -LiteralPath $d -Filter *.lnk -Recurse | ForEach-Object { @{ name = $_.BaseName; target = [string]$shell.CreateShortcut($_.FullName).TargetPath } } } })
# Where Windows noted a program with this file name: run before, App Paths, the search index.
$known = New-Object System.Collections.ArrayList
$tail = '\\' + $exe
foreach ($k in 'HKCU:\\Software\\Classes\\Local Settings\\Software\\Microsoft\\Windows\\Shell\\MuiCache', 'HKCU:\\Software\\Microsoft\\Windows NT\\CurrentVersion\\AppCompatFlags\\Compatibility Assistant\\Store') {
  $item = Get-Item -LiteralPath $k
  if ($item) { foreach ($n in $item.GetValueNames()) { $i = $n.IndexOf($tail, [StringComparison]::OrdinalIgnoreCase); if ($i -ge 0) { [void]$known.Add(@{ path = $n.Substring(0, $i + $tail.Length); source = '以前运行过' }) } } }
}
foreach ($k in 'HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\', 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\App Paths\\') {
  $v = (Get-ItemProperty -LiteralPath ($k + $exe)).'(default)'
  if ($v) { [void]$known.Add(@{ path = ([string]$v).Trim('"'); source = 'App Paths' }) }
}
try {
  $db = New-Object -ComObject ADODB.Connection
  $db.Open("Provider=Search.CollatorDSO;Extended Properties='Application=Windows';")
  $rs = $db.Execute("SELECT System.ItemPathDisplay FROM SYSTEMINDEX WHERE System.FileName = '" + $exe.Replace("'", "''") + "'")
  while (-not $rs.EOF) { [void]$known.Add(@{ path = [string]$rs.Fields.Item(0).Value; source = 'Windows 搜索' }); $rs.MoveNext() }
  $db.Close()
} catch {}
# Folders game launchers note games in (HoYoPlay: GameInstallPath per game).
$installs = New-Object System.Collections.ArrayList
foreach ($root in 'HKCU:\\Software\\Cognosphere', 'HKCU:\\Software\\miHoYo', 'HKCU:\\Software\\HYP', 'HKCU:\\Software\\Hypergryph', 'HKCU:\\Software\\HYPERGRYPH', 'HKCU:\\Software\\Kuro Games', 'HKCU:\\Software\\KuroGame') {
  if (Test-Path -LiteralPath $root) {
    foreach ($key in @(Get-Item -LiteralPath $root) + @(Get-ChildItem -LiteralPath $root -Recurse)) {
      foreach ($n in $key.GetValueNames()) {
        if ($n -match 'Install|Path|Dir') { $v = $key.GetValue($n); if ($v -is [string] -and $v -match '^[A-Za-z]:[\\\\/]') { [void]$installs.Add($v) } }
      }
    }
  }
}
@{ running = $running; entries = $entries; shortcuts = $shortcuts; known = @($known); installs = @($installs) } | ConvertTo-Json -Depth 4 -Compress
`

function windowsProbe(exe: string): Promise<GameProbe> {
  if (process.platform !== 'win32') return Promise.resolve({ running: [], entries: [], shortcuts: [] })
  return new Promise((resolve, reject) => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', PROBE], {
      windowsHide: true, timeout: 30_000, maxBuffer: 32 * 1024 * 1024, env: { ...process.env, ADG_GAME_EXE: exe },
    }, (error, stdout) => {
      if (error !== null && String(stdout).trim() === '') return reject(error)
      try {
        const raw = JSON.parse(String(stdout).trim()) as { running?: unknown; entries?: unknown; shortcuts?: unknown; known?: unknown; installs?: unknown }
        const list = <T>(v: unknown): T[] => (Array.isArray(v) ? v : v === null || v === undefined ? [] : [v]) as T[]
        resolve({ running: list<string>(raw.running), entries: list(raw.entries), shortcuts: list(raw.shortcuts), known: list(raw.known), installs: list<string>(raw.installs) })
      } catch (e) {
        reject(e)
      }
    })
  })
}
