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
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import { MAX_SKILL_NAME, SKILL_NAME } from '@adg/protocol'

const Args = z.object({
  name: z.string().regex(SKILL_NAME, '小写字母、数字和短横线，例如 maa-daily-check').max(MAX_SKILL_NAME),
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

/** What a skill is saved with (the tool's arguments, or the 技能 page's form). */
export type SkillInput = z.input<typeof Args>

/** Write `<dir>/<name>/SKILL.md` and register it. */
export async function saveSkill(deps: SkillSaveDeps, input: unknown): Promise<{ saved: string; replaced: boolean }> {
  const parsed = Args.safeParse(input)
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
  return { saved: file, replaced: existing !== undefined }
}

/** Where an imported skill came from: kept in `<dir>/.imported.json`, not in its folder (whose fingerprint says whether it was changed here). */
export interface ImportedSkill {
  readonly name: string
  /** What it came from, e.g. `{ kind: 'script', script: 'maa', path: 'skills/daily', hash, version }`. */
  readonly origin: Readonly<Record<string, unknown>> & { readonly kind: string }
  /** Fingerprint of the copy as it was written: another one now means it was changed here. */
  readonly copyHash: string
  readonly at: number
}

export interface SkillImport {
  readonly name: string
  readonly description: string
  /** The folder to copy (its SKILL.md and everything beside it), or with `single` only its SKILL.md. */
  readonly from: string
  readonly single?: boolean
  readonly scripts?: readonly string[]
  readonly games?: readonly string[]
  readonly origin: ImportedSkill['origin']
  /** A name to use when `name` is taken by a skill from elsewhere (e.g. `<script>-<name>`). */
  readonly fallbackName?: string
}

const IMPORTED = '.imported.json'
const SKIPPED = /^(node_modules|__pycache__|\.git)$/

/** The imported skills still in `dir`. */
export async function importedSkills(dir: string): Promise<ImportedSkill[]> {
  const saved = await readFile(join(dir, IMPORTED), 'utf8').then(text => JSON.parse(text) as unknown, () => [])
  if (!Array.isArray(saved)) return []
  const out: ImportedSkill[] = []
  for (const item of saved as ImportedSkill[]) {
    if (typeof item?.name !== 'string' || !SKILL_NAME.test(item.name) || typeof item.origin?.kind !== 'string') continue
    if (await readFile(join(dir, item.name, 'SKILL.md'), 'utf8').then(() => true, () => false)) out.push(item)
  }
  return out
}

/**
 * Copy a skill from elsewhere (a script's own skills) into `dir` as one of
 * this app's skills, with the owner given; the same origin imported again
 * replaces its copy. @returns the name it was saved under.
 */
export async function importSkill(deps: SkillSaveDeps, input: SkillImport): Promise<{ name: string; saved: string; replaced: boolean }> {
  const { cp, mkdir: mkdirp, rm: remove } = await import('node:fs/promises')
  const imported = await importedSkills(deps.dir)
  const sameOrigin = (item: ImportedSkill) => JSON.stringify([item.origin.kind, item.origin['script'], item.origin['path']]) === JSON.stringify([input.origin.kind, input.origin['script'], input.origin['path']])
  const taken = await deps.taken()
  const usable = async (name: string) => {
    if (!SKILL_NAME.test(name) || name.length > MAX_SKILL_NAME || taken.includes(name)) return false
    const exists = await readFile(join(deps.dir, name, 'SKILL.md'), 'utf8').then(() => true, () => false)
    return !exists || imported.some(item => item.name === name && sameOrigin(item))
  }
  const previous = imported.find(sameOrigin)
  const candidates = [...(previous === undefined ? [] : [previous.name]), input.name, ...(input.fallbackName === undefined ? [] : [input.fallbackName])]
  let name: string | undefined
  for (const candidate of candidates) if (await usable(candidate)) { name = candidate; break }
  if (name === undefined) throw new Error(`技能名「${input.name}」已经被别的技能用了`)
  const folder = join(deps.dir, name)
  const replaced = await readFile(join(folder, 'SKILL.md'), 'utf8').then(() => true, () => false)
  const text = await readFile(input.single === true ? input.from : join(input.from, 'SKILL.md'), 'utf8')
  const body = /^﻿?---\r?\n[\s\S]*?\r?\n---\r?\n?([\s\S]*)$/.exec(text)?.[1] ?? text
  await remove(folder, { recursive: true, force: true })
  await mkdirp(folder, { recursive: true })
  if (input.single !== true) await cp(input.from, folder, { recursive: true, filter: source => !SKIPPED.test(source.split(/[\\/]/).pop() ?? '') })
  const owner = [
    ...(input.scripts === undefined || input.scripts.length === 0 ? [] : [`scripts: ${JSON.stringify(input.scripts)}\n`]),
    ...(input.games === undefined || input.games.length === 0 ? [] : [`games: ${JSON.stringify(input.games)}\n`]),
  ].join('')
  await writeFile(join(folder, 'SKILL.md'), `---\nname: ${name}\ndescription: ${JSON.stringify(input.description.replace(/\s+/g, ' ').trim())}\n${owner}---\n\n${body.trim()}\n`)
  const record: ImportedSkill = { name, origin: input.origin, copyHash: await copyHash(folder), at: Date.now() }
  const rest = imported.filter(item => item.name !== name && !sameOrigin(item))
  await writeFile(join(deps.dir, IMPORTED), `${JSON.stringify([...rest, record], null, 1)}\n`)
  await deps.saved?.(name)
  return { name, saved: join(folder, 'SKILL.md'), replaced }
}

/** Whether an imported skill's folder is still as it was written (not changed on the 技能 page or by the agent). */
export async function importUnchanged(dir: string, item: ImportedSkill): Promise<boolean> {
  return await copyHash(join(dir, item.name)).catch(() => '') === item.copyHash
}

async function copyHash(folder: string): Promise<string> {
  const { createHash } = await import('node:crypto')
  const { readdir } = await import('node:fs/promises')
  const files: string[] = []
  const walk = async (sub: string): Promise<void> => {
    for (const entry of await readdir(join(folder, sub), { withFileTypes: true })) {
      const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
      if (entry.isDirectory()) { if (!SKIPPED.test(entry.name)) await walk(rel) } else if (entry.isFile()) files.push(rel)
    }
  }
  await walk('')
  const digest = createHash('sha256')
  for (const rel of files.sort()) digest.update(rel).update('\0').update(await readFile(join(folder, ...rel.split('/')))).update('\0')
  return digest.digest('hex').slice(0, 16)
}

/** Delete `<dir>/<name>/`; false when there is no such saved skill. */
export async function removeSkill(dir: string, name: string): Promise<boolean> {
  if (!SKILL_NAME.test(name)) return false
  const folder = join(dir, name)
  if (await readFile(join(folder, 'SKILL.md'), 'utf8').catch(() => undefined) === undefined) return false
  await rm(folder, { recursive: true, force: true })
  return true
}

export function skillSaveTool(deps: SkillSaveDeps): ToolDefinition {
  return {
    name: 'skill_save',
    description: [
      '把刚做成的一件事保存成技能（SKILL.md），下次同样的请求直接照着做，不用重新摸索、少调用模型。',
      'content 写浓缩后的做法：什么时候用；一步一步的操作（用到的工具、命令、路径、参数照实写）；判断成功的方法；踩过的坑和注意事项。不写这次对话的闲聊和失败的尝试过程，只写最后走通的路。',
      'description 一两句话写清楚「做什么、用户说什么时用」，agent 靠它决定什么时候调用。已有同名技能时先用 replace=true 才会覆盖。',
      '技能只写「怎么做」：用户的偏好、称呼、约定，和这次做了什么、定了什么，不写成技能，用 memory_save 记进长期记忆。',
      '技能只用这个工具保存（存在本软件自己的数据目录里，只给本软件的 agent 用）；不要自己往 ~/.agents/skills、~/.dsh/skills 或工作目录的 .agents/skills 写 SKILL.md，那些是别的 agent 也读的文件夹，本软件的 agent 不读。',
      '一定要分到对应的游戏和脚本：只有用某个脚本时才用得上的（它的配置、报错、日志）填 scripts（脚本 id）；和游戏本身有关、换个脚本也用得上的（游戏里的操作、界面、活动、机制）填 games（游戏 id，game_list 可查），不填 scripts。这样它只在处理这个脚本或游戏时出现，不会被拿去用在别的脚本、别的游戏上，「技能」页也按游戏归好类。和哪个游戏都无关的通用做法两个都不填。',
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
      const { saved, replaced } = await saveSkill(deps, args)
      return { saved, replaced, note: '已保存，所有会话马上就能用；在「技能」页可以看到' } as never
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
