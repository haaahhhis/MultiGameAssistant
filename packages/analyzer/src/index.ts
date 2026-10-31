/**
 * @adg/analyzer — understanding scripts.
 *
 * - `script_analyze`: the facts about a script directory (read-only);
 * - `script_help`: a program's own `--help` output (asks first for scripts no
 *   built-in pack describes, since it starts their program);
 * - `pack_propose`: a validated Script Pack draft for the user to accept;
 * - every pack's SKILL.md and the `script-analysis` guide as agent skills;
 * - the `packs@1` capability for reviewing drafts.
 */
import { execFile } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { TextDecoder } from 'node:util'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-skill'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@adg/gateway'
import type {} from '@adg/script-registry'
import { MANIFEST_FILE, parseManifest, SKILL_FILE } from '@adg/pack-schema'
import { PACKS_CAPABILITY, ScriptId, type PackDraft, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { analyzeDir } from './analyze.ts'
import { DraftStore, type StoredDraft } from './drafts.ts'
import { parseSkill } from './skills.ts'

export { analyzeDir, type AnalysisReport } from './analyze.ts'
export { DraftStore } from './drafts.ts'
export { parseJsonc, stripJsonc } from './jsonc.ts'
export { readInterface, type MaaInterface, type MaaTask } from './maafw.ts'
export { parseSkill } from './skills.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgAnalyzer: AdgAnalyzer
  }
}

const GUIDE = new URL('../skills/script-analysis.md', import.meta.url)

export class AdgAnalyzer extends Service {
  static inject = ['adgScripts']
  readonly drafts: DraftStore

  constructor(ctx: Context) {
    super(ctx, 'adgAnalyzer')
    const log = ctx.logger('adg-analyzer')
    const scripts = ctx.adgScripts
    const library = scripts.library
    this.drafts = new DraftStore(library.dataDir)
    const drafts = this.drafts
    const changed = (packId?: string) => ctx.get('adgGateway')?.broadcast('packs/changed', packId === undefined ? {} : { packId })

    // ── skills ──
    // The guide is for every session; a pack's SKILL.md only for the sessions working on its scripts (the gateway's skill scope).
    ctx.inject(['skills', 'adgGateway'], scoped => {
      let disposers: Array<() => void> = []
      const register = async () => {
        await scripts.ready
        for (const dispose of disposers.splice(0)) dispose()
        const guide = parseSkill(await readFile(GUIDE, 'utf8'), 'script-analysis')
        if (guide !== undefined) disposers.push(scoped.skills.register({ ...guide, source: 'bundled' }))
        const { scripts: inLibrary } = library.list()
        for (const pack of library.packs()) {
          if (pack.skill === undefined) continue
          const skill = parseSkill(pack.skill, pack.manifest.id)
          if (skill === undefined) {
            log.warn(`pack ${pack.manifest.id}: SKILL.md has no usable frontmatter; not registered as a skill`)
            continue
          }
          const owner = {
            scripts: [pack.manifest.id, ...inLibrary.filter(s => s.packId === pack.manifest.id).map(s => s.id)],
            ...(pack.manifest.game?.name === undefined ? {} : { games: [pack.manifest.game.name] }),
          }
          try {
            disposers.push(scoped.adgGateway.skillScope.register({ ...skill, source: pack.builtin ? 'bundled' : 'custom', path: join(pack.dir, SKILL_FILE), resourceBase: { kind: 'directory', path: pack.dir }, owner }))
          } catch (error) {
            log.warn(`pack ${pack.manifest.id}: skill not registered: ${error instanceof Error ? error.message : String(error)}`)
          }
        }
      }
      void register()
      scoped.effect(() => library.onPacksChanged(() => void register()), 'adg-analyzer pack skills')
      scoped.effect(() => () => { for (const dispose of disposers.splice(0)) dispose() }, 'adg-analyzer skills')
    })

    // ── tools ──
    const approve = async (exec: ToolRunContext, reason: string) => {
      const approval = ctx.get('approval')
      if (approval === undefined || exec.agent === undefined) throw new Error('这个操作需要用户批准，但当前没有可用的审批渠道')
      const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason, signal: exec.signal })
      if (outcome !== 'allowed-once') throw new Error(outcome === 'rejected' ? '用户拒绝了这个操作' : `没有得到用户批准（${outcome}）`)
    }
    ctx.inject(['tools'], scoped => {
      // 设置 → 权限 decides per area (the gateway's guardTool).
      for (const tool of analyzerTools({ library, drafts, approve, ready: scripts.ready, changed })) scoped.tools.register({ ...tool, execute: async (args, exec) => { await ctx.get('adgGateway')?.guardTool(exec); return tool.execute(args, exec) } })
    })

    // ── capability ──
    ctx.inject(['adgGateway'], scoped => {
      scoped.adgGateway.register({
        id: PACKS_CAPABILITY,
        version: 1,
        methods: {
          'packs/drafts': async params => {
            await scripts.ready
            const p = params as RequestParams<'packs/drafts'>
            const items = (await drafts.list()).filter(d => p.scriptId === undefined || d.scriptId === p.scriptId)
            return { items: await Promise.all(items.map(d => describe(d))) }
          },
          'packs/accept': async params => {
            await scripts.ready
            const { packId } = params as RequestParams<'packs/accept'>
            const { dir, meta } = await drafts.accept(packId)
            await library.reloadPacks()
            try {
              await library.attachPack(meta.scriptId, packId)
            } catch (error) {
              log.warn(`accepted pack ${packId} but could not attach it to ${meta.scriptId}: ${error instanceof Error ? error.message : String(error)}`)
            }
            changed(packId)
            return { packId, dir }
          },
          'packs/reject': async params => {
            const { packId } = params as RequestParams<'packs/reject'>
            await drafts.reject(packId)
            changed(packId)
            return {}
          },
        },
      })
    })

    const describe = async (draft: StoredDraft): Promise<PackDraft> => {
      const current = library.pack(draft.packId)
      let tasks: { id: string; title: string }[] = []
      try { tasks = parseManifest(draft.manifest).tasks.map(t => ({ id: t.id, title: t.title })) } catch { /* shown as invalid in the UI */ }
      const currentManifest = current === undefined ? undefined : await readFile(join(current.dir, MANIFEST_FILE), 'utf8').catch(() => undefined)
      return {
        packId: draft.packId, scriptId: draft.scriptId, proposedAt: draft.proposedAt, summary: draft.summary,
        ...(draft.docs === undefined ? {} : { docs: draft.docs.map(d => ({ ...d })) }),
        ...(draft.noDocs === undefined ? {} : { noDocs: draft.noDocs }),
        manifest: draft.manifest, skill: draft.skill, tasks,
        ...(draft.sessionId === undefined ? {} : { sessionId: draft.sessionId }),
        ...(current === undefined || currentManifest === undefined ? {} : { current: { manifest: currentManifest, builtin: current.builtin, ...(current.skill === undefined ? {} : { skill: current.skill }) } }),
      }
    }
  }
}

