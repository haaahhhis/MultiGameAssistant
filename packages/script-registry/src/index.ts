/**
 * @adg/script-registry — the script library as a Cordis service (`ctx.adgScripts`).
 *
 * Contributes, each only while its host service is mounted:
 * - agent tools `script_*` (install, update, rollback, import, env check/fix…);
 * - the `scripts@1` gateway capability for the UI's script library page;
 * - the skills repository (技能库, `skillhub@1` and `skill_hub_*` tools).
 *
 * Script Packs come from the 技能库 (downloaded into `<dataDir>/skill-hub/skills`;
 * the user may delete any) and `<dataDir>/packs` (the user's, overriding those
 * by id). The app ships none: the ones a new install starts with are the
 * repository's `default` ones, downloaded on the first start. The user packs'
 * SKILL.md are registered by the analyzer, the 技能库's by the hub.
 */
import { join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@adg/gateway'
import { SCRIPT_ROLE } from './role.ts'
import { InstallSettings } from '@adg/protocol'
import { ExeIcons } from '@adg/protocol/node'
import { z } from 'zod'
import { scriptsCapability } from './capability.ts'
import { ScriptLibrary } from './library.ts'
import { packReview } from './pack-review.ts'
import { optimizer as scriptOptimizer, type Optimizer } from './optimize.ts'
import { startSkillHub } from './skill-hub-plugin.ts'
import { scriptSummaries } from './script-summary.ts'
import { setupHandOff } from './setup-handoff.ts'
import type { SkillHub } from './skill-hub.ts'
import { scriptTools, TOOL_NAMES, type Approve } from './tools.ts'
import { ScriptMcp } from './mcp.ts'
import { mcpTools } from './mcp-tools.ts'
import { ScriptIntegrations } from './script-integrations.ts'

/** Look for newer versions of every script a little after the app starts, then every few hours. */
const UPDATE_CHECK_FIRST_MS = 2 * 60_000
const UPDATE_CHECK_EVERY_MS = 6 * 60 * 60_000

export { OPTIMIZE_AFTER_RUNS, ScriptLibrary, type InstallRequest, type LibraryOptions, type PreRunUpdate } from './library.ts'
export type { Optimizer } from './optimize.ts'
export { loadPacks, packForRepo, type LoadedPack, type PackDir } from './packs.ts'
export { TOOL_NAMES } from './tools.ts'
export { MCP_TOOL_NAMES } from './mcp-tools.ts'
export { discoverMcp, mcpEndpoints, parseMcpConfig, ScriptMcp, type DiscoveredMcpServer, type McpEndpoint } from './mcp.ts'
export { discoverSkills, type ScriptSkill } from './script-skills.ts'
export { ScriptIntegrations, type SkillKeeper } from './script-integrations.ts'
export { frontmatter, readSkills, SkillHub, type HubItem, type HubSkill } from './skill-hub.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    /** The script library. */
    adgScripts: AdgScripts
  }
}

const ConfigSchema = z.object({
  /** Where installed scripts live: `<toolsDir>/<id>/<version>/`. */
  toolsDir: z.string().min(1),
  /** Where scripts were installed before `toolsDir` moved: still the library's (library.ts). */
  formerToolsDirs: z.array(z.string().min(1)).optional(),
  /** Library state (`scripts.json`) and the user's packs (`packs/`). */
  dataDir: z.string().min(1),
  /** Official pack directories besides the 技能库's downloads (none by default: the app ships no packs). */
  packDirs: z.array(z.string().min(1)).optional(),
  /** Install settings used until the user changes them in the UI. */
  defaults: InstallSettings.partial().optional(),
})

export type Config = z.input<typeof ConfigSchema>

