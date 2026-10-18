/**
 * Runtime requirement checks and fixes for installed scripts.
 *
 * Every check reads the machine through an {@link EnvHost}, so tests run
 * against a fake host. A fix is first described as a {@link FixPlan} (what
 * would run, whether it needs admin); applying it is a separate, explicit
 * step the caller gates behind the user's approval.
 */
import { execFile } from 'node:child_process'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import type { Requirement } from '@adg/pack-schema'
import type { EnvItem, EnvReport } from '@adg/protocol'

export interface ExecResult {
  readonly code: number
  readonly stdout: string
  readonly stderr: string
}

/** What the checks may read from the machine. */
export interface EnvHost {
  /** Run a program; `undefined` when it does not exist. */
  exec(file: string, args: readonly string[], options?: { timeoutMs?: number }): Promise<ExecResult | undefined>
  exists(path: string): Promise<boolean>
  /** Entry names, or `[]` when the directory is missing. */
  listDir(path: string): Promise<string[]>
  env(name: string): string | undefined
}

export const systemHost: EnvHost = {
  exec: (file, args, options = {}) => new Promise(resolve => {
    execFile(file, [...args], { windowsHide: true, timeout: options.timeoutMs ?? 15_000, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = (error as NodeJS.ErrnoException | null)?.code
      if (code === 'ENOENT') resolve(undefined)
      else resolve({ code: typeof error?.code === 'number' ? error.code : error === null ? 0 : 1, stdout, stderr })
    })
  }),
  exists: path => stat(path).then(() => true, () => false),
  listDir: path => readdir(path).catch(() => []),
  env: name => process.env[name],
}

export interface EnvContext {
  readonly host: EnvHost
  /** Shared tools directory (`tools/_shared`): where auto-fixes such as platform-tools go. */
  readonly sharedDir: string
}

/** What fixing one requirement would do. */
export type FixPlan =
  /** Download an archive and unpack it under the shared tools directory; no prompts. */
  | { readonly kind: 'download-extract'; readonly url: string; readonly into: string; readonly description: string }
  /** Download an official installer and run it elevated (the user sees UAC). */
  | { readonly kind: 'run-installer'; readonly url: string; readonly fileName: string; readonly args: readonly string[]; readonly okCodes: readonly number[]; readonly description: string }
  /** Nothing to run; the user follows the text. */
  | { readonly kind: 'manual'; readonly description: string }

interface Checked {
  readonly item: Omit<EnvItem, 'fix'>
  readonly plan?: FixPlan
}

type Checker = (req: Requirement, ctx: EnvContext) => Promise<Checked>

const CHECKERS: Readonly<Record<string, Checker>> = {
  'dotnet-desktop-runtime': checkDotnetDesktop,
  vcredist: checkVcRedist,
  adb: checkAdb,
  python: (req, ctx) => checkCommand(req, ctx, 'Python', [['py', ['-3', '--version']], ['python', ['--version']]], /Python (\d+\.\d+(?:\.\d+)?)/),
  node: (req, ctx) => checkCommand(req, ctx, 'Node.js', [['node', ['--version']]], /v(\d+\.\d+\.\d+)/),
  emulator: async req => ({
    item: { kind: req.kind, label: '安卓模拟器', status: 'unsupported', detail: '模拟器的检测与自动安装在 M2 提供' },
  }),
}

