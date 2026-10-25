/**
 * @adg/script-registry — the script library as a Cordis service (`ctx.adgScripts`).
 *
 * Contributes, each only while its host service is mounted:
 * - agent tools `script_*` (install, update, rollback, import, env check/fix…);
 * - the `scripts@1` gateway capability for the UI's script library page;
 * - the skills repository (技能库, `skillhub@1` and `skill_hub_*` tools).
 *
 * Script Packs come from `@adg/packs` (built in) and `<dataDir>/packs` (the
 * user's, overriding built-ins by id). SKILL.md registration into the agent's
 * skill catalog arrives with the analyzer (M2).
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type { CredentialRef } from '@deepseek-ai/dsh-credentials'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-user-approval/types'
import type {} from '@adg/gateway'
import { PACKS_DIR } from '@adg/packs'
import { InstallSettings } from '@adg/protocol'
import { z } from 'zod'
import { scriptsCapability } from './capability.ts'
import { ScriptLibrary } from './library.ts'
import { startSkillHub } from './skill-hub-plugin.ts'
import { scriptSummaries } from './script-summary.ts'
import type { SkillHub } from './skill-hub.ts'
import { scriptTools, TOOL_NAMES, type Approve } from './tools.ts'

export { ScriptLibrary, type InstallRequest, type LibraryOptions } from './library.ts'
export { loadPacks, packForRepo, type LoadedPack, type PackDir } from './packs.ts'
export { TOOL_NAMES } from './tools.ts'
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
  /** Library state (`scripts.json`) and the user's packs (`packs/`). */
  dataDir: z.string().min(1),
  /** Built-in pack directories; default: the `@adg/packs` package. */
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

  constructor(ctx: Context, config: Config) {
    super(ctx, 'adgScripts')
    const parsed = ConfigSchema.safeParse(config)
    if (!parsed.success) throw new Error(`adg-script-registry: invalid config: ${parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`).join('; ')}`)
    const spec = parsed.data
    const log = ctx.logger('adg-scripts')
    const ref = (value: string) => value as CredentialRef

    this.library = new ScriptLibrary({
      toolsDir: spec.toolsDir,
      dataDir: spec.dataDir,
      packDirs: spec.packDirs ?? [PACKS_DIR],
      ...(spec.defaults === undefined ? {} : { defaults: stripUndefined(spec.defaults) }),
      credential: async name => (await ctx.get('credentials')?.resolve(ref(name)))?.value,
      credentialConfigured: async name => (await ctx.get('credentials')?.describe(ref(name)))?.configured ?? false,
      onChanged: id => ctx.get('adgGateway')?.broadcast('scripts/changed', id === undefined ? {} : { id }),
      onJob: job => ctx.get('adgGateway')?.broadcast('scripts/job', job),
      log: { info: message => log.info(message), warn: message => log.warn(message) },
    })
    const library = this.library
    this.ready = library.start()
    this.ready.then(
      () => log.info(`script library ready: ${library.list().scripts.length} script(s), tools in ${library.toolsDir}`),
      error => log.error(`script library failed to load: ${error instanceof Error ? error.message : String(error)}`),
    )
    ctx.effect(() => () => library.dispose(), 'adg-scripts jobs')

    const approve: Approve = async (exec, reason) => {
      const approval = ctx.get('approval')
      if (approval === undefined || exec.agent === undefined) throw new Error('这个操作需要用户批准，但当前没有可用的审批渠道')
      const outcome = await approval.request({ agent: exec.agent, toolName: exec.name, callId: exec.callId, reason, signal: exec.signal })
      if (outcome !== 'allowed-once') throw new Error(outcome === 'rejected' ? '用户拒绝了这个操作' : `没有得到用户批准（${outcome}）`)
    }

    ctx.inject(['tools'], scoped => {
      for (const tool of scriptTools(library, approve)) {
        scoped.tools.register({ ...tool, execute: async (args, exec) => { await this.ready; await ctx.get('adgGateway')?.guardTool(exec); return tool.execute(args, exec) } })
      }
    })

    const summaries = scriptSummaries(ctx, library, { warn: message => log.warn(message) })
    ctx.inject(['adgGateway'], scoped => {
      const capability = scriptsCapability(library, summaries)
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
