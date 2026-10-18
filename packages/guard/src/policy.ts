/**
 * Decide whether an agent tool call would change a protected script directory.
 *
 * File tools are checked exactly (their `file_path`). Shell commands are
 * checked heuristically: a command that names a protected path (or runs in
 * one) and contains a writing verb is refused. The heuristic errs toward
 * refusing; reading, listing and running scripts stay allowed, and config
 * edits go through the runner's `script_config_set`, which writes only the
 * files a pack declares.
 */
import { isAbsolute, relative, resolve } from 'node:path'

export interface ProtectedDir {
  readonly scriptId: string
  readonly dir: string
}

export interface CallFacts {
  readonly toolName: string
  readonly args: unknown
  /** The session's working directory, for relative paths. */
  readonly cwd?: string | undefined
}

export interface Verdict {
  readonly blocked: true
  readonly scriptId: string
  readonly target: string
}

const FILE_TOOLS = new Set(['write', 'edit', 'str_replace_based_edit_tool', 'apply_patch', 'notebook_edit'])
const SHELL_TOOLS = new Set(['pwsh', 'bash', 'powershell', 'shell', 'cmd'])

/** Verbs that change files, in PowerShell, cmd and POSIX shells. */
const WRITING = /(\bset-content\b|\badd-content\b|\bout-file\b|\bnew-item\b|\bremove-item\b|\bmove-item\b|\bcopy-item\b|\brename-item\b|\bclear-content\b|\bexpand-archive\b|\bcompress-archive\b|\bdel\b|\berase\b|\brd\b|\brmdir\b|\bren\b|\bmove\b|\bcopy\b|\bxcopy\b|\brobocopy\b|\brm\b|\bmv\b|\bcp\b|\btouch\b|\btee\b|\bsed\s+-i\b|\btruncate\b|\bgit\s+(apply|checkout|reset|restore|clean|stash|am|merge|pull)\b|\[io\.file\]::write|\bwritealltext\b|\bwriteallbytes\b|>{1,2})/i

/**
 * @param protectedDirs - directories the agent may not change; a more specific entry should come first.
 * @param allowedDirs - directories the user opened (a grant); they win over any protected parent.
 */
export function judgeCall(call: CallFacts, protectedDirs: readonly ProtectedDir[], allowedDirs: readonly string[] = []): Verdict | undefined {
  const args = (call.args ?? {}) as Record<string, unknown>
  const allowed = allowedDirs.map(dir => ({ scriptId: '', dir }))
  if (FILE_TOOLS.has(call.toolName)) {
    const path = [args['file_path'], args['path']].find((v): v is string => typeof v === 'string')
    if (path === undefined) return undefined
    const absolute = resolvePath(path, call.cwd)
    if (owner(absolute, allowed) !== undefined) return undefined
    const hit = owner(absolute, protectedDirs)
    return hit === undefined ? undefined : { blocked: true, scriptId: hit.scriptId, target: path }
  }
  if (SHELL_TOOLS.has(call.toolName)) {
    const command = typeof args['command'] === 'string' ? args['command'] : ''
    if (!WRITING.test(stripReadonlyRedirects(command))) return undefined
    const workdir = typeof args['workdir'] === 'string' ? resolvePath(args['workdir'], call.cwd) : undefined
    if (workdir !== undefined && owner(workdir, allowed) === undefined) {
      const inWorkdir = owner(workdir, protectedDirs)
      if (inWorkdir !== undefined) return { blocked: true, scriptId: inWorkdir.scriptId, target: workdir }
    }
    // Paths inside an opened directory are taken out before looking for protected ones.
    let text = normalize(command)
    for (const dir of allowedDirs) text = text.split(normalize(dir)).join('')
    for (const entry of protectedDirs) {
      if (text.includes(normalize(entry.dir))) return { blocked: true, scriptId: entry.scriptId, target: entry.dir }
    }
  }
  return undefined
}

/** `2>&1`, `> $null`, `>nul` and `2>/dev/null` redirect output, not files. */
function stripReadonlyRedirects(command: string): string {
  return command.replace(/\d?>&\d/g, '').replace(/\d?>\s*(\$null|nul|\/dev\/null)\b/gi, '')
}

function owner(path: string, dirs: readonly ProtectedDir[]): ProtectedDir | undefined {
  return dirs.find(entry => {
    const rel = relative(resolve(entry.dir), path)
    return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
  })
}

function resolvePath(path: string, cwd: string | undefined): string {
  return cwd === undefined ? resolve(path) : resolve(cwd, path)
}

/** Case-insensitive, separator-insensitive form for substring checks. */
function normalize(text: string): string {
  return text.replace(/\\/g, '/').replace(/\/+/g, '/').replace(/\/$/, '').toLowerCase()
}

/** Message the agent receives, telling it what to do instead. */
export function denialReason(verdict: Verdict, scriptName: string): string {
  return [
    `已拦截：${scriptName} 的脚本目录受保护（${verdict.target}）。`,
    '没有用户的明确授权时，不能修改脚本自己的文件。',
    '要改设置，用 script_config_set 修改脚本包允许的配置文件；要更新脚本，用 script_update。',
    '如果确实需要修改代码，请告诉用户原因，由用户在「脚本」页给这个脚本开启临时修改授权。',
  ].join('')
}
