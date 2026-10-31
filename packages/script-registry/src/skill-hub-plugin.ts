/**
 * The skills repository inside the host: its downloaded skills registered
 * with the agents, the `skillhub@1` capability for the 技能 page, the agent
 * tools, and merging a changed skill with a newer one through the agent.
 */
import { join } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-api-session-controller'
import type {} from '@deepseek-ai/dsh-skill'
import type { CapabilityRegistration } from '@adg/gateway'
import { sessionConversations } from '@adg/notify'
import { SKILLHUB_CAPABILITY, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import type { ScriptLibrary } from './library.ts'
import { SkillHub, type HubItem } from './skill-hub.ts'
import type { Approve } from './tools.ts'

/** Where each kind of skill comes from, in the words of "已有同名的…". */
function takenLabel(source: string): string {
  if (source === 'bundled') return '内置技能'
  if (source === 'custom') return '技能（你保存的或脚本包、游戏包的）'
  if (source.startsWith('user-')) return '技能（你的技能文件夹）'
  return '技能'
}

const MERGE_TIMEOUT_MS = 10 * 60_000

export function startSkillHub(ctx: Context, library: ScriptLibrary, ready: Promise<void>, approve: Approve, log: { info(m: string): void; warn(m: string): void }): SkillHub {
  const entries = new Map<string, { description: string; content: string; path: string; dir: string; owner?: { games?: string[]; scripts?: string[] } }>()
  const disposers = new Map<string, () => void>()
  let skills: Context['skills'] | undefined
  const changed = () => ctx.get('adgGateway')?.broadcast('skillhub/changed', {})

  const apply = (name: string) => {
    disposers.get(name)?.()
    disposers.delete(name)
    const entry = entries.get(name)
    const scope = ctx.get('adgGateway')?.skillScope
    if (entry === undefined || scope === undefined) return
    try {
      disposers.set(name, scope.register({ name, description: entry.description, content: entry.content, source: 'hub', path: entry.path, resourceBase: { kind: 'directory', path: entry.dir }, ...(entry.owner === undefined ? {} : { owner: entry.owner }) }))
    } catch (error) {
      log.warn(`skill hub: ${name} not registered: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  const hub = new SkillHub({
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
    log,
  })
  const started = ready.then(() => hub.start())

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

  /** Have the agent merge the repository's newer version into the user's changed skill. */
  const merge = async (name: string, signal?: AbortSignal): Promise<{ sessionId: string; item: HubItem }> => {
    const sessions = ctx.get('sessionController')
    if (sessions === undefined) throw new Error('agent 现在不可用（会话服务没有加载）')
    const { base, mine, theirs, file, skill } = await hub.mergeInputs(name, signal)
    const conversations = sessionConversations(sessions, () => ctx.get('adgGateway')?.workspaceDir())
    const sessionId = await conversations.create(`合并技能：${name}`)
    const prompt = [
      `技能库里的技能「${name}」有了新版本，但用户改过自己的这份。把新版本的改动合并进用户的版本，写回 ${file}（只改这一个文件）。`,
      '规则：用户改过的地方保留用户的；新版本新增或修正、用户没碰过的地方用新版本的；两边改了同一处时以用户的为主，把新版本里有用的信息补进去。保持开头的 frontmatter（name 不变）。写完用一两句话说明合并了什么、哪里两边冲突以及怎么处理的。',
      '',
      '下载时的版本（共同的起点）：',
      '```markdown', base, '```',
      '用户现在的版本：',
      '```markdown', mine, '```',
      '技能库的新版本：',
      '```markdown', theirs, '```',
    ].join('\n')
    void conversations.ask(sessionId, prompt, AbortSignal.timeout(MERGE_TIMEOUT_MS)).then(
      async () => { await hub.merged(name, skill); changed() },
      error => log.warn(`skill hub: merging ${name} failed: ${error instanceof Error ? error.message : String(error)}`),
    )
    const { items } = await hub.list()
    return { sessionId, item: items.find(i => i.name === name)! }
  }

  ctx.inject(['adgGateway'], scoped => {
    const methods: CapabilityRegistration['methods'] = {
      'skillhub/list': (params, call) => hub.list({ refresh: (params as RequestParams<'skillhub/list'>).refresh === true, signal: call.signal }),
      'skillhub/install': async (params, call) => {
        const p = params as RequestParams<'skillhub/install'>
        const item = await hub.install(p.name, p.repo, call.signal)
        changed()
        return item
      },
      'skillhub/update': async (params, call) => {
        const p = params as RequestParams<'skillhub/update'>
        if (p.resolve === 'merge') return { state: 'merging', ...(await merge(p.name, call.signal)) }
        const result = await hub.update(p.name, p.resolve, call.signal)
        changed()
        return result
      },
      'skillhub/diff': (params, call) => hub.diff((params as RequestParams<'skillhub/diff'>).name, call.signal),
      'skillhub/remove': async params => {
        await hub.remove((params as RequestParams<'skillhub/remove'>).name)
        changed()
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

  ctx.inject(['tools'], scoped => {
    for (const tool of hubTools(hub, approve, changed)) {
      scoped.tools.register({ ...tool, execute: async (args, exec) => { await started; await ctx.get('adgGateway')?.guardTool(exec); return tool.execute(args, exec) } })
    }
  })

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
          skills: shown.map(i => ({ name: i.name, description: i.description, kind: i.kind, games: i.games, scripts: i.scripts, repo: i.repo, installed: i.installed, blocked: i.blocked })),
        }
      },
      presentCall: () => ({ card: 'generic', title: '查看技能库', kind: 'read' }),
    },
    {
      name: 'skill_hub_install',
      description: '从技能库下载一个技能（会先请用户确认）。下载后 agent 马上就能用；下载的技能放在数据目录里，可以改，更新时不会覆盖改动。',
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
