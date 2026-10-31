/**
 * `skill_save`: the agent writes what it just worked out as a skill, so the
 * next time the same thing is asked it follows the steps instead of finding
 * them again (fewer model calls). Skills are kept in this app's own data
 * (`<data>/skills/<name>/SKILL.md`) and registered with this app's agents —
 * not in a skill folder other agents on the machine read. A saved skill is
 * available at once and shows on the 技能 page; one saved for particular
 * scripts or games (`scripts` / `games` in its frontmatter) is seen only by
 * the sessions working on them (skill-scope.ts), the rest by every session.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'

const Args = z.object({
  name: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/, '小写字母、数字和短横线，例如 maa-daily-check').max(48),
  description: z.string().min(10).max(400),
  content: z.string().min(20).max(20_000),
  replace: z.boolean().nullish(),
  scripts: z.array(z.string().min(1).max(64)).max(20).nullish(),
  games: z.array(z.string().min(1).max(64)).max(20).nullish(),
})

export interface SkillSaveDeps {
  /** The user's skill folder. */
  readonly dir: string
  /** Names of skills that come from elsewhere (packs, the app): not to be shadowed. */
  readonly taken: () => Promise<readonly string[]>
  /** Called after a save: register it so the agents see it now. */
  readonly saved?: (name: string) => Promise<void>
}

export function skillSaveTool(deps: SkillSaveDeps): ToolDefinition {
  return {
    name: 'skill_save',
    description: [
      '把刚做成的一件事保存成技能（SKILL.md），下次同样的请求直接照着做，不用重新摸索、少调用模型。',
      'content 写浓缩后的做法：什么时候用；一步一步的操作（用到的工具、命令、路径、参数照实写）；判断成功的方法；踩过的坑和注意事项。不写这次对话的闲聊和失败的尝试过程，只写最后走通的路。',
      'description 一两句话写清楚「做什么、用户说什么时用」，agent 靠它决定什么时候调用。已有同名技能时先用 replace=true 才会覆盖。',
      '这次做的事是在操作某个脚本或某个游戏时，一定要填 scripts（脚本 id）或 games（游戏 id）：这样它只在处理这个脚本或游戏时出现，不会被拿去用在别的脚本、别的游戏上。通用的做法两个都不填。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        name: { type: 'string', description: '技能名：小写字母、数字、短横线，例如 maa-daily-check。' },
        description: { type: 'string', description: '做什么、什么时候用（10–400 字）。' },
        content: { type: 'string', description: 'Markdown 正文：适用场景、步骤、成功标准、注意事项。' },
        replace: { type: 'boolean', description: '覆盖已有的同名技能（可选）。' },
        scripts: { type: 'array', items: { type: 'string' }, description: '它属于哪些脚本（脚本 id，例如 maa）；只在处理这些脚本时可见。' },
        games: { type: 'array', items: { type: 'string' }, description: '它属于哪些游戏（游戏 id）；只在处理这些游戏或玩它们的脚本时可见。' },
      },
      required: ['name', 'description', 'content'],
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] },
    timeoutMs: 30_000,
    isConcurrencySafe: () => false,
    execute: async args => {
      const parsed = Args.safeParse(args)
      if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
      const { name, description, content, replace, scripts, games } = parsed.data
      if ((await deps.taken()).includes(name)) throw new Error(`「${name}」是脚本包或软件自带的技能，换一个名字`)
      const folder = join(deps.dir, name)
      const file = join(folder, 'SKILL.md')
      const existing = await readFile(file, 'utf8').catch(() => undefined)
      if (existing !== undefined && replace !== true) throw new Error(`已经有技能「${name}」（${file}）。要更新它就加 replace=true，或者换一个名字`)
      await mkdir(folder, { recursive: true })
      // JSON strings are valid YAML scalars: no quoting surprises in the description.
      const owner = [
        ...(scripts == null || scripts.length === 0 ? [] : [`scripts: ${JSON.stringify(scripts)}\n`]),
        ...(games == null || games.length === 0 ? [] : [`games: ${JSON.stringify(games)}\n`]),
      ].join('')
      await writeFile(file, `---\nname: ${name}\ndescription: ${JSON.stringify(description.replace(/\s+/g, ' ').trim())}\n${owner}---\n\n${content.trim()}\n`)
      await deps.saved?.(name)
      return { saved: file, replaced: existing !== undefined, note: '已保存，所有会话马上就能用；在「技能」页可以看到' } as never
    },
    presentCall: args => ({ card: 'generic', title: `保存技能：${String((args as Record<string, unknown> | undefined)?.['name'] ?? '')}`, kind: 'other' }),
  }
}

export interface SavedSkill {
  name: string
  description: string
  path: string
  content: string
  /** `scripts` / `games` from its frontmatter. */
  owner?: { scripts?: string[]; games?: string[] }
}

/**
 * The saved skills in `dir` (one folder per skill with its SKILL.md).
 */
export async function userSkills(dir: string): Promise<SavedSkill[]> {
  const { readdir } = await import('node:fs/promises')
  const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
  const out: SavedSkill[] = []
  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const path = join(dir, entry.name, 'SKILL.md')
    const text = await readFile(path, 'utf8').catch(() => undefined)
    const match = text === undefined ? null : /^\uFEFF?---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/.exec(text)
    if (match === null) continue
    const field = (key: string) => {
      const raw = new RegExp(`^${key}:[ \\t]*(.*)$`, 'm').exec(match[1]!)?.[1]?.trim()
      if (raw === undefined || raw === '') return undefined
      try { return raw.startsWith('"') ? String(JSON.parse(raw)) : raw.replace(/^'(.*)'$/, '$1') } catch { return raw }
    }
    // Written as JSON arrays (skill_save), which YAML reads the same.
    const list = (key: string) => {
      const raw = field(key)
      try {
        const value: unknown = raw === undefined ? undefined : JSON.parse(raw)
        return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : []
      } catch { return [] }
    }
    const name = field('name') ?? entry.name
    const description = field('description')
    if (description === undefined) continue
    const scripts = list('scripts')
    const games = list('games')
    const owner = scripts.length + games.length === 0 ? undefined : { ...(scripts.length === 0 ? {} : { scripts }), ...(games.length === 0 ? {} : { games }) }
    out.push({ name, description, path, content: match[2]!.trim(), ...(owner === undefined ? {} : { owner }) })
  }
  return out
}