/** Check every requirement. Unknown kinds are reported as `unsupported`, never thrown. */
export async function checkEnvironment(requirements: readonly Requirement[], ctx: EnvContext, now = Date.now()): Promise<{ report: EnvReport; plans: ReadonlyMap<string, FixPlan> }> {
  const plans = new Map<string, FixPlan>()
  const items: EnvItem[] = []
  for (const req of requirements) {
    const checker = CHECKERS[req.kind]
    let checked: Checked
    try {
      checked = checker === undefined
        ? { item: { kind: req.kind, label: req.kind, status: 'unsupported', detail: '这个版本还不认识这种依赖' } }
        : await checker(req, ctx)
    } catch (error) {
      checked = { item: { kind: req.kind, label: req.kind, status: 'unknown', detail: `检测出错：${error instanceof Error ? error.message : String(error)}` } }
    }
    const { plan } = checked
    if (plan !== undefined && checked.item.status !== 'ok') plans.set(req.kind, plan)
    items.push({
      ...checked.item,
      ...(req.version === undefined ? {} : { required: req.version }),
      ...(req.note === undefined ? {} : { detail: [checked.item.detail, req.note].filter(Boolean).join('；') }),
      ...(plan === undefined || checked.item.status === 'ok' ? {} : {
        fix: {
          kind: plan.kind === 'download-extract' ? 'auto' : plan.kind === 'run-installer' ? 'installer' : 'manual',
          description: plan.description,
          needsAdmin: plan.kind === 'run-installer',
        },
      }),
    })
  }
  const ok = items.every((item, index) => item.status === 'ok' || item.status === 'unsupported' || requirements[index]!.optional === true)
  return { report: { checkedAt: now, ok, items }, plans }
}

async function checkDotnetDesktop(req: Requirement, ctx: EnvContext): Promise<Checked> {
  const arch = req.arch ?? 'x64'
  const programFiles = (arch === 'x86' ? ctx.host.env('ProgramFiles(x86)') : ctx.host.env('ProgramFiles')) ?? 'C:\\Program Files'
  const versions = (await ctx.host.listDir(join(programFiles, 'dotnet', 'shared', 'Microsoft.WindowsDesktop.App')))
    .filter(v => /^\d+\.\d+\.\d+/.test(v))
  const major = minimumMajor(req.version) ?? 8
  const label = `.NET 桌面运行时 ${major}（${arch}）`
  const plan: FixPlan = {
    kind: 'run-installer',
    url: `https://aka.ms/dotnet/${major}.0/windowsdesktop-runtime-win-${arch}.exe`,
    fileName: `windowsdesktop-runtime-${major}-win-${arch}.exe`,
    args: ['/install', '/quiet', '/norestart'],
    okCodes: [0, 1638, 3010],
    description: `从微软官方下载并安装 .NET ${major} 桌面运行时（需要管理员权限）`,
  }
  if (versions.length === 0) return { item: { kind: req.kind, label, status: 'missing' }, plan }
  const best = versions.sort(compareVersions).at(-1)!
  const good = versions.filter(v => satisfies(v, req.version ?? `>=${major}`))
  if (good.length === 0) return { item: { kind: req.kind, label, status: 'outdated', found: best }, plan }
  return { item: { kind: req.kind, label, status: 'ok', found: good.sort(compareVersions).at(-1)! } }
}

async function checkVcRedist(req: Requirement, ctx: EnvContext): Promise<Checked> {
  const arch = req.arch ?? 'x64'
  const label = `Visual C++ 运行库 2015–2022（${arch}）`
  const plan: FixPlan = {
    kind: 'run-installer',
    url: `https://aka.ms/vs/17/release/vc_redist.${arch}.exe`,
    fileName: `vc_redist.${arch}.exe`,
    args: ['/install', '/quiet', '/norestart'],
    okCodes: [0, 1638, 3010],
    description: '从微软官方下载并安装 Visual C++ 运行库（需要管理员权限）',
  }
  for (const root of ['HKLM\\SOFTWARE\\Microsoft', 'HKLM\\SOFTWARE\\WOW6432Node\\Microsoft']) {
    const result = await ctx.host.exec('reg', ['query', `${root}\\VisualStudio\\14.0\\VC\\Runtimes\\${arch.toUpperCase()}`, '/v', 'Version'])
    const version = result?.code === 0 ? /Version\s+REG_SZ\s+v?(\S+)/i.exec(result.stdout)?.[1] : undefined
    if (version !== undefined) {
      return satisfies(version, req.version ?? '>=14')
        ? { item: { kind: req.kind, label, status: 'ok', found: version } }
        : { item: { kind: req.kind, label, status: 'outdated', found: version }, plan }
    }
  }
  return { item: { kind: req.kind, label, status: 'missing' }, plan }
}

