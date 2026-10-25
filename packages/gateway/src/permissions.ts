/**
 * How much the agent may do without asking: `ask` (default) — dsh's sandbox
 * confines commands and every approval goes to the user; `full` — no sandbox
 * and every approval is answered "allow" at once (the user chose so in
 * 设置 → 权限). The last auto-allowed actions are kept so the user can see
 * what happened. Each area of what the agent can do (protocol AGENT_AREAS) can
 * have its own policy on top of the mode. Saved in `<dataDir>/permissions.json`.
 */
import { readFile } from 'node:fs/promises'
import { mkdirSync } from 'node:fs'
import { dirname } from 'node:path'
import { writeFileAtomic } from '@adg/protocol/node'
import { AGENT_AREAS, AreaPolicy, areaOf, type PermissionMode, type PermissionsState } from '@adg/protocol'

/** dsh permission preset names (packages/bundle/cordis.patch.yml, row `permission`). */
export const PRESET = { ask: 'workspace-write', full: 'full-access' } as const

const KEEP_RECENT = 50

export class Permissions {
  readonly #file: string | undefined
  #mode: PermissionMode = 'ask'
  #since: number | undefined
  #areas: Record<string, AreaPolicy> = {}
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
      const saved = JSON.parse(await readFile(this.#file, 'utf8')) as { mode?: unknown; since?: unknown; areas?: unknown }
      if (saved.mode === 'full') this.#mode = 'full'
      if (typeof saved.since === 'number') this.#since = saved.since
      for (const [id, policy] of Object.entries((saved.areas ?? {}) as Record<string, unknown>)) {
        const parsed = AreaPolicy.safeParse(policy)
        if (parsed.success && parsed.data !== 'default' && AGENT_AREAS.some(a => a.id === id)) this.#areas[id] = parsed.data
      }
    } catch {
      // first start: ask
    }
  }

  async set(mode: PermissionMode, now = Date.now()): Promise<void> {
    if (mode !== this.#mode) this.#since = now
    this.#mode = mode
    await this.#save()
  }

  /** @throws Error for an area that does not exist. */
  async setArea(id: string, policy: AreaPolicy): Promise<void> {
    if (!AGENT_AREAS.some(a => a.id === id)) throw new Error(`没有这个权限范围：${id}`)
    if (policy === 'default') delete this.#areas[id]
    else this.#areas[id] = policy
    await this.#save()
  }

  /** The policy for a tool: its area's, `default` when the area follows the mode (or the tool is in none). */
  policyFor(toolName: string): AreaPolicy {
    const area = areaOf(toolName)
    return area === undefined ? 'default' : this.#areas[area.id] ?? 'default'
  }

  async #save(): Promise<void> {
    if (this.#file === undefined) return
    mkdirSync(dirname(this.#file), { recursive: true })
    await writeFileAtomic(this.#file, `${JSON.stringify({ mode: this.#mode, since: this.#since, areas: this.#areas }, null, 2)}\n`)
  }

  /** An approval answered "allow" because of full access. */
  allowed(entry: PermissionsState['recent'][number]): void {
    this.#recent.unshift(entry)
    this.#recent.length = Math.min(this.#recent.length, KEEP_RECENT)
  }

  state(): PermissionsState {
    return { mode: this.#mode, ...(this.#since === undefined ? {} : { since: this.#since }), areas: { ...this.#areas }, recent: [...this.#recent] }
  }
}
