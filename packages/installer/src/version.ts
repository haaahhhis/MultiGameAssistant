/**
 * Which version a script folder holds, for folders the user imported (the
 * installer knows the version of what it installed itself). Tried in order:
 * what the Script Pack says (`install.version`), a MaaFramework project's
 * `interface.json`, a version file, and the program's own version
 * information (Windows file properties).
 */
import { readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { EnvHost } from './env.ts'

/** Where a pack says its version is written: a file (its `json` key path, or the first `pattern` group), or a program's file version. */
export type VersionSpec =
  | { readonly file: string; readonly json?: readonly string[] | undefined; readonly pattern?: string | undefined }
  | { readonly exe: string }

export interface DetectedVersion {
  /** Without a leading `v`; a fourth `.0` dropped (`6.20.1.0` → `6.20.1`). */
  readonly version: string
  /** Where it was read, for the UI ("interface.json", "MAA.exe 的文件属性"…). */
  readonly from: string
}

const VERSION = /v?(\d+(?:\.\d+){1,3}(?:[-+][0-9A-Za-z.-]+)?)/
const FILES = ['version.txt', 'VERSION', 'version', 'assets/config/version.txt', 'version.json']

/** `v6.20.1` → `6.20.1`; `6.20.1.0` → `6.20.1`; text without a version → undefined. */
export function cleanVersion(text: string): string | undefined {
  const found = VERSION.exec(text.trim())?.[1]
  if (found === undefined) return undefined
  const parts = found.split('.')
  return parts.length === 4 && /^0(\D|$)/.test(parts[3]!) && !/[-+]/.test(parts[3]!) ? parts.slice(0, 3).join('.') : found
}

export async function detectVersion(dir: string, options: { spec?: VersionSpec | undefined; executables?: readonly string[]; host?: Pick<EnvHost, 'exec'> } = {}): Promise<DetectedVersion | undefined> {
  const spec = options.spec
  if (spec !== undefined) {
    const found = 'exe' in spec ? await exeVersion(dir, spec.exe, options.host) : await fileVersion(dir, spec.file, spec.json, spec.pattern)
    if (found !== undefined) return found
  }
  for (const file of ['interface.json', 'assets/interface.json']) {
    const found = await fileVersion(dir, file, ['version'])
    if (found !== undefined) return found
  }
  for (const file of FILES) {
    const found = await fileVersion(dir, file, file.endsWith('.json') ? ['version'] : undefined)
    if (found !== undefined) return found
  }
  for (const exe of (options.executables ?? []).filter(e => /\.exe$/i.test(e)).slice(0, 3)) {
    const found = await exeVersion(dir, exe, options.host)
    if (found !== undefined) return found
  }
  return undefined
}

async function fileVersion(dir: string, file: string, json?: readonly string[], pattern?: string): Promise<DetectedVersion | undefined> {
  let text: string
  try {
    const path = join(dir, ...file.split('/'))
    if ((await stat(path)).size > 1_000_000) return undefined
    text = (await readFile(path, 'utf8')).replace(/^\uFEFF/, '')
  } catch { return undefined }
  let value: unknown = text
  if (json !== undefined) {
    try {
      value = JSON.parse(text)
      for (const key of json) value = (value as Record<string, unknown> | undefined)?.[key]
    } catch { return undefined }
    if (typeof value !== 'string' && typeof value !== 'number') return undefined
  }
  const raw = String(value)
  const picked = pattern === undefined ? raw : new RegExp(pattern).exec(raw)?.[1]
  const version = picked === undefined ? undefined : cleanVersion(picked)
  return version === undefined ? undefined : { version, from: file }
}

/** The program's product version (else file version) from its Windows file properties. */
async function exeVersion(dir: string, exe: string, host?: Pick<EnvHost, 'exec'>): Promise<DetectedVersion | undefined> {
  if (host === undefined || process.platform !== 'win32') return undefined
  const path = join(dir, ...exe.split('/'))
  if (!(await stat(path).then(s => s.isFile(), () => false))) return undefined
  const quoted = path.replace(/'/g, "''")
  const result = await host.exec('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', `$v = (Get-Item -LiteralPath '${quoted}').VersionInfo; $v.ProductVersion; $v.FileVersion`], { timeoutMs: 10_000 })
  if (result === undefined || result.code !== 0) return undefined
  for (const line of result.stdout.split(/\r?\n/)) {
    const version = cleanVersion(line)
    if (version !== undefined) return { version, from: `${exe} 的文件属性` }
  }
  return undefined
}
