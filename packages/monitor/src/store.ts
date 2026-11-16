/**
 * Incident records on disk:
 *
 *   <dataDir>/monitor/incidents.json      the last few hundred incidents
 *   <dataDir>/monitor/settings.json       monitor settings
 *   <dataDir>/monitor/shots/<id>.png      screenshots taken for incidents (kept 7 days, Monitor.tidyScreenshots)
 */
import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Incident, MonitorSettings } from '@adg/protocol'
import { z } from 'zod'
import type { IncidentStore, SettingsPatch } from './monitor.ts'
import { writeFileAtomic } from '@adg/protocol/node'

export class FileIncidentStore implements IncidentStore {
  private readonly dir: string
  private writing: Promise<void> = Promise.resolve()

  constructor(dataDir: string) {
    this.dir = join(dataDir, 'monitor')
  }

  async load(): Promise<{ incidents: Incident[]; settings: SettingsPatch }> {
    const incidents = await readJson(join(this.dir, 'incidents.json'), z.array(Incident), [])
    const settings: SettingsPatch = await readJson(join(this.dir, 'settings.json'), MonitorSettings.partial(), {})
    return { incidents, settings }
  }

  saveIncidents(incidents: readonly Incident[]): Promise<void> {
    // Writes queue up so the file is always one complete snapshot.
    const snapshot = JSON.stringify(incidents)
    this.writing = this.writing.then(() => this.write('incidents.json', snapshot)).catch(() => {})
    return this.writing
  }

  saveSettings(settings: MonitorSettings): Promise<void> {
    return this.write('settings.json', `${JSON.stringify(settings, null, 2)}\n`)
  }

  async saveScreenshot(incidentId: string, png: Buffer): Promise<void> {
    await mkdir(join(this.dir, 'shots'), { recursive: true })
    await writeFile(join(this.dir, 'shots', `${safe(incidentId)}.png`), png)
  }

  readScreenshot(incidentId: string): Promise<Buffer | undefined> {
    return readFile(join(this.dir, 'shots', `${safe(incidentId)}.png`)).catch(() => undefined)
  }

  /** Incident ids are word characters and dashes, so a file name is its incident's id. */
  async screenshots(): Promise<{ id: string; at: number }[]> {
    const dir = join(this.dir, 'shots')
    const names = await readdir(dir).catch(() => [] as string[])
    const out: { id: string; at: number }[] = []
    for (const name of names) {
      if (!name.toLowerCase().endsWith('.png')) continue
      const at = await stat(join(dir, name)).then(s => s.mtimeMs, () => undefined)
      if (at !== undefined) out.push({ id: name.slice(0, -'.png'.length), at })
    }
    return out
  }

  async removeScreenshot(incidentId: string): Promise<void> {
    await rm(join(this.dir, 'shots', `${safe(incidentId)}.png`), { force: true })
  }

  private async write(name: string, text: string): Promise<void> {
    await writeFileAtomic(join(this.dir, name), text)
  }
}

async function readJson<T>(path: string, schema: z.ZodType<T>, fallback: T): Promise<T> {
  try {
    const parsed = schema.safeParse(JSON.parse(await readFile(path, 'utf8')))
    return parsed.success ? parsed.data : fallback
  } catch {
    return fallback
  }
}

function safe(id: string): string {
  return id.replace(/[^\w.-]/g, '_')
}
