/**
 * Skills a script ships for agents (`skills/<name>/SKILL.md`,
 * `.claude/skills/…`, `.agents/skills/…`): found in its directory and, when
 * the user or the agent wants them, put among this app's own skills (the
 * gateway's skills folder, the 技能 page), each belonging to its script so
 * only the sessions working on that script see it (技能隔离).
 *
 * An imported skill is a copy of its folder with a `.origin.json` beside its
 * SKILL.md (which script, which folder, the folder's fingerprint and the
 * script's version). When the script updates and the folder changed, the copy
 * is taken again; a copy changed here since is left alone.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { folderHash, frontmatter } from './skill-hub.ts'

/** Where scripts keep skills, relative to the script directory. */
export const SKILL_PLACES = ['skills', '.claude/skills', '.agents/skills', '.codex/skills', '.github/skills', '.cursor/skills', '.skills', 'docs/skills', 'agent/skills', 'agents/skills'] as const

const SKILL_FILE = 'SKILL.md'
/** A skill folder bigger than this is not a skill (it would be copied whole). */
export const MAX_SKILL_BYTES = 8 * 1024 * 1024
export const MAX_SKILL_FILES = 400
const NAME = /^[a-z0-9]+(?:-[a-z0-9]+)*$/

export interface ScriptSkill {
  /** Its name as a skill (frontmatter `name`, made a valid skill name). */
  readonly name: string
  readonly description: string
  /** Its folder, relative to the script directory (forward slashes); the SKILL.md alone when `single`. */
  readonly path: string
  /** Absolute folder. */
  readonly dir: string
  /** Only the SKILL.md is taken (one at the script directory's top: the folder is the whole script). */
  readonly single: boolean
  readonly hash: string
  /** Why it cannot be imported. */
  readonly problem?: string
}

/** The skills in a script directory. */
export async function discoverSkills(scriptDir: string): Promise<ScriptSkill[]> {
  const out: ScriptSkill[] = []
  const seen = new Set<string>()
  const add = async (rel: string, single: boolean) => {
    const dir = rel === '' ? scriptDir : join(scriptDir, ...rel.split('/'))
    const text = await readFile(join(dir, SKILL_FILE), 'utf8').catch(() => undefined)
    if (text === undefined) return
    const meta = frontmatter(text)
    const fallback = rel === '' ? 'skill' : rel.split('/').pop()!
    const name = toSkillName(meta?.name ?? fallback) ?? toSkillName(fallback) ?? 'skill'
    let problem: string | undefined
    if (meta === undefined) problem = 'SKILL.md 开头没有写 description 的 frontmatter'
    let hash = ''
    if (single) hash = fileHash(text)
    else {
      const size = await folderSize(dir)
      if (size.files > MAX_SKILL_FILES || size.bytes > MAX_SKILL_BYTES) problem = `文件夹太大（${size.files} 个文件，${Math.round(size.bytes / 1024)} KB）`
      else hash = await folderHash(dir).catch(() => '')
    }
    if (seen.has(name)) return
    seen.add(name)
    out.push({ name, description: meta?.description.replace(/\s+/g, ' ').trim() ?? '', path: rel === '' ? SKILL_FILE : rel, dir, single, hash, ...(problem === undefined ? {} : { problem }) })
  }
  for (const place of SKILL_PLACES) {
    for (const rel of await skillFolders(scriptDir, place, 3)) await add(rel, false)
  }
  await add('', true)
  return out
}

async function skillFolders(root: string, sub: string, depth: number): Promise<string[]> {
  const entries = await readdir(join(root, ...sub.split('/')), { withFileTypes: true }).catch(() => [])
  if (entries.some(e => e.isFile() && e.name === SKILL_FILE)) return [sub]
  if (depth === 0) return []
  const out: string[] = []
  for (const entry of entries) {
    if (entry.isDirectory() && entry.name !== 'node_modules' && entry.name !== '__pycache__') out.push(...await skillFolders(root, `${sub}/${entry.name}`, depth - 1))
  }
  return out
}

async function folderSize(dir: string): Promise<{ files: number; bytes: number }> {
  let files = 0
  let bytes = 0
  const walk = async (sub: string): Promise<void> => {
    if (files > MAX_SKILL_FILES || bytes > MAX_SKILL_BYTES) return
    for (const entry of await readdir(sub, { withFileTypes: true }).catch(() => [])) {
      const path = join(sub, entry.name)
      if (entry.isDirectory()) await walk(path)
      else if (entry.isFile()) { files++; bytes += (await stat(path).catch(() => ({ size: 0 }))).size }
    }
  }
  await walk(dir)
  return { files, bytes }
}

function fileHash(text: string): string {
  return createHash('sha256').update(`${SKILL_FILE}\0${text.replace(/\r\n/g, '\n')}\0`).digest('hex').slice(0, 16)
}

export function toSkillName(value: string): string | undefined {
  const name = value.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48).replace(/-+$/, '')
  return NAME.test(name) ? name : undefined
}

/** Where an imported skill came from (`.origin.json` beside its SKILL.md). */
export interface SkillOrigin {
  readonly kind: 'script'
  readonly script: string
  /** Its folder (or SKILL.md) in the script directory. */
  readonly path: string
  /** The source folder's fingerprint when it was taken. */
  readonly hash: string
  /** The script's version then. */
  readonly version?: string
  readonly at: number
}
