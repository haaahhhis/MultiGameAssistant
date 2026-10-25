/**
 * The library's persistent state: one JSON file, written atomically
 * (temp file + rename) so a crash never leaves it half-written.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { EnvReport, InstallSettings, LocalVersion, ProjectProbe, ScriptFamily, ScriptSource } from '@adg/protocol'
import { z } from 'zod'

export const StoredVersion = z.object({
  version: z.string(),
  dir: z.string(),
  installedAt: z.number(),
  asset: z.object({ name: z.string(), size: z.number() }).optional(),
})
export type StoredVersion = z.infer<typeof StoredVersion>

export const LocalBackup = z.object({
  dir: z.string(),
  /** Version before the update, when it was known. */
  from: z.string().optional(),
  to: z.string(),
  at: z.number(),
  /** Relative paths (`/`) the update created: undoing deletes them. */
  added: z.array(z.string()),
  /** Relative paths it overwrote or deleted: their old copies are in `files/`. */
  saved: z.array(z.string()),
})
export type LocalBackup = z.infer<typeof LocalBackup>

export const StoredScript = z.object({
  id: z.string(),
  name: z.string(),
  source: ScriptSource,
  packId: z.string().optional(),
  family: ScriptFamily.optional(),
  current: z.string().optional(),
  versions: z.array(StoredVersion),
  env: EnvReport.optional(),
  probe: ProjectProbe.optional(),
  update: z.object({ latest: z.string(), available: z.boolean(), checkedAt: z.number() }).optional(),
  addedAt: z.number(),
  /** GitHub update channel the user set (`owner/repo`); undefined: the automatic one. `null`: the user turned it off. */
  updateFrom: z.string().nullable().optional(),
  /** Mirror酱 update channel the user set, likewise. */
  mirrorchyan: z.object({ rid: z.string(), platform: z.boolean() }).nullable().optional(),
  /** The known project (no pack describes it) an imported folder was recognized as. */
  known: z.string().optional(),
  /** The version found in a local import's directory, and where it was read. */
  localVersion: LocalVersion.optional(),
  /** Files a local update replaced or removed, newest last; `dir` holds them under `files/`. */
  backups: z.array(LocalBackup).optional(),
})
export type StoredScript = z.infer<typeof StoredScript>

export const DEFAULT_SETTINGS: InstallSettings = {
  apiBase: 'https://api.github.com',
  downloadMirror: '',
  mirrorFallback: true,
  tokenRef: 'GITHUB_TOKEN',
  keepVersions: 3,
  includePrereleases: false,
  cdkRef: 'MIRRORCHYAN_CDK',
}

const StateFile = z.object({
  version: z.literal(1),
  settings: InstallSettings.partial().default({}),
  scripts: z.array(StoredScript).default([]),
})

export interface LibraryState {
  settings: InstallSettings
  scripts: StoredScript[]
}

export class StateStore {
  readonly file: string
  #writing: Promise<void> = Promise.resolve()

  constructor(file: string) {
    this.file = file
  }

  /** Read the state; a missing file is an empty library, a corrupt one is kept aside and reported. */
  async load(defaults: Partial<InstallSettings>, log: { warn(message: string): void }): Promise<LibraryState> {
    let text: string
    try {
      text = await readFile(this.file, 'utf8')
    } catch {
      return { settings: { ...DEFAULT_SETTINGS, ...defaults }, scripts: [] }
    }
    const parsed = StateFile.safeParse(safeJson(text))
    if (!parsed.success) {
      const aside = `${this.file}.corrupt-${Date.now()}`
      await rename(this.file, aside).catch(() => {})
      log.warn(`script library state was unreadable and was moved to ${aside}: ${parsed.error.message}`)
      return { settings: { ...DEFAULT_SETTINGS, ...defaults }, scripts: [] }
    }
    return { settings: { ...DEFAULT_SETTINGS, ...defaults, ...stripUndefined(parsed.data.settings) } as InstallSettings, scripts: parsed.data.scripts }
  }

  /** Persist; writes are serialized so the last state always wins. */
  save(state: LibraryState): Promise<void> {
    const text = `${JSON.stringify({ version: 1, settings: state.settings, scripts: state.scripts }, null, 2)}\n`
    this.#writing = this.#writing.catch(() => {}).then(async () => {
      await mkdir(dirname(this.file), { recursive: true })
      const temp = `${this.file}.${process.pid}.tmp`
      await writeFile(temp, text)
      await rename(temp, this.file)
    })
    return this.#writing
  }
}

function safeJson(text: string): unknown {
  try { return JSON.parse(text) } catch { return undefined }
}

function stripUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>
}
