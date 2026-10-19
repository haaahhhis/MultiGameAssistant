/**
 * Pipelines on disk, one JSON file each, plus recent runs:
 *
 *   <dataDir>/pipelines/<id>.json
 *   <dataDir>/pipelines/_runs.json      the last 100 runs
 */
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Pipeline, PipelineRun } from '@adg/protocol'
import { z } from 'zod'

const KEEP_RUNS = 100

export class PipelineStore {
  private readonly dir: string
  private writing: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'pipelines')
  }

  async load(log: { warn(message: string): void }): Promise<{ pipelines: Pipeline[]; runs: PipelineRun[] }> {
    const pipelines: Pipeline[] = []
    for (const name of await readdir(this.dir).catch(() => [] as string[])) {
      if (!name.endsWith('.json') || name.startsWith('_')) continue
      try {
        pipelines.push(Pipeline.parse(JSON.parse(await readFile(join(this.dir, name), 'utf8'))))
      } catch (error) {
        log.warn(`pipeline ${name} unreadable: ${error instanceof Error ? error.message : String(error)}`)
      }
    }
    let runs: PipelineRun[] = []
    try {
      runs = z.array(PipelineRun).parse(JSON.parse(await readFile(join(this.dir, '_runs.json'), 'utf8')))
    } catch { /* none yet */ }
    // Runs still marked running were cut off when the program last stopped.
    for (const run of runs) {
      if (run.state !== 'running') continue
      run.state = 'cancelled'
      run.outcome = '程序退出时中断'
      run.endedAt ??= run.startedAt
    }
    return { pipelines, runs }
  }

  async save(pipeline: Pipeline): Promise<void> {
    await this.write(`${pipeline.id}.json`, `${JSON.stringify(pipeline, null, 2)}\n`)
  }

  async remove(id: string): Promise<void> {
    await rm(join(this.dir, `${id}.json`), { force: true })
  }

  saveRuns(runs: readonly PipelineRun[]): Promise<void> {
    const text = JSON.stringify(runs.slice(-KEEP_RUNS))
    this.writing = this.writing.then(() => this.write('_runs.json', text)).catch(() => {})
    return this.writing
  }

  private async write(name: string, text: string): Promise<void> {
    await mkdir(this.dir, { recursive: true })
    const target = join(this.dir, name)
    await writeFile(`${target}.tmp`, text)
    await rename(`${target}.tmp`, target)
  }
}
