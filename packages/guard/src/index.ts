/**
 * @adg/guard — constraint 7 of the plan: without the user's explicit word,
 * the agent may only change a script through its declared config files and
 * official updates, never edit the script's own files.
 *
 * Hooks `tools/pre-execute` for every agent tool call and denies writes into
 * protected directories (each script's directories, and the whole tools
 * directory). The user lifts that for one script for a limited time from the
 * UI (`guard@1`); there is deliberately no agent tool for it. Full access
 * (设置 → 权限, served by the gateway) turns the guard off.
 */
import { Service, type Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-tools'
import type {} from '@adg/gateway'
import type {} from '@adg/script-registry'
import { GUARD_CAPABILITY, type GuardGrant, type RequestParams } from '@adg/protocol'
import { denialReason, judgeCall, type ProtectedDir } from './policy.ts'

export { denialReason, judgeCall, type CallFacts, type ProtectedDir, type Verdict } from './policy.ts'

declare module '@deepseek-ai/cordis' {
  interface Context {
    adgGuard: AdgGuard
  }
}

const TOOLS = '_tools'

export class AdgGuard extends Service {
  static inject = ['adgScripts']
  private readonly grantMap = new Map<string, GuardGrant & { dirs: string[] }>()
  private blocked = 0

  constructor(ctx: Context) {
    super(ctx, 'adgGuard')
    const log = ctx.logger('adg-guard')
    const scripts = ctx.adgScripts

    const dirs = (): { protectedDirs: ProtectedDir[]; allowed: string[] } => {
      const open = new Map(this.grants().map(g => [g.scriptId, g]))
      const protectedDirs: ProtectedDir[] = []
      for (const script of scripts.library.list().scripts) {
        if (open.has(script.id)) continue
        for (const version of script.versions) protectedDirs.push({ scriptId: script.id, dir: version.dir })
      }
      // Last, so a script's own entry names it; covers shared components and downloads too.
      protectedDirs.push({ scriptId: TOOLS, dir: scripts.library.toolsDir })
      return { protectedDirs, allowed: [...open.values()].flatMap(g => g.dirs) }
    }

    ctx.on('tools/pre-execute', async (exec, next) => {
      // Full access (设置 → 权限) is the user's explicit word for everything, scripts included.
      if (ctx.get('adgGateway')?.fullAccess() === true) return next()
      const { protectedDirs, allowed } = dirs()
      // dsh file tools take absolute paths; shells pass `workdir`, so no session cwd is needed here.
      const verdict = judgeCall({ toolName: exec.name, args: exec.arguments }, protectedDirs, allowed)
      if (verdict === undefined) return next()
      this.blocked += 1
      const name = verdict.scriptId === TOOLS ? '工具目录' : nameOf(verdict.scriptId)
      log.info(`blocked ${exec.name} on ${verdict.target}`)
      ctx.get('adgGateway')?.broadcast('guard/blocked', { toolName: exec.name, target: verdict.target, at: Date.now(), ...(exec.agent === undefined ? {} : { sessionId: exec.agent.session.id }) })
      return { kind: 'deny', reason: denialReason(verdict, name) }
    }, true)

    const nameOf = (id: string) => {
      try { return scripts.library.get(id).name } catch { return id }
    }

    ctx.inject(['adgGateway'], scoped => {
      scoped.adgGateway.register({
        id: GUARD_CAPABILITY,
        version: 1,
        methods: {
          'guard/grants': () => ({ items: this.grants().map(({ dirs: _dirs, ...grant }) => grant), blocked: this.blocked }),
          'guard/grant': params => {
            const p = params as RequestParams<'guard/grant'>
            const script = scripts.library.get(p.scriptId)
            const now = Date.now()
            const grant = { scriptId: p.scriptId, dir: script.dir ?? '', grantedAt: now, expiresAt: now + p.minutes * 60_000, dirs: script.versions.map(v => v.dir) }
            this.grantMap.set(p.scriptId, grant)
            log.info(`user granted file changes on ${p.scriptId} for ${p.minutes} min`)
            scoped.adgGateway.broadcast('guard/changed', {})
            const { dirs: _dirs, ...shown } = grant
            return shown
          },
          'guard/revoke': params => {
            this.grantMap.delete((params as RequestParams<'guard/revoke'>).scriptId)
            scoped.adgGateway.broadcast('guard/changed', {})
            return {}
          },
        },
      })
    })
  }

  /** Grants still in force. */
  grants(): (GuardGrant & { dirs: string[] })[] {
    const now = Date.now()
    for (const [id, grant] of this.grantMap) if (grant.expiresAt <= now) this.grantMap.delete(id)
    return [...this.grantMap.values()]
  }
}

export default AdgGuard
