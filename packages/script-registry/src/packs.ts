/**
 * Script Pack discovery: every `<dir>/<id>/adg.script.yaml` in the pack
 * directories. Later directories override earlier ones by id, so a user pack
 * replaces a built-in one. A broken pack is reported and skipped, never fatal.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { MANIFEST_FILE, parseManifest, SKILL_FILE, type ScriptManifest } from '@adg/pack-schema'

export interface PackDir {
  readonly dir: string
  /** Shipped with AutoDailyGamePlay. */
  readonly builtin: boolean
}

export interface LoadedPack {
  readonly manifest: ScriptManifest
  readonly dir: string
  readonly builtin: boolean
  /** `SKILL.md`, when present. */
  readonly skill?: string
}

export interface PackLoadError {
  readonly id: string
  readonly dir: string
  readonly builtin: boolean
  readonly error: string
}

export async function loadPacks(dirs: readonly PackDir[]): Promise<{ packs: Map<string, LoadedPack>; errors: PackLoadError[] }> {
  const packs = new Map<string, LoadedPack>()
  const errors: PackLoadError[] = []
  for (const { dir, builtin } of dirs) {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name.startsWith('.')) continue
      const packDir = join(dir, entry.name)
      const file = join(packDir, MANIFEST_FILE)
      let text: string
      try {
        text = await readFile(file, 'utf8')
      } catch {
        continue // not a pack directory
      }
      try {
        const manifest = parseManifest(text, file)
        if (manifest.id !== entry.name) throw new Error(`${file}: id "${manifest.id}" must match its directory name "${entry.name}"`)
        const skill = await readFile(join(packDir, SKILL_FILE), 'utf8').catch(() => undefined)
        packs.set(manifest.id, { manifest, dir: packDir, builtin, ...(skill === undefined ? {} : { skill }) })
      } catch (error) {
        errors.push({ id: entry.name, dir: packDir, builtin, error: error instanceof Error ? error.message : String(error) })
      }
    }
  }
  return { packs, errors }
}

/** The pack whose `source.github` is `repo` (case-insensitive). */
export function packForRepo(packs: ReadonlyMap<string, LoadedPack>, repo: string): LoadedPack | undefined {
  const wanted = repo.toLowerCase()
  for (const pack of packs.values()) if (pack.manifest.source.github?.toLowerCase() === wanted) return pack
  return undefined
}
