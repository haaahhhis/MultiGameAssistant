/**
 * What a script offers agents beyond its tasks: its MCP servers (mcp.ts) and
 * the skills it ships (script-skills.ts). One place for the agent tools
 * (`script_mcp_*`, `script_skills*`) and the 脚本 page (`scripts/mcp`,
 * `scripts/mcp/probe`, `scripts/skills/import`).
 */
import type { ScriptInfo } from '@adg/protocol'
import type { ScriptLibrary } from './library.ts'
import { fingerprint, ScriptMcp, type McpEndpoint, type McpToolInfo } from './mcp.ts'
import { discoverSkills, type ScriptSkill, type SkillOrigin } from './script-skills.ts'

/** The part of the gateway that keeps this app's skills (its skills folder). */
export interface SkillKeeper {
  importSkill(input: {
    name: string; description: string; from: string; single?: boolean
    scripts?: readonly string[]; games?: readonly string[]
    origin: SkillOrigin & Record<string, unknown>; fallbackName?: string
  }): Promise<{ name: string; replaced: boolean }>
  importedSkills(): Promise<Array<{ name: string; origin: Readonly<Record<string, unknown>> & { kind: string }; changed: boolean }>>
}

export interface McpServerView {
  readonly name: string
  readonly source: McpEndpoint['source']
  readonly transport: McpEndpoint['transport']
  /** What it starts (`stdio`) or where it connects. */
  readonly target: string
  readonly file?: string
  readonly needsRunning: boolean
  readonly description?: string
  readonly problem?: string
  /** Started without asking: a built-in pack's, or approved before. */
  readonly trusted: boolean
  readonly connected: boolean
}

export interface ScriptSkillView {
  readonly name: string
  readonly description: string
  readonly path: string
  readonly problem?: string
  /** Among this app's skills, under this name. */
  readonly imported?: { readonly name: string; readonly current: boolean; readonly changed: boolean }
}

export class ScriptIntegrations {
  readonly mcp: ScriptMcp
  readonly #library: ScriptLibrary
  readonly #keeper: () => SkillKeeper | undefined
  readonly #log: { info(message: string): void; warn(message: string): void }

  constructor(library: ScriptLibrary, mcp: ScriptMcp, keeper: () => SkillKeeper | undefined, log: { info(message: string): void; warn(message: string): void }) {
    this.#library = library
    this.mcp = mcp
    this.#keeper = keeper
    this.#log = log
  }