export class AdgScripts extends Service {
  readonly library: ScriptLibrary
  /** The skills repository (技能库). */
  readonly skillHub: SkillHub
  /** Settles once the library state and packs are loaded. */
  readonly ready: Promise<void>
  /** 优化脚本: offered after enough clean runs (the runner reports them to `library.ranClean`) or an update. */
  readonly optimizer: Optimizer
  /** The scripts' MCP servers and the skills they ship (script-integrations.ts). */
  readonly integrations: ScriptIntegrations

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgScripts')
    const parsed = ConfigSchema.safeParse(config)
    if (!parsed.success) throw new Error(`adg-script-registry: invalid config: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const spec = parsed.data
    const log = ctx.logger('adg-scripts')
    const ref = (value: string) => value as CredentialRef
    const handOff = setupHandOff(ctx, () => this.library, { info: message => log.info(message), warn: message => log.warn(message) })

    // A script that changed (an update) may ship newer versions of the skills taken from it: take them again, a little later.
    const syncing = new Map<string, ReturnType<typeof setTimeout>>()
    const skillSync = (id: string) => {
      clearTimeout(syncing.get(id))
      const timer = setTimeout(() => {
        syncing.delete(id)
        void this.ready.then(() => this.integrations.syncSkills(id)).then(names => {
          if (names.length > 0) ctx.get('adgGateway')?.broadcast('skills/changed', {})
        }, error => log.warn(`skills of ${id} not synced: ${error instanceof Error ? error.message : String(error)}`))
      }, 5_000)
      timer.unref()
      syncing.set(id, timer)
    }
    ctx.effect(() => () => { for (const timer of syncing.values()) clearTimeout(timer); syncing.clear() }, 'adg-scripts skill sync')

    const review = packReview(ctx, () => this.library, { warn: message => log.warn(message) })
    const optimizer = scriptOptimizer(ctx, () => this.library, { warn: message => log.warn(message) })
    this.optimizer = optimizer
    this.library = new ScriptLibrary({
      toolsDir: spec.toolsDir,
      ...(spec.formerToolsDirs === undefined ? {} : { formerToolsDirs: spec.formerToolsDirs }),
      dataDir: spec.dataDir,
      packDirs: spec.packDirs ?? [],
      // Until the hub has read where each came from, none is trusted (it reads them again then).
      hubPacks: { dir: join(spec.dataDir, 'skill-hub', 'skills'), trusted: id => this.skillHub?.isTrusted(id) ?? false },
      ...(spec.defaults === undefined ? {} : { defaults: stripUndefined(spec.defaults) }),
      credential: async name => (await ctx.get('credentials')?.resolve(ref(name)))?.value,
      credentialConfigured: async name => (await ctx.get('credentials')?.describe(ref(name)))?.configured ?? false,
      onChanged: id => {
        ctx.get('adgGateway')?.broadcast('scripts/changed', id === undefined ? {} : { id })
        if (id !== undefined) skillSync(id)
      },
      onJob: job => ctx.get('adgGateway')?.broadcast('scripts/job', job),
      onSetup: handOff,
      onPackReview: script => review.ask(script),
      onOptimize: script => optimizer.ask(script),
      log: { info: message => log.info(message), warn: message => log.warn(message) },
    })
    const library = this.library
    this.integrations = new ScriptIntegrations(library, new ScriptMcp({ dataDir: spec.dataDir, log: { info: message => log.info(message), warn: message => log.warn(message) } }), () => ctx.get('adgGateway'), { info: message => log.info(message), warn: message => log.warn(message) })
    const integrations = this.integrations
    ctx.effect(() => () => void integrations.mcp.dispose(), 'adg-scripts MCP connections')
    this.ready = library.start()
    this.ready.then(
      () => log.info(`script library ready: ${library.list().scripts.length} script(s), tools in ${library.toolsDir}`),
      error => log.error(`script library failed to load: ${error instanceof Error ? error.message : String(error)}`),
    )
    ctx.effect(() => () => library.dispose(), 'adg-scripts jobs')
    ctx.effect(() => {
      const stop = new AbortController()
      const check = () => { void this.ready.then(() => library.checkUpdates(stop.signal), () => {}) }
      const first = setTimeout(check, UPDATE_CHECK_FIRST_MS)
      const every = setInterval(check, UPDATE_CHECK_EVERY_MS)
      first.unref()
      every.unref()
      return () => { stop.abort(); clearTimeout(first); clearInterval(every) }
    }, 'adg-scripts update checks')

    const approve: Approve = async (exec, reason) => {
      const approval = ctx.get('approval')
      if (approval === undefined || exec.agent === undefined) throw new Error('这个操作需要用户批准，但当前没有可用的审批渠道')
      const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason, signal: exec.signal })
      if (outcome !== 'allowed-once') throw new Error(outcome === 'rejected' ? '用户拒绝了这个操作' : `没有得到用户批准（${outcome}）`)
    }

    ctx.inject(['adgGateway'], gateway => gateway.adgGateway.agentPart('adg-script-registry tools', agent => {
      const registered: Array<() => void> = []
      for (const tool of [...scriptTools(library, approve), ...mcpTools(library, integrations, approve)]) {
        registered.push(agent.tools.register({ ...tool, execute: async (args, exec) => { await this.ready; await ctx.get('adgGateway')?.guardTool(exec); return tool.execute(args, exec) } }))
      }
      return () => { for (const dispose of registered) dispose() }
    }))

    const summaries = scriptSummaries(ctx, library, { warn: message => log.warn(message) })
    ctx.inject(['adgGateway'], scoped => {
      scoped.effect(() => scoped.adgGateway.role(SCRIPT_ROLE), 'adg-script-registry role')
      // Skill isolation: a script in a session's focus also stands for its pack and the game it plays.
      scoped.adgGateway.skillScope.resolveScripts(id => {
        let pack
        try { pack = library.packOf(id) } catch { pack = library.pack(id) }
        const game = pack?.manifest.game?.name
        return { aliases: pack === undefined ? [] : [pack.manifest.id], games: game === undefined ? [] : [game] }
      })
      const capability = scriptsCapability(library, summaries, async id => {
        const setup = library.pendingSetup(id)
        if (setup === undefined) throw new Error(`${id} 没有等待运行的安装程序`)
        return handOff(setup)
      }, review, optimizer, new ExeIcons(join(spec.dataDir, 'icons')), integrations)
      scoped.adgGateway.register({
        ...capability,
        methods: Object.fromEntries(Object.entries(capability.methods).map(([name, handler]) => [name, async (params: unknown, call: Parameters<typeof handler>[1]) => {
          await this.ready
          return handler(params, call)
        }])),
      })
    })

    this.skillHub = startSkillHub(ctx, library, this.ready, approve, { info: message => log.info(message), warn: message => log.warn(message) })

    log.debug(`tools: ${Object.values(TOOL_NAMES).join(', ')}`)
  }
}

function stripUndefined<T extends object>(value: T): { [K in keyof T]?: Exclude<T[K], undefined> } {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as never
}

export default AdgScripts