async function checkAdb(req: Requirement, ctx: EnvContext): Promise<Checked> {
  const label = 'ADB（Android 平台工具）'
  const shared = join(ctx.sharedDir, 'platform-tools', 'adb.exe')
  const plan: FixPlan = {
    kind: 'download-extract',
    url: 'https://dl.google.com/android/repository/platform-tools-latest-windows.zip',
    into: join(ctx.sharedDir, 'platform-tools'),
    description: '从 Google 官方下载 platform-tools，放到共享工具目录（不需要管理员权限）',
  }
  for (const exe of ['adb', ...(await ctx.host.exists(shared) ? [shared] : [])]) {
    const result = await ctx.host.exec(exe, ['version'])
    if (result?.code !== 0) continue
    const version = /Version (\S+)/.exec(result.stdout)?.[1] ?? /version (\S+)/.exec(result.stdout)?.[1]
    if (version === undefined || satisfies(version, req.version)) {
      return { item: { kind: req.kind, label, status: 'ok', found: exe === 'adb' ? `PATH 中的 adb ${version ?? ''}`.trim() : shared } }
    }
    return { item: { kind: req.kind, label, status: 'outdated', found: version }, plan }
  }
  return { item: { kind: req.kind, label, status: 'missing', detail: '脚本自带 adb 时可以忽略' }, plan }
}

async function checkCommand(req: Requirement, ctx: EnvContext, name: string, candidates: readonly [string, readonly string[]][], pattern: RegExp): Promise<Checked> {
  const label = req.version === undefined ? name : `${name} ${req.version}`
  const plan: FixPlan = { kind: 'manual', description: `请安装 ${label}，安装后重新检测` }
  let found: string | undefined
  for (const [file, args] of candidates) {
    const result = await ctx.host.exec(file, args)
    const version = result?.code === 0 ? pattern.exec(`${result.stdout}\n${result.stderr}`)?.[1] : undefined
    if (version === undefined) continue
    if (satisfies(version, req.version)) return { item: { kind: req.kind, label, status: 'ok', found: version } }
    found = version
  }
  return { item: { kind: req.kind, label, status: found === undefined ? 'missing' : 'outdated', ...(found === undefined ? {} : { found }) }, plan }
}

/** Smallest major version a range allows: `>=8` → 8, `^3.11` → 3, `8.0.1` → 8. */
function minimumMajor(range: string | undefined): number | undefined {
  const match = /(\d+)/.exec(range ?? '')
  return match === null ? undefined : Number(match[1])
}

/** Numeric dot-version compare; non-numeric suffixes (`-rc1`) are ignored. */
export function compareVersions(a: string, b: string): number {
  const pa = a.split(/[.+-]/).map(n => Number.parseInt(n, 10)).filter(n => !Number.isNaN(n))
  const pb = b.split(/[.+-]/).map(n => Number.parseInt(n, 10)).filter(n => !Number.isNaN(n))
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0)
    if (d !== 0) return d
  }
  return 0
}

/**
 * Whether `version` meets `range`: `>=x`, `>x`, `<=x`, `<x`, `^x` (same major,
 * at least x), or a bare version prefix (`8` matches `8.0.11`). No range: true.
 */
export function satisfies(version: string, range: string | undefined): boolean {
  if (range === undefined || range.trim() === '') return true
  return range.split(/\s+/).every(part => {
    const match = /^(>=|>|<=|<|\^|=)?\s*v?(\d[\w.]*)$/.exec(part)
    if (match === null) return false
    const [, op = '=', target = ''] = match
    const cmp = compareVersions(version, target)
    switch (op) {
      case '>=': return cmp >= 0
      case '>': return cmp > 0
      case '<=': return cmp <= 0
      case '<': return cmp < 0
      case '^': return cmp >= 0 && compareVersions(version.split('.')[0]!, target.split('.')[0]!) === 0
      default: return version === target || version.startsWith(`${target}.`)
    }
  })
}
