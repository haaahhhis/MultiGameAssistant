/**
 * Stopping a script for good on Windows. `taskkill /T` only follows the
 * parent links of processes that are still alive: a launcher or a `.bat`
 * that already exited leaves its children out of reach, and the script keeps
 * running. Windows keeps every process's parent id after the parent is gone,
 * so the whole process table is read and everything started under the
 * script's process since the run began is ended — except the game and the
 * emulator it uses (closing those is their own action) and adb's shared
 * server.
 */
import { execFile } from 'node:child_process'

export interface ProcessRow {
  readonly pid: number
  readonly parent: number
  /** Unix ms. */
  readonly created: number
  readonly name: string
}

/** Processes that a stop leaves alone: the emulator, adb's shared server. Games are added per script. */
const KEEP = /^(mumu[\w-]*|nemuheadless|nemuplayer|adb)\.exe$/i

const TABLE_SCRIPT = `
$ProgressPreference = 'SilentlyContinue'
Get-CimInstance Win32_Process | ForEach-Object {
  $created = if ($_.CreationDate) { [DateTimeOffset]::new($_.CreationDate).ToUnixTimeMilliseconds() } else { 0 }
  '{0}\t{1}\t{2}\t{3}' -f $_.ProcessId, $_.ParentProcessId, $created, $_.Name
}
`

/** Every process with its parent and start time. @returns empty when it cannot be read. */
export function processTable(): Promise<ProcessRow[]> {
  return new Promise(resolve => {
    execFile('powershell.exe', ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', Buffer.from(TABLE_SCRIPT, 'utf16le').toString('base64')],
      { windowsHide: true, timeout: 20_000, maxBuffer: 8 * 1024 * 1024 }, (error, stdout) => {
        if (error !== null && stdout === '') return resolve([])
        resolve(parseTable(String(stdout)))
      })
  })
}

export function parseTable(text: string): ProcessRow[] {
  return text.split(/\r?\n/).flatMap(line => {
    const [pid, parent, created, ...name] = line.split('\t')
    const row = { pid: Number(pid), parent: Number(parent), created: Number(created), name: name.join('\t').trim() }
    return Number.isInteger(row.pid) && row.pid > 0 && Number.isInteger(row.parent) ? [row] : []
  })
}

/**
 * Everything started under `root` (itself included when alive): children are
 * followed through their parent id even when the parent has exited, and a
 * child must have started after its parent (or after `since` when the parent
 * is gone), so a reused process id does not pull in strangers.
 */
export function descendants(rows: readonly ProcessRow[], root: number, since: number): ProcessRow[] {
  const byParent = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    if (row.pid === row.parent) continue
    const list = byParent.get(row.parent) ?? []
    list.push(row)
    byParent.set(row.parent, list)
  }
  const out: ProcessRow[] = []
  const seen = new Set<number>()
  const rootRow = rows.find(r => r.pid === root && r.created >= since - 60_000)
  if (rootRow !== undefined) { out.push(rootRow); seen.add(root) }
  const walk = (pid: number, after: number) => {
    for (const child of byParent.get(pid) ?? []) {
      if (seen.has(child.pid) || (child.created !== 0 && child.created + 1000 < after)) continue
      seen.add(child.pid)
      out.push(child)
      walk(child.pid, child.created || after)
    }
  }
  walk(root, rootRow?.created ?? since)
  return out
}

export interface SweepResult {
  /** Processes ended. */
  readonly ended: readonly string[]
  /** Processes that would not end, with why. */
  readonly failed: readonly string[]
  /** Left running on purpose (the game, the emulator). */
  readonly kept: readonly string[]
}

/**
 * End the process tree under `root` and what it left behind.
 * @param keepNames - more executable names to leave running (the script's game).
 */
export async function sweepTree(root: number, since: number, keepNames: readonly string[] = [], table: () => Promise<ProcessRow[]> = processTable): Promise<SweepResult> {
  const keep = new Set(keepNames.map(n => n.toLowerCase()))
  const found = descendants(await table(), root, since)
  const kept = found.filter(r => KEEP.test(r.name) || keep.has(r.name.toLowerCase()))
  const targets = found.filter(r => !kept.includes(r))
  const ended: string[] = []
  const failed: string[] = []
  // Leaves first, so a parent does not start a replacement while its children go.
  for (const row of [...targets].reverse()) {
    const why = await taskkill(row.pid)
    if (why === undefined) ended.push(`${row.name}（${row.pid}）`)
    else if (!/not found|没有找到|找不到/i.test(why)) failed.push(`${row.name}（${row.pid}）：${why}`)
  }
  return { ended, failed, kept: kept.map(r => `${r.name}（${r.pid}）`) }
}

/** @returns undefined when it ended (or was already gone), else what taskkill said. */
function taskkill(pid: number): Promise<string | undefined> {
  return new Promise(resolve => {
    execFile('taskkill', ['/PID', String(pid), '/F'], { windowsHide: true, timeout: 15_000, encoding: 'buffer' }, (error, _stdout, stderr) => {
      if (error === null) return resolve(undefined)
      const text = decodeConsole(stderr).trim()
      resolve(/access is denied|拒绝访问/i.test(text) ? '没有权限（它可能是以管理员身份运行的：用管理员身份启动本软件，或者自己关掉它）' : text || String(error.message))
    })
  })
}

function decodeConsole(bytes: Buffer): string {
  try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return new TextDecoder('gb18030').decode(bytes) }
}
