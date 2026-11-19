/**
 * The skills repository inside the host: its downloaded skills registered
 * with the agents, the `skillhub@1` capability for the 技能 page, and the
 * agent tools.
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-skill'
import type { CapabilityRegistration } from '@adg/gateway'
import { pluginVersion } from '@adg/gateway'
import { SKILLHUB_CAPABILITY, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import type { ScriptLibrary } from './library.ts'
import { SkillHub } from './skill-hub.ts'
import type { Approve } from './tools.ts'

/** Where each kind of skill comes from, in the words of "已有同名的…". */
function takenLabel(source: string): string {
  if (source === 'bundled') return '核心技能'
  if (source === 'custom') return '技能（你保存的或脚本包、游戏包的）'
  if (source.startsWith('user-')) return '技能（你的技能文件夹）'
  return '技能'
}

/** Try again after this long to get back a script's pack the library lost (offline, the repository unreadable). */
const RESTORE_RETRY_MS = 30 * 60_000

export function startSkillHub(ctx: Context, library: ScriptLibrary, ready: Promise<void>, approve: Approve, log: { info(m: string): void; warn(m: string): void }): SkillHub {
  const entries = new Map<string, { description: string; content: string; path: string; dir: string; owner?: { games?: string[]; scripts?: string[] }; pack?: 'script' | 'game' }>()
  const disposers = new Map<string, () => void>()
  let skills: Context['skills'] | undefined
  const changed = () => ctx.get('adgGateway')?.broadcast('skillhub/changed', {})
  // What the 技能 page lists changed too (a skill came, went or changed).
  const skillsChanged = () => { changed(); ctx.get('adgGateway')?.broadcast('skills/changed', {}) }

  const apply = (name: string) => {
    disposers.get(name)?.()
    disposers.delete(name)
    const entry = entries.get(name)
    const scope = ctx.get('adgGateway')?.skillScope
    if (entry === undefined || scope === undefined) return
    try {
      const kind = entry.pack === 'script' ? 'script-pack' : entry.pack === 'game' ? 'game-pack' : undefined
      disposers.set(name, scope.register({ name, description: entry.description, content: entry.content, source: 'hub', path: entry.path, resourceBase: { kind: 'directory', path: entry.dir }, ...(entry.owner === undefined ? {} : { owner: entry.owner }), ...(kind === undefined ? {} : { kind }) }))
    } catch (error) {
      log.warn(`skill hub: ${name} not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  // A downloaded script pack is the library's (its packs are read from the hub's folder); a game pack the game page's.
  const packsChanged = (kinds: ReadonlySet<'script' | 'game'>) => {
    const gateway = ctx.get('adgGateway')
    if (kinds.has('script')) void library.reloadPacks().then(() => gateway?.broadcast('scripts/changed', {}), error => log.warn(`packs not read again: ${error instanceof Error ? error.message : String(error)}`))
    if (kinds.has('game')) gateway?.broadcast('games/changed', {})
  }

  const hub = new SkillHub({
    packsChanged,
    dir: join(library.dataDir, 'skill-hub'),
    download: (url, dest, signal) => library.downloadFromGitHub(url, dest, signal),
    extract: async (archive, dest, signal) => { await library.unpack(archive, dest, signal) },
    taken: async () => {
      const out = new Map<string, string>()
      for (const skill of await skills?.list({}) ?? []) if (skill.source !== 'hub') out.set(skill.name, takenLabel(skill.source))
      return out
    },
    register: (name, skill) => {
      if (skill === undefined) entries.delete(name)
      else entries.set(name, skill)
      apply(name)
    },
    // For a skill's `requires`: the desktop app passes its version; the dsh plugin has it in its manifest; from source, none.
    appVersion: () => process.env['ADG_APP_VERSION'] || pluginVersion(),
    log,
  })
  // The library read the hub's packs before the hub knew where each came from (which are trusted): read them again.
  const started = ready.then(() => hub.start()).then(() => library.reloadPacks())

  // A script installed from a pack the app used to ship (or one whose pack went with a repository change) gets
  // its pack back from the 技能库: it was in use. Nothing else is downloaded without the user saying so.
  ctx.effect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined
    const stop = new AbortController()
    const restore = () => {
      void started.then(async () => {
        const lost = [...new Set(library.list().scripts.map(s => s.packId).filter((id): id is string => id !== undefined && library.pack(id) === undefined))]
        if (lost.length === 0) return []
        const { items } = await hub.list({ signal: stop.signal })
        const names: string[] = []
        for (const id of lost) {
          const item = items.find(i => i.name === id && i.pack === 'script' && i.installed === undefined && i.blocked === undefined && i.incompatible === undefined)
          if (item === undefined) continue
          await hub.install(id, item.repo, stop.signal)
          names.push(id)
        }
        if (names.length > 0) log.info(`skill hub: got back the packs of installed scripts: ${names.join(', ')}`)
        return names
      }).then(names => { if (names.length > 0) skillsChanged() }, error => {
        if (stop.signal.aborted) return
        log.warn(`skill hub: packs of installed scripts not got back: ${error instanceof Error ? error.message : String(error)}`)
        timer = setTimeout(restore, RESTORE_RETRY_MS)
        timer.unref?.()
      })
    }
    restore()
    return () => { stop.abort(); clearTimeout(timer) }
  }, 'adg-skill-hub restore packs')

  // Registered through the gateway's skill scope (skill isolation); the registry itself only answers what is taken.
  ctx.inject(['skills', 'adgGateway'], scoped => {
    skills = scoped.skills
    for (const name of entries.keys()) apply(name)
    scoped.effect(() => () => {
      for (const dispose of disposers.values()) dispose()
      disposers.clear()
      skills = undefined
    }, 'adg-skill-hub skills')
  })

  ctx.inject(['adgGateway'], scoped => {
    const methods: CapabilityRegistration['methods'] = {
      'skillhub/list': (params, call) => hub.list({ refresh: (params as RequestParams<'skillhub/list'>).refresh === true, signal: call.signal }),
      'skillhub/install': async (params, call) => {
        const p = params as RequestParams<'skillhub/install'>
        const item = await hub.install(p.name, p.repo, call.signal)
        skillsChanged()
        return item
      },
      'skillhub/update': async (params, call) => {
        const result = await hub.update((params as RequestParams<'skillhub/update'>).name, call.signal)
        skillsChanged()
        return result
      },
      'skillhub/rollback': async params => {
        const item = await hub.rollback((params as RequestParams<'skillhub/rollback'>).name)
        skillsChanged()
        return item
      },
      'skillhub/remove': async params => {
        await hub.remove((params as RequestParams<'skillhub/remove'>).name)
        skillsChanged()
        return {}
      },
      'skillhub/preview': async params => ({ content: await hub.preview((params as RequestParams<'skillhub/preview'>).name) }),
      'skillhub/save': async params => {
        const p = params as RequestParams<'skillhub/save'>
        await hub.save(p.name, p.description, p.content)
        skillsChanged()
        return {}
      },
      'skillhub/owner': async params => {
        const p = params as RequestParams<'skillhub/owner'>
        await hub.setOwner(p.name, p.owner)
        skillsChanged()
        return {}
      },
      'skillhub/repos/set': async params => {
        const repos = await hub.setRepos((params as RequestParams<'skillhub/repos/set'>).repos)
        changed()
        return { repos }
      },
    }
    scoped.adgGateway.register({
      id: SKILLHUB_CAPABILITY,
      version: 1,
      methods: Object.fromEntries(Object.entries(methods).map(([name, handler]) => [name, async (params: unknown, call: Parameters<typeof handler>[1]) => {
        await started
        return handler(params, call)
      }])),
    })
  })

  ctx.inject(['adgGateway'], gateway => gateway.adgGateway.agentPart('adg-skill-hub tools', agent => {
    const registered: Array<() => void> = []
    for (const tool of hubTools(hub, approve, changed)) {
      registered.push(agent.tools.register({ ...tool, execute: async (args, exec) => { await started; await ctx.get('adgGateway')?.guardTool(exec); return tool.execute(args, exec) } }))
    }
    return () => { for (const dispose of registered) dispose() }
  }))

  return hub
}

function hubTools(hub: SkillHub, approve: Approve, changed: () => void): ToolDefinition[] {
  const render = (_args: unknown, value: unknown) => [{ type: 'text' as const, text: JSON.stringify(value, null, 1) }]
  return [
    {
      name: 'skill_hub_list',
      description: '查看技能库（MultiGameAssistant/skills 等 GitHub 仓库）里有哪些游戏和脚本的技能、哪些已经下载、哪些有新版本。可以按游戏 id 或脚本 id 筛选。',
      parameters: {
        type: 'object',
        properties: {
          game: { type: 'string', description: '游戏 id（game_list 可查），只看它的技能。' },
          script: { type: 'string', description: '脚本或脚本包 id，只看它的技能。' },
        },
        additionalProperties: false,
      },
      output: { schema: {}, render },
      timeoutMs: 120_000,
      isConcurrencySafe: () => true,
      execute: async args => {
        const a = z.object({ game: z.string().nullish(), script: z.string().nullish() }).parse(args ?? {})
        const { items, errors } = await hub.list()
        const shown = items.filter(i => (a.game == null || i.games.includes(a.game)) && (a.script == null || i.scripts.includes(a.script)))
        return {
          errors,
          skills: shown.map(i => ({ name: i.name, description: i.description, kind: i.kind, games: i.games, scripts: i.scripts, repo: i.repo, version: i.version, changes: i.changes, installed: i.installed, blocked: i.blocked, incompatible: i.incompatible })),
        }
      },
      presentCall: () => ({ card: 'generic', title: '查看技能库', kind: 'read' }),
    },
    {
      name: 'skill_hub_install',
      description: '从技能库下载一个技能（会先请用户确认）。下载后 agent 马上就能用；下载的技能跟着技能库走，更新时整个换成技能库的新版本，在这里改的不保留。',
      parameters: {
        type: 'object',
        properties: { name: { type: 'string', description: '技能名（skill_hub_list 可查）。' } },
        required: ['name'],
        additionalProperties: false,
      },
      output: { schema: {}, render },
      timeoutMs: 120_000,
      isConcurrencySafe: () => false,
      execute: async (args, exec) => {
        const { name } = z.object({ name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/) }).parse(args)
        const { items } = await hub.list()
        const item = items.find(i => i.name === name)
        if (item === undefined) throw new Error(`技能库里没有「${name}」`)
        if (item.installed !== undefined) return { ok: true, already: true, name }
        if (item.blocked !== undefined) throw new Error(`${item.blocked}「${name}」，不能下载`)
        await approve(exec, `从技能库 ${item.repo} 下载技能「${name}」：${item.description}`)
        await hub.install(name, item.repo, exec.signal)
        changed()
        return { ok: true, name }
      },
      presentCall: args => ({ card: 'generic', title: `下载技能：${String((args as { name?: unknown } | undefined)?.name ?? '')}`, kind: 'execute' }),
    },
  ]
}
