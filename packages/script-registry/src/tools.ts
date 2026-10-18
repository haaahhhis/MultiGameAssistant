/**
 * Agent tools over the script library.
 *
 * Asking the user first (through dsh's approval seam) when the agent:
 * - installs from a repository no built-in pack describes (downloaded code
 *   is untrusted until the user has seen where it comes from);
 * - runs an official installer to fix the environment (it needs admin);
 * - deletes installed files.
 * Reading, searching, checking, importing in place, switching versions and
 * curated installs run without a prompt.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { ToolCallView } from '@deepseek-ai/dsh-tools/presentation'
import { GitHubRepo, ScriptId, type ScriptJob } from '@adg/protocol'
import { z } from 'zod'
import type { ScriptLibrary } from './library.ts'

export type Approve = (exec: ToolRunContext, reason: string) => Promise<void>

export const TOOL_NAMES = {
  list: 'script_list',
  search: 'script_search',
  releases: 'script_releases',
  install: 'script_install',
  update: 'script_update',
  rollback: 'script_rollback',
  import: 'script_import',
  remove: 'script_remove',
  envCheck: 'script_env_check',
  envFix: 'script_env_fix',
} as const

const INSTALL_TIMEOUT_MS = 60 * 60_000

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }

/** Lossless JSON: drop `undefined`, keep everything else. */
function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null)) as Json
}

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
  return parsed.data
}

function blankToUndefined(value: unknown): unknown {
  return value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value
}
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(blankToUndefined, schema.optional())

function tool(spec: {
  name: string
  description: string
  properties: Record<string, JsonSchemaNode>
  required?: string[]
  timeoutMs?: number
  readOnly?: boolean
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
  title(args: Record<string, unknown>): string
  kind: NonNullable<Extract<ToolCallView, { card: 'generic' }>['kind']>
}): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: {
      type: 'object',
      properties: spec.properties,
      ...(spec.required === undefined ? {} : { required: spec.required }),
      additionalProperties: false,
    },
    output: {
      schema: {},
      render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
    },
    timeoutMs: spec.timeoutMs ?? 120_000,
    isConcurrencySafe: () => spec.readOnly === true,
    execute: async (args, exec) => json(await spec.execute(args, exec)),
    presentCall: args => ({ card: 'generic', title: spec.title((args ?? {}) as Record<string, unknown>), kind: spec.kind }),
  }
}