  #installed(id: string): ScriptInfo & { dir: string } {
    const script = this.#library.get(id)
    if (script.dir === undefined) throw new Error(`${script.name} 还没有安装`)
    return script as ScriptInfo & { dir: string }
  }

  /** A script's MCP servers. */
  async endpoints(id: string): Promise<McpEndpoint[]> {
    const script = this.#installed(id)
    const pack = this.#library.packOf(id)
    return this.mcp.endpoints(script.dir, pack === undefined ? undefined : { mcp: pack.manifest.mcp, builtin: pack.builtin })
  }

  /** One of them: by name, or the only one. */
  async endpoint(id: string, server: string | undefined): Promise<McpEndpoint> {
    const all = await this.endpoints(id)
    const script = this.#library.get(id)
    if (all.length === 0) throw new Error(`${script.name} 没有 MCP 服务（脚本目录里没有 MCP 配置，脚本包也没写）`)
    if (server === undefined) {
      const usable = all.filter(e => e.problem === undefined)
      if (usable.length === 1 || all.length === 1) return usable[0] ?? all[0]!
      throw new Error(`${script.name} 有几个 MCP 服务，用 server 指定一个：${all.map(e => e.name).join('、')}`)
    }
    const found = all.find(e => e.name === server)
    if (found === undefined) throw new Error(`${script.name} 没有叫 ${server} 的 MCP 服务；有：${all.map(e => e.name).join('、')}`)
    return found
  }

  async view(id: string, endpoint: McpEndpoint): Promise<McpServerView> {
    return {
      name: endpoint.name, source: endpoint.source, transport: endpoint.transport,
      target: endpoint.transport === 'stdio' ? [endpoint.command, ...endpoint.args].join(' ') : endpoint.url ?? '',
      ...(endpoint.file === undefined ? {} : { file: endpoint.file }),
      needsRunning: endpoint.needsRunning,
      ...(endpoint.description === undefined ? {} : { description: endpoint.description }),
      ...(endpoint.problem === undefined ? {} : { problem: endpoint.problem }),
      trusted: await this.mcp.trusted(id, endpoint),
      connected: this.mcp.connected(id, endpoint.name),
    }
  }

  /** The pack's notes on using the script over MCP. */
  usage(id: string): { usage?: string; tools: Array<{ name: string; server?: string; use: string; task?: string }>; note?: string } {
    const mcp = this.#library.packOf(id)?.manifest.mcp
    if (mcp === undefined) return { tools: [] }
    return {
      ...(mcp.usage === undefined ? {} : { usage: mcp.usage }),
      tools: mcp.tools.map(t => ({ name: t.name, use: t.use, ...(t.server === undefined ? {} : { server: t.server }), ...(t.task === undefined ? {} : { task: t.task }) })),
      ...(mcp.note === undefined ? {} : { note: mcp.note }),
    }
  }

  /**
   * Connect (the user has said yes: `approved`) and list the tools.
   * @param approve - asked first when the server is not trusted yet; throws when refused.
   */
  async tools(id: string, endpoint: McpEndpoint, approve: ((reason: string) => Promise<void>) | 'approved', signal?: AbortSignal): Promise<{ tools: McpToolInfo[]; server?: { name: string; version: string }; instructions?: string }> {
    await this.#allow(id, endpoint, approve)
    return this.mcp.tools(id, endpoint, signal)
  }

  async #allow(id: string, endpoint: McpEndpoint, approve: ((reason: string) => Promise<void>) | 'approved'): Promise<void> {
    if (await this.mcp.trusted(id, endpoint)) return
    if (approve !== 'approved') {
      const script = this.#library.get(id)
      const what = endpoint.transport === 'stdio'
        ? `启动 ${[endpoint.command, ...endpoint.args].join(' ')}（在 ${endpoint.cwd}）`
        : `连接 ${endpoint.url}`
      await approve(`连接 ${script.name} 的 MCP 服务「${endpoint.name}」：${what}${endpoint.file === undefined ? '' : `，配置来自脚本的 ${endpoint.file}`}。同意后这个服务之后不再询问（命令或地址变了会再问）。`)
    }
    await this.mcp.trust(id, endpoint)
    this.#log.info(`MCP server ${id}/${endpoint.name} trusted (${fingerprint(id, endpoint)})`)
  }

  async call(id: string, endpoint: McpEndpoint, tool: string, args: Record<string, unknown>, approve: (reason: string) => Promise<void>, options: { signal?: AbortSignal; timeoutMs?: number }) {
    await this.#allow(id, endpoint, approve)
    return this.mcp.call(id, endpoint, tool, args, options)
  }

  // ── skills ──

  /** The skills a script ships, and which of them are among this app's skills. */
  async skills(id: string): Promise<ScriptSkillView[]> {
    const script = this.#installed(id)
    const found = await discoverSkills(script.dir)
    const imported = await this.#keeper()?.importedSkills().catch(() => []) ?? []
    return found.map(skill => {
      const copy = imported.find(item => item.origin.kind === 'script' && item.origin['script'] === id && item.origin['path'] === skill.path)
      return {
        name: skill.name, description: skill.description, path: skill.path,
        ...(skill.problem === undefined ? {} : { problem: skill.problem }),
        ...(copy === undefined ? {} : { imported: { name: copy.name, current: copy.origin['hash'] === skill.hash, changed: copy.changed } }),
      }
    })
  }

  /**
   * Put a script's skills (these, or all that can be) among this app's
   * skills, belonging to the script: seen only where it is worked on.
   */
  async importSkills(id: string, names?: readonly string[]): Promise<{ imported: Array<{ skill: string; name: string; replaced: boolean }>; skipped: Array<{ skill: string; reason: string }> }> {
    const keeper = this.#keeper()
    if (keeper === undefined) throw new Error('这里没有可以放技能的技能文件夹')
    const script = this.#installed(id)
    const found = await discoverSkills(script.dir)
    if (found.length === 0) throw new Error(`${script.name} 的目录里没有技能（SKILL.md）`)
    const wanted = names === undefined || names.length === 0 ? found : found.filter(s => names.includes(s.name) || names.includes(s.path))
    const missing = (names ?? []).filter(n => !found.some(s => s.name === n || s.path === n))
    const imported: Array<{ skill: string; name: string; replaced: boolean }> = []
    const skipped: Array<{ skill: string; reason: string }> = missing.map(n => ({ skill: n, reason: '脚本目录里没有这个技能' }))
    for (const skill of wanted) {
      if (skill.problem !== undefined) { skipped.push({ skill: skill.name, reason: skill.problem }); continue }
      try {
        const saved = await keeper.importSkill(this.#importInput(script, skill))
        imported.push({ skill: skill.name, name: saved.name, replaced: saved.replaced })
      } catch (error) {
        skipped.push({ skill: skill.name, reason: error instanceof Error ? error.message : String(error) })
      }
    }
    return { imported, skipped }
  }

  /**
   * After a script changed (updated): take again the imported skills whose
   * folder in the script changed, unless the copy was changed here.
   * @returns the names taken again.
   */
  async syncSkills(id: string): Promise<string[]> {
    const keeper = this.#keeper()
    if (keeper === undefined) return []
    let script
    try { script = this.#installed(id) } catch { return [] }
    const imported = (await keeper.importedSkills()).filter(item => item.origin.kind === 'script' && item.origin['script'] === id)
    if (imported.length === 0) return []
    const found = await discoverSkills(script.dir)
    const again: string[] = []
    for (const copy of imported) {
      const skill = found.find(s => s.path === copy.origin['path'])
      if (skill === undefined || skill.problem !== undefined || skill.hash === copy.origin['hash'] || copy.changed) continue
      try {
        await keeper.importSkill(this.#importInput(script, skill))
        again.push(copy.name)
      } catch (error) {
        this.#log.warn(`skill ${copy.name} from ${id} not taken again: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    if (again.length > 0) this.#log.info(`skills taken again after ${id} changed: ${again.join(', ')}`)
    return again
  }

  #importInput(script: ScriptInfo & { dir: string }, skill: ScriptSkill) {
    const pack = this.#library.packOf(script.id)
    // The script's own (and its pack's), not its game's: another script for the same game does not use them.
    return {
      name: skill.name,
      description: skill.description,
      from: skill.dir,
      single: skill.single,
      scripts: [...new Set([script.id, ...(pack === undefined ? [] : [pack.manifest.id])])],
      origin: { kind: 'script' as const, script: script.id, path: skill.path, hash: skill.hash, ...(script.current === undefined ? {} : { version: script.current }), at: Date.now() },
      fallbackName: `${script.id}-${skill.name}`.slice(0, 48).replace(/-+$/, ''),
    }
  }
}
