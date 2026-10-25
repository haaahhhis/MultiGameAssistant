/**
 * `scripts@1` gateway capability. The UI acts on the user's explicit click,
 * so these methods do not ask for approval; the agent tools do.
 */
import type { CapabilityRegistration } from '@adg/gateway'
import { SCRIPTS_CAPABILITY, type RequestParams } from '@adg/protocol'
import type { ScriptLibrary } from './library.ts'

export function scriptsCapability(library: ScriptLibrary): CapabilityRegistration {
  return {
    id: SCRIPTS_CAPABILITY,
    version: 1,
    methods: {
      'scripts/list': () => library.list(),
      'scripts/get': params => library.get((params as RequestParams<'scripts/get'>).id),
      'scripts/search': (params, call) => library.search((params as RequestParams<'scripts/search'>).query, call.signal),
      'scripts/releases': (params, call) => {
        const p = params as RequestParams<'scripts/releases'>
        return library.releases(p.repo, p.limit ?? 10, call.signal)
      },
      'scripts/install': params => {
        const p = params as RequestParams<'scripts/install'>
        const { job } = library.install({ repo: p.repo, tag: p.tag, asset: p.asset, id: p.id })
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
      'scripts/source/set': params => {
        const p = params as RequestParams<'scripts/source/set'>
        return library.setUpdateSource(p.id, p.repo)
      },
      'scripts/restore': params => library.restore((params as RequestParams<'scripts/restore'>).id),
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
    },
  }
}
