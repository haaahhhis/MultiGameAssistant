/**
 * The facts the agent needs to write a Script Pack for a script it has not
 * seen: layout, launchers, README, MaaFramework tasks, config and log files.
 * Read-only and bounded; deciding what they mean is the agent's job, guided by
 * the `script-analysis` skill.
 */
import { readdir, readFile, stat } from 'node:fs/promises'
import { extname, join, relative } from 'node:path'
import { probeProject } from '@adg/installer'
import type { ProjectProbe } from '@adg/protocol'
import { parseJsonc } from './jsonc.ts'
import { readInterface, type MaaInterface } from './maafw.ts'

export interface AnalysisReport {
  readonly dir: string
  readonly probe: ProjectProbe
  /** Top two levels of the tree (directories end with `/`), capped. */
  readonly tree: readonly string[]
  readonly readme?: { file: string; text: string; truncated: boolean }
  readonly interface?: MaaInterface & { file: string }
  readonly configFiles: readonly { file: string; size: number; topKeys?: readonly string[] }[]
  readonly logFiles: readonly { file: string; size: number; tail: readonly string[] }[]
  /** Family the facts point to; the agent confirms or overrides it. */
  readonly suggestedFamily: string
  readonly notes: readonly string[]
}

const README = /^readme(\.zh(-cn)?|_zh|\.cn)?\.(md|txt)$/i
const CONFIG_EXT = new Set(['.json', '.jsonc', '.yaml', '.yml', '.toml', '.ini', '.cfg', '.conf'])
const LOG_EXT = new Set(['.log', '.txt'])
const SKIP = /^(node_modules|\.git|__pycache__|site-packages|lib|libs|runtime|python|3rdparty|res|resource|assets|locales|_internal)$/i
const MAX_TREE = 160
const MAX_README = 12_000

export async function analyzeDir(dir: string): Promise<AnalysisReport> {
  const notes: string[] = []
  const probe = await probeProject(dir)
  const tree = await listTree(dir)

  const top = await readdir(dir).catch(() => [] as string[])
  const readmeFile = top.find(n => /^readme\.zh/i.test(n)) ?? top.find(n => README.test(n))
  let readme: AnalysisReport['readme']
  if (readmeFile !== undefined) {
    const text = await readFile(join(dir, readmeFile), 'utf8').catch(() => '')
    readme = { file: readmeFile, text: text.slice(0, MAX_README), truncated: text.length > MAX_README }
  } else notes.push('没有 README；发布包里通常没有，可以查看项目主页或源码仓库的说明')

  let iface: AnalysisReport['interface']
  for (const candidate of ['interface.json', 'assets/interface.json']) {
    if (await isFile(join(dir, candidate))) {
      iface = { ...(await readInterface(join(dir, candidate))), file: candidate }
      break
    }
  }

  const configFiles: { file: string; size: number; topKeys?: string[] }[] = []
  const logFiles: { file: string; size: number; tail: string[] }[] = []
  for (const sub of ['', 'config', 'configs', 'setting', 'settings', 'user', 'data']) {
    const base = join(dir, sub)
    for (const name of await readdir(base).catch(() => [] as string[])) {
      const path = join(base, name)
      const info = await stat(path).catch(() => undefined)
      if (info === undefined || !info.isFile()) continue
      const rel = relative(dir, path).replace(/\\/g, '/')
      const ext = extname(name).toLowerCase()
      if (CONFIG_EXT.has(ext) && info.size < 2_000_000 && rel !== 'interface.json' && !/(deps|runtimeconfig|package-lock|manifest)\.json$/i.test(name)) {
        let topKeys: string[] | undefined
        if (ext === '.json' || ext === '.jsonc') {
          try {
            const value = parseJsonc(await readFile(path, 'utf8'))
            if (value !== null && typeof value === 'object' && !Array.isArray(value)) topKeys = Object.keys(value).slice(0, 30)
          } catch { /* not JSON after all */ }
        }
        configFiles.push({ file: rel, size: info.size, ...(topKeys === undefined ? {} : { topKeys }) })
      }
    }
  }
  for (const sub of ['debug', 'log', 'logs', '']) {
    const base = join(dir, sub)
    for (const name of await readdir(base).catch(() => [] as string[])) {
      if (!LOG_EXT.has(extname(name).toLowerCase()) || (sub === '' && !/log/i.test(name))) continue
      const path = join(base, name)
      const info = await stat(path).catch(() => undefined)
      if (info === undefined || !info.isFile()) continue
      const tail = (await readTail(path, 4096)).split(/\r?\n/).filter(Boolean).slice(-8)
      logFiles.push({ file: relative(dir, path).replace(/\\/g, '/'), size: info.size, tail })
    }
  }
  if (logFiles.length === 0) notes.push('还没有日志文件；可能要先运行一次脚本才会生成，日志规则可以先根据文档写，运行后再校准')

  const suggestedFamily = iface !== undefined ? 'maafw-pi'
    : probe.markers.includes('main.py') || probe.markers.includes('pyproject.toml') ? 'cli'
      : configFiles.length > 0 && probe.executables.length > 0 ? 'gui-config'
        : probe.executables.length > 0 ? 'generic-process' : 'visual'
  return {
    dir, probe, tree, configFiles, logFiles, suggestedFamily, notes,
    ...(readme === undefined ? {} : { readme }),
    ...(iface === undefined ? {} : { interface: iface }),
  }
}

async function listTree(dir: string): Promise<string[]> {
  const out: string[] = []
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (out.length >= MAX_TREE) break
    out.push(entry.isDirectory() ? `${entry.name}/` : entry.name)
    if (!entry.isDirectory() || SKIP.test(entry.name)) continue
    for (const inner of (await readdir(join(dir, entry.name), { withFileTypes: true }).catch(() => [])).slice(0, 25)) {
      if (out.length >= MAX_TREE) break
      out.push(`${entry.name}/${inner.name}${inner.isDirectory() ? '/' : ''}`)
    }
  }
  return out
}

async function readTail(path: string, bytes: number): Promise<string> {
  const buffer = await readFile(path).catch(() => Buffer.alloc(0))
  return buffer.subarray(Math.max(0, buffer.length - bytes)).toString('utf8')
}

async function isFile(path: string): Promise<boolean> {
  return stat(path).then(s => s.isFile(), () => false)
}
