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
  /**
   * The project's own documentation in its folder (README, docs/, manuals,
   * changelogs, FAQ), read before any code; newest-looking first, capped.
   */
  readonly docs: readonly { file: string; size: number }[]
  /** Documentation pages the README and interface.json point to (wikis, doc sites, the repository). */
  readonly docLinks: readonly string[]
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
const DOC_EXT = new Set(['.md', '.markdown', '.txt', '.html', '.htm', '.pdf', '.rst', '.adoc'])
/** Folders documentation lives in. */
const DOC_DIRS = /^(docs?|documents?|documentation|manuals?|help|wiki|guides?|文档|说明|使用说明|帮助|教程)$/i
/** File names that are documentation wherever they are. */
const DOC_NAME = /readme|changelog|changes|release|history|更新|说明|使用|教程|帮助|指南|manual|guide|usage|faq|help|howto|tutorial|wiki/i
const MAX_DOCS = 40
const MAX_LINKS = 12
/** Links that are documentation rather than downloads or badges. */
const DOC_LINK = /^https?:\/\/(?:\S*\b(?:docs?|wiki|readthedocs|gitbook|manual|guide|faq)\b|[^/\s]*\.(?:github|gitee)\.io\b|github\.com\/[\w.-]+\/[\w.-]+\/?$|github\.com\/[\w.-]+\/[\w.-]+\/blob\/\S*\.md$)/i

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
  const docs = await findDocs(dir)
  if (docs.length === 0 && readme === undefined) notes.push('目录里没有文档：先去项目主页、GitHub 仓库的 README / Wiki / 文档站找，找不到再看代码')

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

  const docLinks = linksIn([readme?.text ?? '', iface === undefined ? '' : JSON.stringify(iface)].join('\n'))
  const suggestedFamily = iface !== undefined ? 'maafw-pi'
    : probe.markers.includes('main.py') || probe.markers.includes('pyproject.toml') ? 'cli'
      : configFiles.length > 0 && probe.executables.length > 0 ? 'gui-config'
        : probe.executables.length > 0 ? 'generic-process' : 'visual'
  return {
    dir, probe, tree, docs, docLinks, configFiles, logFiles, suggestedFamily, notes,
    ...(readme === undefined ? {} : { readme }),
    ...(iface === undefined ? {} : { interface: iface }),
  }
}

/**
 * Documentation files: anything in a docs-like folder (two levels deep), and
 * files named like documentation at the top or one level down. Changelogs
 * and READMEs first, then by size (bigger is usually the real manual).
 */
async function findDocs(dir: string): Promise<{ file: string; size: number }[]> {
  const found = new Map<string, number>()
  const visit = async (rel: string, depth: number, inDocs: boolean) => {
    for (const entry of await readdir(join(dir, rel), { withFileTypes: true }).catch(() => [])) {
      if (found.size >= MAX_DOCS * 3) return
      const path = rel === '' ? entry.name : `${rel}/${entry.name}`
      if (entry.isDirectory()) {
        if (SKIP.test(entry.name) && !DOC_DIRS.test(entry.name)) continue
        const docsDir = inDocs || DOC_DIRS.test(entry.name)
        if (depth < (docsDir ? 3 : 1)) await visit(path, depth + 1, docsDir)
        continue
      }
      if (!entry.isFile() || !DOC_EXT.has(extname(entry.name).toLowerCase())) continue
      if (!inDocs && !DOC_NAME.test(entry.name)) continue
      if (/log/i.test(entry.name) && !/changelog/i.test(entry.name)) continue
      const info = await stat(join(dir, path)).catch(() => undefined)
      if (info !== undefined) found.set(path, info.size)
    }
  }
  await visit('', 0, false)
  const weight = (file: string) => (/changelog|changes|release|更新/i.test(file) ? 0 : /readme/i.test(file) ? 1 : 2)
  return [...found].map(([file, size]) => ({ file, size }))
    .sort((a, b) => weight(a.file) - weight(b.file) || b.size - a.size)
    .slice(0, MAX_DOCS)
}

function linksIn(text: string): string[] {
  const links = new Set<string>()
  for (const match of text.matchAll(/https?:\/\/[^\s)"'<>\]]+/g)) {
    const url = match[0].replace(/[.,;:!?。，；]+$/, '')
    if (DOC_LINK.test(url) && !/\.(png|jpe?g|gif|svg|webp|zip|7z|exe)(\?|$)/i.test(url) && !/shields\.io|badge/i.test(url)) links.add(url)
    if (links.size >= MAX_LINKS) break
  }
  return [...links]
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