interface ToolDeps {
  readonly library: import('@adg/script-registry').ScriptLibrary
  readonly drafts: DraftStore
  readonly approve: (exec: ToolRunContext, reason: string) => Promise<void>
  readonly ready: Promise<void>
  readonly changed: (packId?: string) => void
}

function analyzerTools(deps: ToolDeps): ToolDefinition[] {
  const json = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as never
  const parse = <T,>(schema: z.ZodType<T>, args: unknown): T => {
    const parsed = schema.safeParse(args)
    if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
    return parsed.data
  }
  const tool = (spec: { name: string; description: string; properties: Record<string, JsonSchemaNode>; required: string[]; kind: 'read' | 'execute' | 'edit'; title: (a: Record<string, unknown>) => string; timeoutMs?: number; execute: (args: unknown, exec: ToolRunContext) => Promise<unknown> }): ToolDefinition => ({
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties, required: spec.required, additionalProperties: false },
    output: { schema: {}, render: (_a, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] },
    timeoutMs: spec.timeoutMs ?? 120_000,
    isConcurrencySafe: () => spec.kind === 'read',
    execute: async (args, exec) => { await deps.ready; return json(await spec.execute(args, exec)) },
    presentCall: args => ({ card: 'generic', title: spec.title((args ?? {}) as Record<string, unknown>), kind: spec.kind }),
  })
  const id = { type: 'string', description: '脚本库里的脚本 id。' } as const

  return [
    tool({
      name: 'script_analyze',
      description: '分析脚本库里的一个脚本目录（只读）：目录结构、项目自带的文档（docs：README、使用说明、更新日志、帮助）和文档网址（docLinks：仓库、Wiki、文档站）、MaaFramework 的 interface.json、配置文件、日志样本、建议的适配家族，以及它现有的脚本包。写脚本包前先调用；按 script-analysis 技能的步骤进行：先读文档，再看代码。',
      properties: { id },
      required: ['id'],
      kind: 'read',
      title: a => `分析脚本：${String(a['id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId }), args)
        const script = deps.library.get(a.id)
        if (script.dir === undefined) throw new Error(`${script.name} 还没有安装`)
        const report = await analyzeDir(script.dir)
        const pack = deps.library.packOf(a.id)
        const manifest = pack === undefined ? undefined : await readFile(join(pack.dir, MANIFEST_FILE), 'utf8').catch(() => undefined)
        // Where its documentation is online: the repository it updates from (README, Wiki), and the pages its README links.
        const repo = script.channels.github?.repo
        const online = [...(repo === undefined ? [] : [`https://github.com/${repo}`, `https://github.com/${repo}/wiki`]), ...report.docLinks]
        return {
          script: { id: script.id, name: script.name, source: script.source, family: script.family },
          ...report,
          docLinks: [...new Set(online)],
          readFirst: '先读文档（docs 里的文件、readme、docLinks 里的网页），再结合代码和配置核对、补全；只有完全找不到文档时才直接从代码分析。',
          currentPack: pack === undefined ? null : { id: pack.manifest.id, builtin: pack.builtin, manifest, skill: pack.skill },
        }
      },
    }),
    tool({
      name: 'script_help',
      description: '运行脚本程序的帮助参数（默认 --help），拿到它自己说明的命令和任务。最多运行 20 秒后结束。没有内置脚本包的脚本会先请用户确认，因为这会启动它的程序。',
      properties: {
        id,
        exe: { type: 'string', description: '要运行的程序（相对脚本目录）；省略时用脚本包的启动程序或找到的第一个可执行文件。' },
        args: { type: 'array', items: { type: 'string' }, description: '参数，默认 ["--help"]；也可以是 ["-h"]、["-l"]、["--list-workflows"]。' },
      },
      required: ['id'],
      kind: 'execute',
      timeoutMs: 60_000,
      title: a => `查看帮助：${String(a['id'] ?? '')} ${Array.isArray(a['args']) ? a['args'].join(' ') : '--help'}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: ScriptId, exe: z.string().min(1).max(300).nullish(), args: z.array(z.string().max(100)).max(8).nullish() }), args)
        const script = deps.library.get(a.id)
        if (script.dir === undefined) throw new Error(`${script.name} 还没有安装`)
        const pack = deps.library.packOf(a.id)
        const exe = a.exe ?? pack?.manifest.launch?.exe ?? script.probe?.executables[0]
        if (exe === undefined) throw new Error('没有找到可执行文件，请用 exe 参数指定')
        if (exe.split(/[\\/]/).includes('..') || /^([A-Za-z]:|[\\/])/.test(exe)) throw new Error('exe 必须是脚本目录里的相对路径')
        const helpArgs = a.args ?? ['--help']
        if (pack?.builtin !== true) await deps.approve(exec, `为了分析 ${script.name}，运行 ${exe} ${helpArgs.join(' ')}（最多 20 秒，只看它的帮助输出）`)
        return runHelp(join(script.dir, exe), helpArgs, script.dir)
      },
    }),
    tool({
      name: 'script_changelog',
      description: '读一个脚本这几个版本的更新日志：GitHub 上每个发布版的说明、Mirror酱 最新版的说明，以及脚本目录里的 CHANGELOG / 更新日志文件。脚本更新后检查脚本包时先调用；from 默认是脚本包写成时的版本，to 默认是现在的版本。',
      properties: {
        id,
        from: { type: 'string', description: '从哪个版本之后（不含）；省略为脚本包写成时的版本。' },
        to: { type: 'string', description: '到哪个版本（含）；省略为现在的版本。' },
      },
      required: ['id'],
      kind: 'read',
      title: a => `读更新日志：${String(a['id'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: ScriptId, from: z.string().max(60).nullish(), to: z.string().max(60).nullish() }), args)
        return deps.library.changelog(a.id, { from: a.from ?? undefined, to: a.to ?? undefined, signal: exec.signal })
      },
    }),
    tool({
      name: 'pack_reviewed',
      description: '脚本更新后检查过脚本包、确认不用改时调用：记下脚本包已经对照现在的版本检查过，不再提醒。要改就用 pack_propose 提交，用户接受后会自动记下，不用调用这个。',
      properties: {
        id,
        reason: { type: 'string', description: '为什么不用改（会告诉用户），例如「这几个版本只修了识别问题，任务、配置和日志都没变」。' },
      },
      required: ['id', 'reason'],
      kind: 'edit',
      title: a => `脚本包不用改：${String(a['id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId, reason: z.string().min(4).max(1000) }), args)
        const info = await deps.library.packReviewed(a.id)
        return { ok: true, version: info.localVersion?.version ?? info.current, reason: a.reason }
      },
    }),
    tool({
      name: 'pack_propose',
      description: '提交脚本包草稿（adg.script.yaml 和 SKILL.md）。会按 schema 校验，失败时返回具体字段以便修正后重新提交；通过后保存为草稿，用户在「脚本」页确认后生效。不会修改脚本本身。',
      properties: {
        pack_id: { type: 'string', description: '脚本包 id（与 manifest 里的 id 相同；改进已有脚本包时用原 id）。' },
        script_id: { type: 'string', description: '这个包描述的脚本库里的脚本 id。' },
        manifest: { type: 'string', description: 'adg.script.yaml 的完整内容。' },
        skill: { type: 'string', description: 'SKILL.md 的完整内容（以 name / description frontmatter 开头）。' },
        summary: { type: 'string', description: '给用户看的一段话：做了什么、依据是什么、哪些还待确认。' },
        docs: {
          type: 'array',
          description: '写这份脚本包读过的项目文档（先读文档再看代码）：每项写出处（脚本目录里的相对路径或网址）和从中得到了什么。',
          items: { type: 'object', properties: { source: { type: 'string' }, used: { type: 'string' } }, required: ['source', 'used'], additionalProperties: false },
        },
        no_docs: { type: 'string', description: '确实找不到任何文档（目录、仓库、Wiki、文档站都没有）才填：说明找过哪些地方。填了它 docs 可以为空。' },
      },
      required: ['pack_id', 'script_id', 'manifest', 'skill', 'summary', 'docs'],
      kind: 'edit',
      title: a => `提交脚本包草稿：${String(a['pack_id'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({
          pack_id: ScriptId, script_id: ScriptId, manifest: z.string().min(10).max(200_000), skill: z.string().min(10).max(200_000), summary: z.string().min(1).max(4000),
          docs: z.array(z.object({ source: z.string().min(1).max(500), used: z.string().min(1).max(1000) })).max(40).nullish(),
          no_docs: z.string().max(1000).nullish(),
        }), args)
        const docs = a.docs ?? []
        // Documentation first (script-analysis): a draft says what it was read from, or where documentation was looked for.
        if (docs.length === 0 && (a.no_docs ?? '').trim().length < 10) {
          throw new Error('先读项目的文档再写脚本包：docs 里写出读过的文档（出处和得到了什么）；确实找不到文档时用 no_docs 说明找过哪些地方（脚本目录、仓库 README、Wiki、文档站）')
        }
        deps.library.get(a.script_id) // must exist
        const result = await deps.drafts.propose({
          packId: a.pack_id, scriptId: a.script_id, proposedAt: Date.now(), summary: a.summary,
          ...(docs.length === 0 ? {} : { docs }),
          ...(docs.length > 0 || a.no_docs == null ? {} : { noDocs: a.no_docs.trim() }),
          ...(exec.agent === undefined ? {} : { sessionId: exec.agent.session.id }),
        }, a.manifest, a.skill)
        deps.changed(a.pack_id)
        return { ok: true, pack_id: a.pack_id, tasks: result.tasks, next: '草稿已保存。请告诉用户到「脚本」页查看这个脚本的「脚本包草稿」并确认。' }
      },
    }),
  ]
}

function runHelp(file: string, args: readonly string[], cwd: string): Promise<{ exitCode: number | null; output: string; timedOut: boolean }> {
  return new Promise(resolve => {
    execFile(file, [...args], { cwd, windowsHide: true, timeout: 20_000, maxBuffer: 4 * 1024 * 1024, encoding: 'buffer' }, (error, stdout, stderr) => {
      const raw = Buffer.concat([stdout as Buffer, stderr as Buffer])
      let output = new TextDecoder('utf-8').decode(raw)
      // Chinese Windows consoles often print GBK; prefer it when UTF-8 decoding is mostly replacement characters.
      if ((output.match(/�/g)?.length ?? 0) > 5) output = new TextDecoder('gbk').decode(raw)
      const timedOut = (error as { killed?: boolean } | null)?.killed === true
      const code = error === null ? 0 : typeof (error as { code?: unknown }).code === 'number' ? (error as { code: number }).code : null
      resolve({ exitCode: code, output: output.slice(0, 12_000), timedOut })
    })
  })
}

export default AdgAnalyzer
