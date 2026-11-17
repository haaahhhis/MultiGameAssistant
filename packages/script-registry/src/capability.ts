/**
 * `scripts@1` gateway capability. The UI acts on the user's explicit click,
 * so these methods do not ask for approval; the agent tools do.
 */
import type { CapabilityRegistration } from '@adg/gateway'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { guideView } from '@adg/pack-schema'
import { ExeIcons } from '@adg/protocol/node'
import { SCRIPTS_CAPABILITY, type RequestParams } from '@adg/protocol'
import type { ScriptLibrary } from './library.ts'
import type { PackReview } from './pack-review.ts'
import type { Optimizer } from './optimize.ts'

/**
 * @param setupAgent - hand a waiting setup program to the agent; @returns its conversation.
 * @param review - answer whether to check a pack after its script updated (pack-review.ts).
 * @param optimizer - 优化脚本 (optimize.ts).
 * @param icons - programs' icons, for the scripts' avatars.
 */
export function scriptsCapability(library: ScriptLibrary, summaries: { summarize(id: string): Promise<string> }, setupAgent: (id: string) => Promise<string>, review: PackReview, optimizer: Optimizer, icons?: ExeIcons): CapabilityRegistration {
  return {
    id: SCRIPTS_CAPABILITY,
    version: 1,
    methods: {
      'scripts/list': () => library.list(),
      'scripts/get': params => library.get((params as RequestParams<'scripts/get'>).id),
      'scripts/guide': params => {
        const pack = library.packOf((params as RequestParams<'scripts/guide'>).id)
        return { guide: pack === undefined ? null : guideView(pack.manifest, { builtin: pack.builtin }) }
      },
      'scripts/icon': async (params, call) => {
        const id = (params as RequestParams<'scripts/icon'>).id
        const program = scriptProgram(library, id)
        if (program === undefined || icons === undefined || process.platform !== 'win32') return {}
        try {
          return { icon: { mediaType: 'image/png', data: (await icons.png(program, call.signal)).toString('base64') } }
        } catch {
          return {}
        }
      },
      'scripts/search': (params, call) => library.search((params as RequestParams<'scripts/search'>).query, call.signal),
      'scripts/releases': (params, call) => {
        const p = params as RequestParams<'scripts/releases'>
        return library.releases(p.repo, p.limit ?? 10, call.signal)
      },
      'scripts/install': async (params, call) => {
        const p = params as RequestParams<'scripts/install'>
        const mirror = p.mirrorchyan === undefined ? undefined : await library.lookupMirror(p.mirrorchyan, call.signal)
        const { job } = library.install(mirror === undefined
          ? { repo: p.repo, tag: p.tag, asset: p.asset, branch: p.branch, id: p.id }
          : { mirrorchyan: mirror, id: p.id })
        return { jobId: job.id, scriptId: job.scriptId }
      },
      'scripts/checkUpdate': (params, call) => library.checkUpdate((params as RequestParams<'scripts/checkUpdate'>).id, call.signal),
      'scripts/update': async (params, call) => {
        const result = await library.update((params as RequestParams<'scripts/update'>).id, call.signal)
        return result.upToDate ? { upToDate: true } : { upToDate: false, jobId: result.job.id }
      },
      'scripts/rollback': params => {
        const p = params as RequestParams<'scripts/rollback'>
        return library.rollback(p.id, p.version)
      },
      'scripts/source/set': async (params, call) => {
        const p = params as RequestParams<'scripts/source/set'>
        // A resource id is looked up first: it must exist, and whether it is uploaded per platform is learned.
        const mirrorchyan = typeof p.mirrorchyan === 'string' ? await library.lookupMirror(p.mirrorchyan, call.signal) : p.mirrorchyan
        return library.setUpdateSource(p.id, { repo: p.repo, mirrorchyan, reset: p.reset })
      },
      'scripts/mirrorchyan/search': (params, call) => library.searchMirror((params as RequestParams<'scripts/mirrorchyan/search'>).query, call.signal),
      'scripts/mirrorchyan/match': (params, call) => library.matchMirror((params as RequestParams<'scripts/mirrorchyan/match'>).id, call.signal),
      'scripts/mirrorchyan/lookup': (params, call) => library.lookupMirror((params as RequestParams<'scripts/mirrorchyan/lookup'>).rid, call.signal),
      'scripts/restore': params => library.restore((params as RequestParams<'scripts/restore'>).id),
      'scripts/packReview': params => {
        const p = params as RequestParams<'scripts/packReview'>
        return review.decide(p.id, p.decision)
      },
      'scripts/setup/open': async params => {
        const { dir } = await library.runSetup((params as RequestParams<'scripts/setup/open'>).id, { quiet: false })
        return { dir }
      },
      'scripts/setup/agent': async params => ({ sessionId: await setupAgent((params as RequestParams<'scripts/setup/agent'>).id) }),
      'scripts/setup/discard': async params => {
        await library.discardSetup((params as RequestParams<'scripts/setup/discard'>).id)
        return {}
      },
      'scripts/import': params => {
        const p = params as RequestParams<'scripts/import'>
        return library.import({ path: p.path, id: p.id, name: p.name, packId: p.packId })
      },
      'scripts/remove': async params => {
        const p = params as RequestParams<'scripts/remove'>
        await library.remove(p.id, p.deleteFiles === true)
        return {}
      },
      'scripts/envCheck': params => library.envCheck((params as RequestParams<'scripts/envCheck'>).id),
      'scripts/envFix': async params => {
        const p = params as RequestParams<'scripts/envFix'>
        const plan = await library.envFixPlan(p.id, p.kind)
        if (plan === undefined) throw new Error('这一项已经满足，无需处理')
        if (plan.kind === 'manual') throw new Error(plan.description)
        return { jobId: library.envFix(p.id, p.kind, plan).job.id }
      },
      'scripts/jobs': () => ({ items: library.jobs() }),
      'scripts/jobs/cancel': params => {
        library.cancelJob((params as RequestParams<'scripts/jobs/cancel'>).jobId)
        return {}
      },
      'scripts/settings': () => library.settings(),
      'scripts/settings/set': params => library.setSettings(params as RequestParams<'scripts/settings/set'>),
      'scripts/mirrorchyan/check': (_params, call) => library.checkMirrorCdk(call.signal),
      'scripts/optimize': async params => {
        const p = params as RequestParams<'scripts/optimize'>
        return optimizer.decide(p.id, p.decision, '你')
      },
      'scripts/summarize': async params => ({ sessionId: await summaries.summarize((params as RequestParams<'scripts/summarize'>).id) }),
    },
  }
}

/** An installed script's program: the one its pack opens for its settings (a launcher has the app's icon), else the one it runs. */
function scriptProgram(library: ScriptLibrary, id: string): string | undefined {
  let info, pack
  try { info = library.get(id); pack = library.packOf(id) } catch { return undefined }
  const launch = pack?.manifest.launch
  if (info.dir === undefined || launch === undefined) return undefined
  for (const exe of [launch.settings?.exe, launch.exe]) {
    if (exe === undefined) continue
    const path = join(info.dir, launch.cwd ?? '', exe)
    if (existsSync(path)) return path
    if (existsSync(join(info.dir, exe))) return join(info.dir, exe)
  }
  return undefined
}
