/**
 * The automatic-compaction settings (compaction@1), kept in
 * `<dataDir>/compaction.json`. dsh reads the file itself when the agent
 * service starts: packages/bundle/cordis.patch.yml's preset-standard row turns
 * it into dsh-compaction-basic's `auto` and `thresholdRatio`, and into the
 * preset sub-agents start under (`ptcSubagents`), and the model that writes the
 * summaries (`summarizer`: its `summarizationProvider` / `summarizationModel`,
 * and `maxTokens` as that model's own output limit). So what this
 * store reads at start is what is in effect (`applied`) until the next start.
 * Low-context mode and its archiving are read from the file each time it
 * might compact (low-context.ts), so they are in effect as soon as saved.
 */
import { readFileSync } from 'node:fs'
import { mkdir, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { CompactionSettings, DEFAULT_COMPACTION_THRESHOLD, SUMMARY_MAX_TOKENS } from '@adg/protocol'

export const COMPACTION_FILE = 'compaction.json'
export const DEFAULT_COMPACTION: CompactionSettings = { auto: true, threshold: DEFAULT_COMPACTION_THRESHOLD, lowContext: false, archiveDays: null, ptcSubagents: true, summarizer: null }

/** A model's own output limit as its route declares it (settings → 模型服务), if it does. */
export type OutputLimit = (provider: string, model: string) => number | undefined

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
    // Low-context mode and archiving need no restart: what is saved is what runs.
    return { settings: this.#current, applied: { ...this.applied, lowContext: this.#current.lowContext, archiveDays: this.#current.archiveDays } }
  }

  /**
   * @param outputLimit - the chosen summarizer's own output limit, if its route declares one: a summary is asked
   * to fit in that (when below dsh's default), not in more than the model can write.
   */
  async set(settings: CompactionSettings, outputLimit?: OutputLimit): Promise<{ settings: CompactionSettings; applied: CompactionSettings }> {
    const parsed = CompactionSettings.parse(settings)
    const clean: CompactionSettings = { ...parsed, summarizer: withLimit(parsed.summarizer, outputLimit) }
    await mkdir(join(this.#file, '..'), { recursive: true })
    await writeFile(`${this.#file}.tmp`, `${JSON.stringify(clean, null, 2)}\n`)
    await rename(`${this.#file}.tmp`, this.#file)
    this.#current = clean
    return this.state()
  }
}

/** The summarizer with the cap its summary must fit in: the model's own limit when that is below dsh's default. */
function withLimit(summarizer: CompactionSettings['summarizer'], outputLimit: OutputLimit | undefined): CompactionSettings['summarizer'] {
  if (summarizer === null) return null
  const limit = outputLimit?.(summarizer.provider, summarizer.model)
  return { provider: summarizer.provider, model: summarizer.model, ...(limit === undefined || limit >= SUMMARY_MAX_TOKENS ? {} : { maxTokens: limit }) }
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