/** Wait for a job; cancelling the tool call cancels the job. */
async function followJob(library: ScriptLibrary, started: { job: ScriptJob; done: Promise<ScriptJob> }, signal: AbortSignal): Promise<ScriptJob> {
  const onAbort = () => { try { library.cancelJob(started.job.id) } catch { /* already finished */ } }
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await started.done
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

const describeJob =(job: { phase: string; version?: string | undefined; error?: string | undefined; scriptId: string }) =>
  job.phase === 'done' ? { ok: true, script: job.scriptId, version: job.version } : { ok: false, script: job.scriptId, phase: job.phase, error: job.error }

export function scriptTools(library: ScriptLibrary, approve: Approve): ToolDefinition[] {
  const repo = { type: 'string', description: 'GitHub 仓库，格式 owner/repo，例如 MaaAssistantArknights/MaaAssistantArknights。' } as const
  const id = { type: 'string', description: '脚本库里的脚本 id（script_list 可查）。' } as const

  return [
    tool({
      name: TOOL_NAMES.list,
      description: '列出脚本库：已安装或已导入的脚本（id、版本、目录、运行环境检查结果），以及内置脚本包里还没安装的脚本。用户提到某个脚本时先调用它。',
      properties: {},
      readOnly: true,
      kind: 'read',
      title: () => '查看脚本库',
      execute: async () => {
        const { scripts, packs, toolsDir } = library.list()
        return {
          toolsDir,
          scripts: scripts.map(s => ({ id: s.id, name: s.name, source: s.source, version: s.current, dir: s.dir, family: s.family, versions: s.versions.map(v => v.version), env: s.env === undefined ? undefined : { ok: s.env.ok, problems: s.env.items.filter(i => i.status !== 'ok' && i.status !== 'unsupported').map(i => `${i.label}: ${i.status}`) }, update: s.update })),
          availablePacks: packs.filter(p => !p.installed && p.error === undefined).map(p => ({ id: p.id, name: p.name, repo: p.repo, description: p.description })),
        }
      },
    }),
    tool({
      name: TOOL_NAMES.search,
      description: '在 GitHub 上搜索脚本仓库（按星数排序），结果中标出有内置脚本包的仓库。',
      properties: { query: { type: 'string', description: '关键词，例如 "MAA 明日方舟" 或 "星穹铁道 自动化"。' } },
      required: ['query'],
      readOnly: true,
      kind: 'search',
      title: a => `搜索 GitHub：${String(a['query'] ?? '')}`,
      execute: async (args, exec) => library.search(parse(z.object({ query: z.string().trim().min(1).max(200) }), args).query, exec.signal),
    }),
    tool({
      name: TOOL_NAMES.releases,
      description: '查看一个 GitHub 仓库最近的发布版本和其中的文件，以及适合本机（Windows x64）的推荐文件。',
      properties: { repo, limit: { type: 'integer', description: '最多返回几个版本，默认 5。' } },
      required: ['repo'],
      readOnly: true,
      kind: 'fetch',
      title: a => `查看发布：${String(a['repo'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ repo: GitHubRepo, limit: opt(z.number().int().min(1).max(30)) }), args)
        const result = await library.releases(a.repo, a.limit ?? 5, exec.signal)
        return { ...result, releases: result.releases.map(r => ({ tag: r.tag, prerelease: r.prerelease, publishedAt: r.publishedAt, suggestedAsset: r.suggestedAsset, assets: r.assets.map(x => `${x.name} (${Math.round(x.size / 1024 / 1024)} MB)`) })) }
      },
    }),
    tool({
      name: TOOL_NAMES.install,
      description: '从 GitHub 发布版本安装脚本到统一的工具目录（tools/<id>/<版本>/），自动选择适合本机的文件、校验、解压，并检查运行环境。默认装最新正式版。不在内置脚本包里的仓库会先请用户确认。已安装的脚本再次调用即为更新到指定版本。',
      properties: {
        repo,
        tag: { type: 'string', description: '指定版本标签；省略为最新正式版。' },
        asset: { type: 'string', description: '指定要下载的文件名；省略则自动选择。' },
        id: { type: 'string', description: '脚本 id；省略时使用脚本包 id 或仓库名。' },
      },
      required: ['repo'],
      timeoutMs: INSTALL_TIMEOUT_MS,
      kind: 'execute',
      title: a => `安装脚本：${String(a['repo'] ?? '')}${a['tag'] === undefined ? '' : ` ${String(a['tag'])}`}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ repo: GitHubRepo, tag: opt(z.string().min(1).max(200)), asset: opt(z.string().min(1).max(300)), id: opt(ScriptId) }), args)
        if (!library.isKnownRepo(a.repo)) {
          await approve(exec, `从 GitHub 仓库 ${a.repo} 下载并安装${a.tag === undefined ? '最新发布版本' : ` ${a.tag}`}。这个仓库不在内置脚本包里，请确认它来源可信。`)
        }
        const started = library.install({ repo: a.repo, tag: a.tag, asset: a.asset, id: a.id })
        const job = await followJob(library, started, exec.signal)
        const info = job.phase === 'done' ? library.get(job.scriptId) : undefined
        return { ...describeJob(job), dir: info?.dir, env: info?.env, family: info?.family }
      },
    }),
    tool({
      name: TOOL_NAMES.update,
      description: '检查并更新脚本到最新发布版本。新版本装在旧版本旁边，脚本包声明的配置文件会被带到新版本；旧版本保留用于回滚。只更新官方发布，不修改脚本代码。',
      properties: { id },
      required: ['id'],
      timeoutMs: INSTALL_TIMEOUT_MS,
      kind: 'execute',
      title: a => `更新脚本：${String(a['id'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: ScriptId }), args)
        const result = await library.update(a.id, exec.signal)
        if (result.upToDate) return { ok: true, upToDate: true, version: library.get(a.id).current }
        return describeJob(await followJob(library, result, exec.signal))
      },
    }),
    tool({
      name: TOOL_NAMES.rollback,
      description: '把脚本切换回已安装的另一个版本（默认上一个版本）。',
      properties: { id, version: { type: 'string', description: '目标版本；省略为上一个版本。' } },
      required: ['id'],
      kind: 'other',
      title: a => `回滚脚本：${String(a['id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId, version: opt(z.string()) }), args)
        const info = await library.rollback(a.id, a.version)
        return { ok: true, id: info.id, version: info.current, dir: info.dir }
      },
    }),
    tool({
      name: TOOL_NAMES.import,
      description: '把用户电脑上已有的脚本目录登记到脚本库（原地使用，不移动、不复制、不修改）。会按内置脚本包自动识别是哪个脚本。',
      properties: {
        path: { type: 'string', description: '脚本所在目录的绝对路径。' },
        id: { type: 'string', description: '脚本 id；省略时自动生成。' },
        name: { type: 'string', description: '显示名称。' },
        pack_id: { type: 'string', description: '指定用哪个脚本包描述它；省略则自动识别。' },
      },
      required: ['path'],
      kind: 'read',
      title: a => `导入本地脚本：${String(a['path'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ path: z.string().trim().min(1).max(1000), id: opt(ScriptId), name: opt(z.string().trim().min(1).max(100)), pack_id: opt(ScriptId) }), args)
        const info = await library.import({ path: a.path, id: a.id, name: a.name, packId: a.pack_id })
        return { ok: true, id: info.id, name: info.name, pack: info.packId, family: info.family, probe: info.probe, env: info.env }
      },
    }),
    tool({
      name: TOOL_NAMES.remove,
      description: '从脚本库移除脚本。delete_files 为 true 时同时删除安装器装的所有版本（会先请用户确认）；导入的本地目录永远不会被删除。',
      properties: { id, delete_files: { type: 'boolean', description: '同时删除已安装的文件。' } },
      required: ['id'],
      kind: 'delete',
      title: a => `移除脚本：${String(a['id'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: ScriptId, delete_files: opt(z.boolean()) }), args)
        const info = library.get(a.id)
        if (a.delete_files === true && info.source.kind === 'github') {
          await approve(exec, `删除 ${info.name} 的所有已安装版本（${info.versions.map(v => v.version).join('、')}）。`)
        }
        await library.remove(a.id, a.delete_files === true)
        return { ok: true }
      },
    }),
    tool({
      name: TOOL_NAMES.envCheck,
      description: '检查脚本运行所需的环境（例如 .NET 桌面运行时、VC++ 运行库、ADB、Python）在本机是否满足，并给出修复方式。',
      properties: { id },
      required: ['id'],
      readOnly: true,
      kind: 'read',
      title: a => `检查运行环境：${String(a['id'] ?? '')}`,
      execute: async args => library.envCheck(parse(z.object({ id: ScriptId }), args).id),
    }),
    tool({
      name: TOOL_NAMES.envFix,
      description: '修复一项运行环境依赖：自动下载官方组件（例如 ADB）或运行官方安装程序（例如 .NET、VC++ 运行库，会先请用户确认，并弹出系统管理员授权）。kind 取自 script_env_check 结果。',
      properties: { id, kind: { type: 'string', description: '依赖种类，例如 vcredist、dotnet-desktop-runtime、adb。' } },
      required: ['id', 'kind'],
      timeoutMs: INSTALL_TIMEOUT_MS,
      kind: 'execute',
      title: a => `修复运行环境：${String(a['id'] ?? '')} / ${String(a['kind'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: ScriptId, kind: z.string().min(1).max(64) }), args)
        const plan = await library.envFixPlan(a.id, a.kind)
        if (plan === undefined) return { ok: true, message: '这一项已经满足，无需处理' }
        if (plan.kind === 'manual') return { ok: false, manual: true, message: plan.description }
        if (plan.kind === 'run-installer') await approve(exec, `${plan.description}：${plan.url}（Windows 会弹出管理员授权）`)
        const job = await followJob(library, library.envFix(a.id, a.kind, plan), exec.signal)
        return job.phase === 'done' ? { ok: true } : { ok: false, phase: job.phase, error: job.error }
      },
    }),
  ]
}
