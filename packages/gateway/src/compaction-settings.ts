/**
 * The automatic-compaction settings (compaction@1), kept in
 * `<dataDir>/compaction.json`. dsh reads the file itself when the agent
 * service starts: packages/bundle/cordis.patch.yml's preset-standard row turns
 * it into dsh-compaction-basic's `auto` and `thresholdRatio`. So what this
 * store reads at start is what is in effect (`applied`) until the next start.
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CompactionSettings, DEFAULT_COMPACTION_THRESHOLD } from '@adg/protocol'

export const COMPACTION_FILE = 'compaction.json'
export const DEFAULT_COMPACTION: CompactionSettings = { auto: true, threshold: DEFAULT_COMPACTION_THRESHOLD }

export class CompactionStore {
  readonly #file: string
  /** As read at start: what dsh runs with. */
  readonly applied: CompactionSettings
  #current: CompactionSettings

  constructor(dataDir: string) {
    this.#file = join(dataDir, COMPACTION_FILE)
    this.applied = readSettings(this.#file)
    this.#current = this.applied
  }

  state(): { settings: CompactionSettings; applied: CompactionSettings } {
    return { settings: this.#current, applied: this.applied }
  }

  async set(settings: CompactionSettings): Promise<{ settings: CompactionSettings; applied: CompactionSettings }> {
    const clean = CompactionSettings.parse(settings)
    await mkdir(join(this.#file, '..'), { recursive: true })
    await writeFile(`${this.#file}.tmp`, `${JSON.stringify(clean, null, 2)}\n`)
    await rename(`${this.#file}.tmp`, this.#file)
    this.#current = clean
    return this.state()
  }
}

/** The file's settings; the defaults for anything missing or invalid, as the patch's expressions do. */
export function readSettings(file: string): CompactionSettings {
  try {
    const raw = JSON.parse(readFileSync(file, 'utf8')) as Partial<CompactionSettings>
    const parsed = CompactionSettings.safeParse({ ...DEFAULT_COMPACTION, ...raw })
    return parsed.success ? parsed.data : DEFAULT_COMPACTION
  } catch {
    return DEFAULT_COMPACTION
  }
}
