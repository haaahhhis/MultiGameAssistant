/**
 * How much the agent may do without asking: `ask` (default) — dsh's sandbox
 * confines commands and every approval goes to the user; `full` — no sandbox
 * and every approval is answered "allow" at once (the user chose so in
 * 设置 → 权限). The last auto-allowed actions are kept so the user can see
 * what happened. Saved in `<dataDir>/permissions.json`.
 */
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@adg/protocol/node'
import type { PermissionMode, PermissionsState } from '@adg/protocol'

/** dsh permission preset names (packages/bundle/cordis.patch.yml, row `permission`). */
export const PRESET = { ask: 'workspace-write', full: 'full-access' } as const

const KEEP_RECENT = 50

export class Permissions {
  readonly #file: string | undefined
  #mode: PermissionMode = 'ask'
  #since: number | undefined
  #recent: PermissionsState['recent'] = []

  constructor(file: string | undefined) {
    this.#file = file
  }

  get mode(): PermissionMode {
    return this.#mode
  }

  async load(): Promise<void> {
    if (this.#file === undefined) return
    try {
      const saved = JSON.parse(await readFile(this.#file, 'utf8')) as { mode?: unknown; since?: unknown }
      if (saved.mode === 'full') this.#mode = 'full'
      if (typeof saved.since === 'number') this.#since = saved.since
    } catch {
      // first start: ask
    }
  }

  async set(mode: PermissionMode, now = Date.now()): Promise<void> {
    if (mode !== this.#mode) this.#since = now
    this.#mode = mode
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    await writeFileAtomic(this.#file, `${JSON.stringify({ mode, since: this.#since }, null, 2)}\n`)
  }

  /** An approval answered "allow" because of full access. */
  allowed(entry: PermissionsState['recent'][number]): void {
    this.#recent.unshift(entry)
    this.#recent.length = Math.min(this.#recent.length, KEEP_RECENT)
  }

  state(): PermissionsState {
    return { mode: this.#mode, ...(this.#since === undefined ? {} : { since: this.#since }), recent: [...this.#recent] }
  }
}
