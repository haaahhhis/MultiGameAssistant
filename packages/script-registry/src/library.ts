/**
 * The script library: what is installed or imported, where, in which
 * versions, and whether its runtime requirements are met.
 *
 * Layout: `<toolsDir>/<id>/<version>/` per installed version (side by side,
 * so rollback is switching `current`); downloads land in
 * `<toolsDir>/<id>/.downloads/` and are removed after unpacking; shared
 * helpers such as platform-tools live in `<toolsDir>/_shared/`. Imported
 * directories stay where they are and are never moved or deleted.
 *
 * A release that is a setup program (NSIS / Inno Setup) is not unpacked: it
 * waits in the downloads folder for the agent to run it (`runSetup`) and
 * import the folder it installed into, which finishes the install.
 *
 * Nothing here names a particular script: behaviour comes from Script Packs.
 */
import { copyFile, cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  applyFix, archiveKind, checkEnvironment, compareVersions, contentKind, detectVersion, download, extract, GitHubClient, matchesDetect, mirrorCatalogue, MirrorChyanError, mirrorLatest, probeProject, readMirrorChanges, runSetup,
  SETUP_NAMES, setupExitText, setupKind, systemHost,
  type DetectedVersion, type EnvChecker, type EnvHost, type FixPlan, type MirrorLatest, type MirrorProject, type MirrorResource, type SetupKind,
} from '@adg/installer'
import { chooseAsset, globToRegExp, versionOfTag } from '@adg/pack-schema'
import type { ChannelFrom, EnvReport, InstallSettings, KnownProjectSummary, MirrorLookup, MirrorSearchItem, PackSummary, PendingSetupInfo, ReleaseInfo, ScriptInfo, ScriptJob, ScriptSource, ScriptSummary, SetupAgent } from '@adg/protocol'
import { JobBoard, type JobControl } from './jobs.ts'
import { KNOWN_PROJECTS, knownByDir, knownById, knownByMirror, knownByRepo, mirrorResourceFor } from './known-projects.ts'
import { loadPacks, packForRepo, type LoadedPack, type PackDir, type PackLoadError } from './packs.ts'
import { DEFAULT_SETTINGS, StateStore, type LibraryState, type LocalBackup, type PendingSetup, type StoredScript, type StoredVersion } from './state.ts'

/** Mirror酱's project list is read again after a day. */
const CATALOGUE_TTL_MS = 24 * 60 * 60_000

export interface LibraryOptions {
  readonly toolsDir: string
  /** Holds `scripts.json` and the user's own packs (`packs/`). */
  readonly dataDir: string
  /** Built-in pack directories; `<dataDir>/packs` is appended as the user's. */
  readonly packDirs: readonly string[]
  /** Settings used until the user changes them. */
  readonly defaults?: Partial<InstallSettings>
  /** Resolve a credential's value (the GitHub token). */
  readonly credential: (ref: string) => Promise<string | undefined>
  readonly credentialConfigured: (ref: string) => Promise<boolean>
  readonly envHost?: EnvHost
  readonly runElevated?: (file: string, args: readonly string[]) => Promise<number>
  readonly fetch?: typeof globalThis.fetch
  /** Mirror酱's address (tests point it at a fake). @default https://mirrorchyan.com */
  readonly mirrorchyanBase?: string
  readonly now?: () => number
  readonly onChanged: (id?: string) => void
  readonly onJob: (job: ScriptJob) => void
  /** An install or update the agent did not ask for downloaded a setup program: start the agent on it. @returns its conversation. */
  readonly onSetup?: (setup: PendingSetup) => Promise<string>
  readonly log: { info(message: string): void; warn(message: string): void }
}

export interface InstallRequest {
  /** From GitHub… */
  readonly repo?: string | undefined
  /** …or from Mirror酱 (needs a CDK); tag and asset do not apply. */
  readonly mirrorchyan?: MirrorResource | undefined
  readonly tag?: string | undefined
  readonly asset?: string | undefined
  readonly id?: string | undefined
  /** The agent asked: a setup program is left to it (the job says so) rather than to a new conversation. */
  readonly byAgent?: boolean | undefined
}

export class ScriptLibrary {
  readonly toolsDir: string
  readonly #options: LibraryOptions
  readonly #store: StateStore
  readonly #jobs: JobBoard
  readonly #now: () => number
  #state: LibraryState = { settings: DEFAULT_SETTINGS, scripts: [], setups: [] }
  #packs = new Map<string, LoadedPack>()
  #packErrors: PackLoadError[] = []
  readonly #checkers = new Map<string, EnvChecker>()
  readonly #packListeners = new Set<() => void>()
  #catalogue: { at: number; projects: MirrorProject[] } | undefined

  constructor(options: LibraryOptions) {
    this.#options = options
    this.toolsDir = resolve(options.toolsDir)
    this.#store = new StateStore(join(options.dataDir, 'scripts.json'))
    this.#now = options.now ?? Date.now
    this.#jobs = new JobBoard(options.onJob, this.#now)
  }

  get sharedDir(): string {
    return join(this.toolsDir, '_shared')
  }

  async start(): Promise<void> {
    this.#state = await this.#store.load(this.#options.defaults ?? {}, this.#options.log)
    // An agent still on a setup program when the app stopped is not any more.
    for (const setup of this.#state.setups) {
      if (setup.agent?.state === 'running') setup.agent = { ...setup.agent, state: 'failed', reason: '程序重新启动了，agent 没有装完' }
    }
    await this.reloadPacks()
    for (const script of this.#state.scripts) await this.#recognize(script)
  }

  dispose(): void {
    this.#jobs.dispose()
  }

  async reloadPacks(): Promise<void> {
    const dirs: PackDir[] = [
      ...this.#options.packDirs.map(dir => ({ dir, builtin: true })),
      { dir: join(this.#options.dataDir, 'packs'), builtin: false },
    ]
    const { packs, errors } = await loadPacks(dirs)
    this.#packs = packs
    this.#packErrors = errors
    for (const error of errors) this.#options.log.warn(`script pack skipped: ${error.error}`)
    for (const listener of this.#packListeners) listener()
  }

  /** Let another plugin check a requirement kind (e.g. `emulator`). @returns the disposer. */
  registerEnvChecker(kind: string, checker: EnvChecker): () => void {
    this.#checkers.set(kind, checker)
    return () => { if (this.#checkers.get(kind) === checker) this.#checkers.delete(kind) }
  }

  /** Run `listener` after packs are (re)loaded. @returns the disposer. */
  onPacksChanged(listener: () => void): () => void {
    this.#packListeners.add(listener)
    return () => { this.#packListeners.delete(listener) }
  }

  /** Every loaded pack. */
  packs(): LoadedPack[] {
    return [...this.#packs.values()]
  }

  /** The pack describing a library script, if any. */
  packOf(id: string): LoadedPack | undefined {
    const packId = this.#script(id).packId
    return packId === undefined ? undefined : this.#packs.get(packId)
  }

  /** Directories MultiGameAssistant must not let the agent rewrite: the tools directory and every imported directory. */
  protectedDirs(): string[] {
    return [this.toolsDir, ...this.#state.scripts.filter(s => s.source.kind === 'local').map(s => (s.source as { path: string }).path)]
  }

  pack(id: string): LoadedPack | undefined {
    return this.#packs.get(id)
  }

  // ── reading ───────────────────────────────────────────────────────────

  list(): { scripts: ScriptInfo[]; packs: PackSummary[]; known: KnownProjectSummary[]; setups: PendingSetupInfo[]; toolsDir: string } {
    const used = new Set(this.#state.scripts.map(s => s.packId).filter(Boolean))
    const packs: PackSummary[] = [...this.#packs.values()].map(({ manifest, builtin }) => ({
      id: manifest.id,
      name: manifest.name,
      builtin,
      installed: used.has(manifest.id),
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      ...(manifest.source.github === undefined ? {} : { repo: manifest.source.github }),
      ...(manifest.source.mirrorchyan === undefined ? {} : { mirrorchyan: manifest.source.mirrorchyan.rid }),
      ...(manifest.family === undefined ? {} : { family: manifest.family }),
    }))
    for (const error of this.#packErrors) packs.push({ id: error.id, name: error.id, builtin: error.builtin, installed: false, error: error.error })
    // The known projects no pack describes (the others are listed as packs).
    const known: KnownProjectSummary[] = KNOWN_PROJECTS
      .filter(p => p.repo === undefined || packForRepo(this.#packs, p.repo) === undefined)
      .map(p => ({
        id: p.id,
        name: p.name,
        installed: this.#state.scripts.some(s => s.known === p.id || (s.source.kind === 'github' && s.source.repo.toLowerCase() === p.repo?.toLowerCase()) || (s.source.kind === 'mirrorchyan' && s.source.rid === p.mirrorchyan?.rid)),
        ...(p.repo === undefined ? {} : { repo: p.repo }),
        ...(p.mirrorchyan === undefined ? {} : { mirrorchyan: p.mirrorchyan.rid }),
      }))
    const setups = this.#state.setups.map(({ file: _file, asset: _asset, source: _source, packId: _packId, ...shown }) => shown)
    return { scripts: this.#state.scripts.map(s => this.#info(s)), packs, known, setups, toolsDir: this.toolsDir }
  }

  get(id: string): ScriptInfo {
    return this.#info(this.#script(id))
  }

  jobs(): ScriptJob[] {
    return this.#jobs.list()
  }

  cancelJob(jobId: string): void {
    if (!this.#jobs.cancel(jobId)) throw new Error('任务不存在或已结束')
  }

  async settings(): Promise<InstallSettings & { tokenConfigured: boolean; cdkConfigured: boolean }> {
    return {
      ...this.#state.settings,
      tokenConfigured: await this.#options.credentialConfigured(this.#state.settings.tokenRef),
      cdkConfigured: await this.#options.credentialConfigured(this.#state.settings.cdkRef),
    }
  }

  /** Ask Mirror酱 with the CDK (for a script it carries) whether the CDK works, and until when. */
  async checkMirrorCdk(signal?: AbortSignal): Promise<{ ok: boolean; message: string; expiresAt?: number }> {
    const cdk = await this.#options.credential(this.#state.settings.cdkRef)
    if (cdk === undefined || cdk === '') return { ok: false, message: '还没有填写 Mirror酱 CDK' }
    const resource = [...this.#packs.values()].map(p => p.manifest.source.mirrorchyan).find(r => r !== undefined)
    if (resource === undefined) return { ok: false, message: '没有在 Mirror酱 发布的脚本包，无法检查' }
    try {
      const latest = await mirrorLatest(resource, this.#mirrorOptions(cdk, signal))
      const until = latest.cdkExpiresAt === undefined ? '' : `，到 ${new Date(latest.cdkExpiresAt).toLocaleDateString('zh-CN')} 到期`
      return { ok: true, message: `CDK 可用${until}`, ...(latest.cdkExpiresAt === undefined ? {} : { expiresAt: latest.cdkExpiresAt }) }
    } catch (error) {
      return { ok: false, message: errorText(error) }
    }
  }

  async setSettings(patch: { [K in keyof InstallSettings]?: InstallSettings[K] | undefined }): Promise<InstallSettings> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined)) as Partial<InstallSettings>
    this.#state.settings = { ...this.#state.settings, ...defined }
    await this.#save()
    this.#options.onChanged()
    return this.#state.settings
  }

  // ── GitHub ────────────────────────────────────────────────────────────

  async search(query: string, signal?: AbortSignal) {
    const items = await this.#github().search(query, 10, signal)
    return { items: items.map(item => ({ ...item, ...(packForRepo(this.#packs, item.repo) === undefined ? {} : { packId: packForRepo(this.#packs, item.repo)!.manifest.id }) })) }
  }

  async releases(repo: string, limit = 10, signal?: AbortSignal): Promise<{ repo: string; packId?: string; releases: ReleaseInfo[] }> {
    const pack = packForRepo(this.#packs, repo)
    const releases = await this.#github().releases(repo, limit, signal)
    return {
      repo,
      ...(pack === undefined ? {} : { packId: pack.manifest.id }),
      releases: releases.map(release => {
        const choice = chooseAsset(release.assets, { ...globsOf(pack), tag: release.tag })
        return { ...release, ...(choice.asset === undefined ? {} : { suggestedAsset: choice.asset.name }) }
      }),
    }
  }

  /** Download a file from GitHub through the download mirror the user set (the skills repository uses it). */
  async downloadFromGitHub(url: string, dest: string, signal?: AbortSignal): Promise<void> {
    const settings = this.#state.settings
    await download({
      url, dest,
      mirror: settings.downloadMirror,
      mirrorFallback: settings.mirrorFallback,
      ...(signal === undefined ? {} : { signal }),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    })
  }

  /** Unpack an archive safely into a new folder (a single top folder lifted). */
  unpack(archive: string, dest: string, signal?: AbortSignal): Promise<unknown> {
    return extract(archive, dest, signal === undefined ? {} : { signal })
  }

  /** Whether `repo` is described by a pack this installation ships (curated). */
  isKnownRepo(repo: string): boolean {
    return packForRepo(this.#packs, repo)?.builtin === true
  }

  /** Id an install of `repo` would use. */
  scriptIdFor(repo: string, id?: string): string {
    return id ?? packForRepo(this.#packs, repo)?.manifest.id ?? knownByRepo(repo)?.id ?? slug(repo.split('/')[1] ?? repo)
  }

  /** Whether a Mirror酱 resource is one a pack or the known-project list names (curated). */
  isKnownMirror(rid: string): boolean {
    return knownByMirror(rid) !== undefined || this.#packForMirror(rid)?.builtin === true
  }

  /**
   * Whether Mirror酱 has `rid`, its latest version, and how to ask for its
   * Windows build. No CDK is needed. Its project list says how; for a
   * resource not on it (or when the list cannot be read), the pack or the
   * known-project list, else each way of asking is tried.
   */
  async lookupMirror(rid: string, signal?: AbortSignal): Promise<MirrorLookup> {
    const { projects } = await this.mirrorProjects(signal)
    const listed = projects.find(p => p.rid.toLowerCase() === rid.toLowerCase())
    if (listed !== undefined && listed.windows === undefined) throw new Error(`Mirror酱 上的 ${listed.name}（${listed.rid}）没有 Windows 版`)
    if (listed !== undefined && !listed.download) throw new Error(`Mirror酱 不提供 ${listed.name}（${listed.rid}）的下载`)
    const named = (resource: MirrorResource, version: string): MirrorLookup => {
      const pack = this.#packForMirror(resource.rid)
      const project = knownByMirror(resource.rid)
      const name = pack?.manifest.name ?? project?.name ?? listed?.name
      const repo = pack?.manifest.source.github ?? project?.repo ?? listed?.repo
      return {
        rid: resource.rid,
        version: versionOfTag(version),
        platform: resource.platform,
        ...(resource.os === undefined ? {} : { os: resource.os }),
        ...(resource.arch === undefined ? {} : { arch: resource.arch }),
        ...(name === undefined ? {} : { name }),
        ...(listed?.description === undefined || listed.description === '' ? {} : { description: listed.description }),
        ...(repo === undefined ? {} : { repo }),
      }
    }
    const known = listed?.windows ?? this.#packForMirror(rid)?.manifest.source.mirrorchyan ?? knownByMirror(rid)?.mirrorchyan
    if (known !== undefined) return named(known, (await mirrorLatest(known, this.#mirrorOptions(undefined, signal))).version)
    // Mirror酱 matches os and arch exactly: try both, neither, then each alone.
    let last: unknown
    for (const [os, arch] of [[true, true], [false, false], [false, true], [true, false]] as const) {
      const resource: MirrorResource = { rid, platform: os && arch, os, arch }
      try {
        return named(resource, (await mirrorLatest(resource, this.#mirrorOptions(undefined, signal))).version)
      } catch (error) {
        if (!(error instanceof MirrorChyanError) || error.code !== 8001) throw error
        last = error
      }
    }
    throw last
  }

  /**
   * Mirror酱's project list, read at most once a day (kept in
   * `<dataDir>/mirrorchyan-projects.json`, so an older copy serves when it
   * cannot be read); without any copy, the packs and known projects on it.
   * Needs no CDK.
   */
  async mirrorProjects(signal?: AbortSignal): Promise<{ projects: MirrorProject[]; from: 'mirrorchyan' | 'builtin'; fetchedAt?: number }> {
    const file = join(this.#options.dataDir, 'mirrorchyan-projects.json')
    if (this.#catalogue === undefined) {
      try {
        const saved = JSON.parse(await readFile(file, 'utf8')) as { at?: unknown; projects?: unknown }
        if (typeof saved.at === 'number' && Array.isArray(saved.projects)) this.#catalogue = { at: saved.at, projects: saved.projects as MirrorProject[] }
      } catch { /* none yet */ }
    }
    const cached = this.#catalogue
    if (cached !== undefined && this.#now() - cached.at < CATALOGUE_TTL_MS) return { projects: cached.projects, from: 'mirrorchyan', fetchedAt: cached.at }
    try {
      const projects = await mirrorCatalogue({
        ...(this.#options.mirrorchyanBase === undefined ? {} : { base: this.#options.mirrorchyanBase }),
        ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
        ...(signal === undefined ? {} : { signal }),
      })
      this.#catalogue = { at: this.#now(), projects }
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, `${JSON.stringify(this.#catalogue)}\n`).catch(() => {})
      return { projects, from: 'mirrorchyan', fetchedAt: this.#catalogue.at }
    } catch (error) {
      if (signal?.aborted === true) throw error
      this.#options.log.warn(`Mirror酱 project list: ${errorText(error)}`)
      if (cached !== undefined) return { projects: cached.projects, from: 'mirrorchyan', fetchedAt: cached.at }
      return { projects: this.#builtinMirrorProjects(), from: 'builtin' }
    }
  }

  /**
   * Search Mirror酱's tools (with a Windows build it hands out) by name,
   * game, id or repository; every word of `query` must match. An empty query
   * lists them all, the known ones first. Needs no CDK.
   */
  async searchMirror(query: string, signal?: AbortSignal): Promise<{ items: MirrorSearchItem[]; from: 'mirrorchyan' | 'builtin'; fetchedAt?: number }> {
    const list = await this.mirrorProjects(signal)
    const words = query.split(/\s+/).map(squash).filter(w => w !== '')
    const scored: { item: MirrorSearchItem; score: number }[] = []
    for (const p of list.projects) {
      if (p.windows === undefined || !p.download || (p.type !== '' && p.type !== 'GameTools')) continue
      const fields = { rid: squash(p.rid), name: squash(p.name), repo: squash(p.repo ?? ''), description: squash(p.description) }
      let score = 0
      let all = true
      for (const word of words) {
        const s = fields.rid === word ? 100 : fields.name === word ? 90 : fields.rid.includes(word) || fields.name.includes(word) ? 60 : fields.repo.includes(word) ? 40 : fields.description.includes(word) ? 30 : 0
        if (s === 0) { all = false; break }
        score += s
      }
      if (!all) continue
      const known = this.isKnownMirror(p.rid)
      scored.push({
        // The ones MultiGameAssistant recognizes and updates first, unless another is named exactly.
        score: score + (known ? 40 : 0),
        item: {
          rid: p.rid,
          name: p.name,
          description: p.description,
          installed: this.#state.scripts.some(s => this.#channels(s).mirror?.resource.rid.toLowerCase() === p.rid.toLowerCase()),
          known,
          ...(p.repo === undefined ? {} : { repo: p.repo }),
          ...(p.url === undefined ? {} : { url: p.url }),
        },
      })
    }
    scored.sort((a, b) => b.score - a.score || a.item.name.localeCompare(b.item.name, 'zh-CN'))
    return { items: scored.map(s => s.item), from: list.from, ...(list.fetchedAt === undefined ? {} : { fetchedAt: list.fetchedAt }) }
  }

  /**
   * Whether a script is on Mirror酱, for one that has no Mirror酱 channel
   * yet: the projects whose GitHub repository is its repository, else whose
   * name or id is in its name (or the reverse). Needs no CDK.
   */
  async matchMirror(id: string, signal?: AbortSignal): Promise<{ items: (MirrorSearchItem & { by: 'repo' | 'name' })[]; from: 'mirrorchyan' | 'builtin' }> {
    const script = this.#script(id)
    const { items, from } = await this.searchMirror('', signal)
    const repo = this.#channels(script).github?.repo.toLowerCase()
    const byRepo = repo === undefined ? [] : items.filter(i => i.repo?.toLowerCase() === repo)
    if (byRepo.length > 0) return { items: byRepo.map(i => ({ ...i, by: 'repo' as const })), from }
    const names = [script.name, script.id, script.source.kind === 'local' ? basename(script.source.path) : undefined].filter((n): n is string => n !== undefined).map(squash).filter(n => n.length >= 2)
    const byName = items.filter(i => {
      const keys = [squash(i.name), squash(i.rid)].filter(k => k.length >= 3)
      return keys.some(k => names.some(n => n.includes(k) || k.includes(n)))
    })
    return { items: byName.map(i => ({ ...i, by: 'name' as const })), from }
  }

  /** The packs and known projects on Mirror酱, for when its list cannot be read. */
  #builtinMirrorProjects(): MirrorProject[] {
    const out = new Map<string, MirrorProject>()
    const add = (resource: MirrorResource, name: string, repo: string | undefined, description = '') => {
      if (out.has(resource.rid.toLowerCase())) return
      out.set(resource.rid.toLowerCase(), { rid: resource.rid, name, description, type: 'GameTools', download: true, windows: resource, ...(repo === undefined ? {} : { repo }) })
    }
    for (const pack of this.#packs.values()) {
      const resource = pack.manifest.source.mirrorchyan
      if (resource !== undefined) add(resource, pack.manifest.name, pack.manifest.source.github, pack.manifest.description ?? '')
    }
    for (const project of KNOWN_PROJECTS) if (project.mirrorchyan !== undefined) add(project.mirrorchyan, project.name, project.repo)
    return [...out.values()]
  }

  // ── installing ────────────────────────────────────────────────────────

  /** Start an install from GitHub (`repo`) or Mirror酱 (`mirrorchyan`); the returned promise settles when the job ends. */
  install(request: InstallRequest): { job: ScriptJob; done: Promise<ScriptJob> } {
    const mirror = request.mirrorchyan
    if ((request.repo === undefined) === (mirror === undefined)) throw new Error('请给出 GitHub 仓库或 Mirror酱 资源 id 之一')
    const pack = request.repo !== undefined ? packForRepo(this.#packs, request.repo) : this.#packForMirror(mirror!.rid)
    const scriptId = request.repo !== undefined
      ? this.scriptIdFor(request.repo, request.id)
      : request.id ?? pack?.manifest.id ?? knownByMirror(mirror!.rid)?.id ?? slug(mirror!.rid)
    const existing = this.#state.scripts.find(s => s.id === scriptId)
    if (existing !== undefined && existing.source.kind === 'local') {
      throw new Error(`id ${scriptId} 已被本地导入的脚本使用，请换一个 id`)
    }
    const source: ScriptSource = request.repo !== undefined ? { kind: 'github', repo: request.repo } : { kind: 'mirrorchyan', ...resourceOf(mirror!) }
    if (existing !== undefined && !sameSource(existing.source, source)) {
      throw new Error(`id ${scriptId} 已属于 ${describeSource(existing.source)}，请换一个 id`)
    }
    // A chosen release or file is GitHub's own; otherwise the latest, from Mirror酱 when it has the script and there is a CDK.
    const channels = existing !== undefined
      ? this.#channels(existing)
      : this.#newChannels(source, pack)
    const use: Channels = request.tag !== undefined || request.asset !== undefined ? (channels.github === undefined ? {} : { github: channels.github }) : channels
    return this.#jobs.start(existing === undefined ? 'install' : 'update', scriptId, ctl => this.#installJob(scriptId, source, request, use, pack, ctl))
  }

  /**
   * Compare the current version with the latest release, from Mirror酱 with
   * a CDK else GitHub (Mirror酱 without a CDK when it is the only channel).
   * A local import is compared by the version found in its directory (read
   * again each time: the script may have updated itself).
   */
  async checkUpdate(id: string, signal?: AbortSignal): Promise<{ current?: string; latest: string; available: boolean }> {
    const script = this.#script(id)
    await this.#recognize(script)
    const pack = this.#packOf(script)
    const channels = this.#channels(script)
    if (channels.github === undefined && channels.mirror === undefined) {
      throw new Error('这个脚本还没有更新渠道：在脚本页填写它的 GitHub 仓库（owner/repo）或 Mirror酱 资源 id 后再检查')
    }
    let current = script.current
    if (script.source.kind === 'local') {
      const found = await this.#detectVersion(script)
      if (found !== undefined) script.localVersion = found
      current = script.localVersion?.version
    }
    const version = await this.#latestVersion(channels, pack, signal)
    const managed = script.source.kind !== 'local'
    const available = current === undefined || compareVersions(version, current) > 0 || (managed && compareVersions(version, current) === 0 && version !== current)
    script.update = { latest: version, available, checkedAt: this.#now() }
    await this.#save()
    this.#options.onChanged(id)
    return { ...(current === undefined ? {} : { current }), latest: version, available }
  }

  /**
   * Update to the latest release over its channels. An installed script gets
   * it beside the current version; a local import is updated in its own
   * directory, with what it replaces backed up first (see {@link restore}).
   */
  async update(id: string, signal?: AbortSignal, options: { byAgent?: boolean } = {}): Promise<{ upToDate: true } | { upToDate: false; job: ScriptJob; done: Promise<ScriptJob> }> {
    const script = this.#script(id)
    const check = await this.checkUpdate(id, signal)
    if (!check.available) return { upToDate: true }
    const channels = this.#channels(script)
    if (script.source.kind === 'local') {
      return { upToDate: false, ...this.#jobs.start('update', id, ctl => this.#localUpdateJob(script, channels, ctl, options.byAgent === true)) }
    }
    const source = script.source
    return { upToDate: false, ...this.#jobs.start('update', id, ctl => this.#installJob(id, source, { byAgent: options.byAgent }, channels, this.#packOf(script), ctl)) }
  }

  /**
   * Set a script's update channels: a value sets it, `null` turns it off,
   * `reset` goes back to the automatic one. How it was installed stays its
   * channel (an installed script's repository, a Mirror酱 install's resource).
   */
  async setUpdateSource(id: string, patch: { repo?: string | null | undefined; mirrorchyan?: MirrorResource | null | undefined; reset?: readonly ('repo' | 'mirrorchyan')[] | undefined }): Promise<ScriptInfo> {
    const script = this.#script(id)
    if (patch.repo !== undefined || patch.reset?.includes('repo') === true) {
      if (script.source.kind === 'github') throw new Error('从 GitHub 安装的脚本跟随它安装时的仓库更新')
      if (patch.reset?.includes('repo') === true) delete script.updateFrom
      else script.updateFrom = patch.repo!
    }
    if (patch.mirrorchyan !== undefined || patch.reset?.includes('mirrorchyan') === true) {
      if (script.source.kind === 'mirrorchyan') throw new Error('从 Mirror酱 安装的脚本跟随它安装时的资源更新')
      if (patch.reset?.includes('mirrorchyan') === true) delete script.mirrorchyan
      else script.mirrorchyan = patch.mirrorchyan === null ? null : resourceOf(patch.mirrorchyan!)
    }
    delete script.update
    await this.#save()
    this.#options.onChanged(id)
    return this.#info(script)
  }

  async #installJob(scriptId: string, source: ScriptSource, request: Pick<InstallRequest, 'tag' | 'asset' | 'byAgent'>, channels: Channels, pack: LoadedPack | undefined, ctl: JobControl): Promise<string> {
    const script = this.#state.scripts.find(s => s.id === scriptId)
    const previous = script === undefined ? undefined : currentVersion(script)
    const have = (version: string) => script?.versions.some(v => v.version === version) === true
    const fetched = await this.#fetch(scriptId, channels, pack, previous?.version, ctl, request, have)
    const { version, archive } = fetched
    if (archive === undefined && script !== undefined) {
      script.current = version
      await this.#save()
      this.#options.onChanged(scriptId)
      ctl.phase('done', { message: `${version} 已安装，已切换为当前版本` })
      return version
    }
    const versionDir = join(this.toolsDir, scriptId, dirName(version))
    const setup = await setupKind(archive!)
    if (setup !== undefined) {
      return this.#handOffSetup(setup, { scriptId, file: archive!, version, asset: fetched.asset, dir: versionDir, source: script?.source ?? source, ...(pack === undefined ? {} : { packId: pack.manifest.id }), update: script !== undefined }, request.byAgent === true, ctl)
    }
    const root = pack?.manifest.install.root
    ctl.phase('extracting', { message: fetched.incremental ? `在 ${previous!.version} 的基础上更新到 ${version}` : `解压到 ${versionDir}` })
    await rm(versionDir, { recursive: true, force: true })
    if (!fetched.incremental) {
      await extract(archive!, versionDir, { signal: ctl.signal, ...(root === undefined ? {} : { root }) })
    } else {
      // A copy of the installed version, the changed files over it, then what changes.json says went away.
      const patch = `${versionDir}.patch`
      await rm(patch, { recursive: true, force: true })
      await extract(archive!, patch, { signal: ctl.signal })
      try {
        await cp(previous!.dir, versionDir, { recursive: true })
        const prefix = await patchPrefix(patch, previous!.dir, root)
        const from = prefix === undefined ? patch : join(patch, prefix)
        await cp(from, versionDir, { recursive: true, force: true })
        if (from === patch) await rm(join(versionDir, 'changes.json'), { force: true })
        const gone = await readMirrorChanges(patch, prefix) ?? []
        for (const rel of gone) await rm(join(versionDir, ...rel.split('/')), { recursive: true, force: true })
        if (gone.length > 0) this.#options.log.info(`${scriptId}: the incremental package removed ${gone.length} path(s)`)
      } catch (error) {
        await rm(versionDir, { recursive: true, force: true })
        throw error
      } finally {
        await rm(patch, { recursive: true, force: true })
      }
    }
    await rm(archive!, { force: true })
    await this.#addVersion(scriptId, source, pack, version, versionDir, fetched.asset, ctl)
    return version
  }

  /** A version unpacked (or installed) in `dir` becomes the current one, the script added if it is new. */
  async #addVersion(scriptId: string, source: ScriptSource, pack: LoadedPack | undefined, version: string, dir: string, asset: { name: string; size: number }, ctl?: JobControl, name?: string): Promise<void> {
    let script = this.#state.scripts.find(s => s.id === scriptId)
    const previous = script === undefined ? undefined : currentVersion(script)
    if (previous !== undefined && pack !== undefined && !samePath(previous.dir, dir)) {
      const carried = await carryConfig(pack, previous.dir, dir)
      if (carried.length > 0) this.#options.log.info(`${scriptId}: carried ${carried.length} config file(s) from ${previous.version}`)
    }
    if (script === undefined) {
      const known = source.kind === 'github' ? knownByRepo(source.repo) : source.kind === 'mirrorchyan' ? knownByMirror(source.rid) : undefined
      script = {
        id: scriptId,
        name: name ?? newName(scriptId, source, pack),
        source,
        versions: [],
        addedAt: this.#now(),
        ...(pack === undefined ? {} : { packId: pack.manifest.id }),
        ...(pack === undefined && known !== undefined ? { known: known.id } : {}),
        ...((pack?.manifest.family ?? known?.family) === undefined ? {} : { family: (pack?.manifest.family ?? known?.family)! }),
      }
      this.#state.scripts.push(script)
    }
    script.versions = script.versions.filter(v => v.version !== version)
    script.versions.push({ version, dir, installedAt: this.#now(), asset })
    script.current = version
    delete script.update
    script.probe = await probeProject(dir)
    if (script.family === undefined && script.probe.family !== undefined) script.family = script.probe.family
    await this.#prune(script)
    await this.#save()
    this.#options.onChanged(scriptId)

    if (pack !== undefined && pack.manifest.install.requires.length > 0) {
      ctl?.phase('checking', { message: '检查运行环境' })
      await this.envCheck(scriptId)
    }
  }

  // ── setup programs ──────────────────────────────────────────────────

  /**
   * The download is a setup program: keep it for the agent instead of
   * unpacking it. Without `byAgent` the app starts a conversation for it.
   * @returns the version it will install.
   */
  async #handOffSetup(kind: SetupKind, setup: Omit<PendingSetup, 'kind' | 'name' | 'at'>, byAgent: boolean, ctl: JobControl): Promise<string> {
    const pack = setup.packId === undefined ? undefined : this.#packs.get(setup.packId)
    const pending: PendingSetup = { ...setup, kind, name: this.#state.scripts.find(s => s.id === setup.scriptId)?.name ?? newName(setup.scriptId, setup.source, pack), at: this.#now() }
    for (const old of this.#state.setups.filter(s => s.scriptId === setup.scriptId && !samePath(s.file, setup.file))) await rm(old.file, { force: true })
    this.#state.setups = [...this.#state.setups.filter(s => s.scriptId !== setup.scriptId), pending]
    await this.#save()
    this.#options.onChanged(setup.scriptId)
    const what = `${basename(setup.file)} 是 ${SETUP_NAMES[kind]} 安装程序，不是压缩包`
    const handed = { kind, dir: setup.dir }
    const sessionId = byAgent ? undefined : await this.#options.onSetup?.(pending).catch(error => {
      this.#options.log.warn(`${setup.scriptId}: setup program not handed to the agent: ${errorText(error)}`)
      return undefined
    })
    if (sessionId === undefined) {
      ctl.phase('running', { message: `${what}：让 agent 用 script_setup_run 运行它，装好后用 script_import 导入 ${setup.dir}`, setup: handed })
    } else {
      ctl.phase('running', { message: `${what}，已交给 agent 安装（对话「安装脚本：${pending.name}」）`, setup: { ...handed, sessionId } })
    }
    return setup.version
  }

  /** The setup program waiting to be run for a script, if any. */
  pendingSetup(id: string): PendingSetup | undefined {
    return this.#state.setups.find(s => s.scriptId === id)
  }

  /** Note how the agent is doing with a script's waiting setup program (undefined: no agent on it). */
  async setSetupAgent(id: string, agent: SetupAgent | undefined): Promise<void> {
    const setup = this.pendingSetup(id)
    if (setup === undefined) return
    if (agent === undefined) delete setup.agent
    else setup.agent = agent
    await this.#save()
    this.#options.onChanged(id)
  }

  /** Give up a script's waiting setup program: deleted, nothing installed. */
  async discardSetup(id: string): Promise<void> {
    const setup = this.pendingSetup(id)
    if (setup === undefined) return
    this.#state.setups = this.#state.setups.filter(s => s !== setup)
    await rm(setup.file, { force: true })
    await this.#save()
    this.#options.onChanged(id)
  }

  /**
   * Run a script's waiting setup program: quietly into its folder, waiting
   * until it is done; or with its own window (returning at once), for the
   * agent to click through. Then `import` of that folder finishes the install.
   */
  async runSetup(id: string, options: { quiet: boolean; signal?: AbortSignal }): Promise<{ dir: string; result: string; exitCode?: number; files?: number; executables?: string[] }> {
    const setup = this.pendingSetup(id)
    if (setup === undefined) throw new Error(`${id} 没有等待运行的安装程序`)
    if (!(await exists(setup.file))) {
      this.#state.setups = this.#state.setups.filter(s => s !== setup)
      await this.#save()
      throw new Error(`安装程序 ${setup.file} 已经不在了：请重新安装或更新 ${setup.name}`)
    }
    // A new version folder starts empty; a local import's own folder is installed over.
    const fresh = this.#ownsDir(setup.dir) && this.#state.scripts.find(s => s.id === id)?.versions.some(v => samePath(v.dir, setup.dir)) !== true
    if (options.quiet && fresh) await rm(setup.dir, { recursive: true, force: true })
    const exitCode = await runSetup(setup.file, { kind: setup.kind, dir: setup.dir, quiet: options.quiet, ...(options.signal === undefined ? {} : { signal: options.signal }) })
    if (exitCode === undefined) return { dir: setup.dir, result: `${SETUP_NAMES[setup.kind]} 安装程序的窗口已经打开，安装位置预先填好了 ${setup.dir}` }
    const files = await exists(setup.dir) ? (await listFiles(setup.dir)).length : 0
    this.#options.log.info(`${id}: setup ${basename(setup.file)} exited ${exitCode}, ${files} file(s) in ${setup.dir}`)
    return { dir: setup.dir, exitCode, result: setupExitText(setup.kind, exitCode), files, executables: files === 0 ? [] : (await probeProject(setup.dir)).executables }
  }

  /** The agent imported the folder a setup program installed into: the install (or update) is done. */
  async #finishSetup(setup: PendingSetup, path: string, request: { name?: string | undefined; packId?: string | undefined }): Promise<ScriptInfo> {
    if (!(await stat(path).then(s => s.isDirectory(), () => false))) throw new Error(`不是一个存在的目录：${path}`)
    if ((await listFiles(path)).length === 0) throw new Error(`${path} 是空的：安装程序还没把文件装进去`)
    const script = this.#state.scripts.find(s => s.id === setup.scriptId)
    const pack = setup.packId === undefined ? undefined : this.#packs.get(setup.packId)
    const inside = (dir: string) => { const rel = relative(join(this.toolsDir, setup.scriptId), dir); return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel) }
    let id = setup.scriptId
    if (script?.source.kind === 'local') {
      if (!samePath(script.source.path, path)) throw new Error(`${script.name} 在 ${script.source.path}，安装程序要装回那里（现在给的是 ${path}）`)
      script.localVersion = { version: setup.version, from: '安装程序' }
      delete script.update
      script.probe = await probeProject(path)
    } else if (inside(path)) {
      await this.#addVersion(setup.scriptId, setup.source, pack, setup.version, path, setup.asset, undefined, request.name ?? setup.name)
    } else if (script !== undefined) {
      throw new Error(`安装程序装到了 ${path}；${script.name} 的新版本要装在 ${setup.dir}`)
    } else {
      // Installed somewhere else (chosen in the installer's window): a local import of that version.
      id = (await this.#importLocal(path, { id: setup.scriptId, name: request.name ?? setup.name, packId: request.packId ?? setup.packId })).id
      this.#script(id).localVersion ??= { version: setup.version, from: '安装程序' }
    }
    this.#state.setups = this.#state.setups.filter(s => s !== setup)
    await rm(setup.file, { force: true })
    await this.#save()
    this.#options.onChanged(id)
    return this.#info(this.#script(id))
  }

  /**
   * Update a local import where it is. The release is unpacked aside; every
   * file it would overwrite or delete is first copied to
   * `<toolsDir>/<id>/.local-backup/<time>/files/`; the pack's config files
   * (and the usual user-data folders) that exist are left as they are. A
   * failure part way (a file in use) puts the old files back.
   */
  async #localUpdateJob(script: StoredScript, channels: Channels, ctl: JobControl, byAgent = false): Promise<string> {
    const target = (script.source as { path: string }).path
    const pack = this.#packOf(script)
    const fetched = await this.#fetch(script.id, channels, pack, script.localVersion?.version, ctl)
    const { version } = fetched
    const archive = fetched.archive!
    const setup = await setupKind(archive)
    if (setup !== undefined) {
      return this.#handOffSetup(setup, { scriptId: script.id, file: archive, version, asset: fetched.asset, dir: target, source: script.source, ...(pack === undefined ? {} : { packId: pack.manifest.id }), update: true }, byAgent, ctl)
    }
    const root = pack?.manifest.install.root
    const staging = join(this.toolsDir, script.id, '.staging')
    try {
      ctl.phase('extracting', { message: `解压 ${fetched.asset.name}` })
      await rm(staging, { recursive: true, force: true })
      await extract(archive, staging, { signal: ctl.signal, ...(fetched.incremental || root === undefined ? {} : { root }) })
      const prefix = fetched.incremental ? await patchPrefix(staging, target, root) : undefined
      const from = prefix === undefined ? staging : join(staging, prefix)
      const keep = await keptFiles(pack, target)
      const writes = (await listFiles(from)).filter(rel => !keep.has(rel.toLowerCase()) && !(fetched.incremental && from === staging && rel === 'changes.json'))
      const removes: string[] = []
      for (const rel of fetched.incremental ? await readMirrorChanges(staging, prefix) ?? [] : []) {
        if (!keep.has(rel.toLowerCase()) && await exists(join(target, ...rel.split('/')))) removes.push(rel)
      }

      const at = this.#now()
      const dir = join(this.toolsDir, script.id, '.local-backup', String(at))
      const backup: LocalBackup = { dir, to: version, at, added: [], saved: [], ...(script.localVersion === undefined ? {} : { from: script.localVersion.version }) }
      ctl.phase('running', { message: `备份将被替换的文件（${target}）` })
      for (const rel of writes) {
        const path = join(target, ...rel.split('/'))
        if (await exists(path)) {
          await saveCopy(path, join(dir, 'files', ...rel.split('/')))
          backup.saved.push(rel)
        } else {
          backup.added.push(rel)
        }
      }
      for (const rel of removes) {
        await saveCopy(join(target, ...rel.split('/')), join(dir, 'files', ...rel.split('/')))
        backup.saved.push(rel)
      }
      await writeFile(join(dir, 'manifest.json'), `${JSON.stringify({ script: script.id, target, ...backup }, null, 2)}\n`)

      ctl.phase('running', { message: `更新 ${target} 到 ${version}` })
      let doing = ''
      try {
        for (const rel of writes) {
          doing = rel
          const path = join(target, ...rel.split('/'))
          await mkdir(dirname(path), { recursive: true })
          await copyFile(join(from, ...rel.split('/')), path)
        }
        for (const rel of removes) {
          doing = rel
          await rm(join(target, ...rel.split('/')), { recursive: true, force: true })
        }
      } catch (error) {
        const back = await putBack(target, backup).then(() => '已改回更新前的文件', e => `改回时也出错了（${errorText(e)}），备份在 ${dir}`)
        await rm(dir, { recursive: true, force: true }).catch(() => {})
        const code = (error as NodeJS.ErrnoException).code
        throw new Error(code === 'EBUSY' || code === 'EPERM' || code === 'EACCES'
          ? `${doing} 正被占用或没有写入权限，请先关闭脚本再更新；${back}`
          : `更新 ${doing} 时出错：${errorText(error)}；${back}`)
      }

      script.backups = [...(script.backups ?? []), backup]
      const keepBackups = this.#state.settings.keepVersions
      for (const old of script.backups.slice(0, -keepBackups)) await rm(old.dir, { recursive: true, force: true })
      script.backups = script.backups.slice(-keepBackups)
      script.localVersion = { version, from: '更新' }
      delete script.update
      script.probe = await probeProject(target)
      await this.#save()
      this.#options.onChanged(script.id)
      this.#options.log.info(`${script.id}: updated ${target} in place to ${version} (${backup.saved.length} replaced, ${backup.added.length} added)`)
      return version
    } finally {
      await rm(staging, { recursive: true, force: true })
      await rm(archive, { force: true })
    }
  }

  /** Undo a local import's last in-place update: the files it replaced or removed back, the ones it added deleted. */
  async restore(id: string): Promise<ScriptInfo> {
    const script = this.#script(id)
    if (script.source.kind !== 'local') throw new Error('安装的脚本请用回滚切换版本')
    if (this.#jobs.active(id) !== undefined) throw new Error(`${id} 有任务正在进行，请稍后再撤销`)
    const backup = script.backups?.at(-1)
    if (backup === undefined) throw new Error('没有可以撤销的更新')
    if (!(await exists(join(backup.dir, 'manifest.json')))) throw new Error(`备份已不存在：${backup.dir}`)
    try {
      await putBack(script.source.path, backup)
    } catch (error) {
      throw new Error(`撤销失败（${errorText(error)}）：可能有文件正被占用，请先关闭脚本再试`)
    }
    await rm(backup.dir, { recursive: true, force: true })
    script.backups = script.backups!.slice(0, -1)
    const found = await this.#detectVersion(script)
    if (found !== undefined) script.localVersion = found
    else if (backup.from !== undefined) script.localVersion = { version: backup.from, from: '撤销更新' }
    else delete script.localVersion
    delete script.update
    await this.#save()
    this.#options.onChanged(id)
    return this.#info(script)
  }

  /**
   * A script's update channels, each on its own: what the user set (or
   * turned off), how it was installed, its pack, the known project.
   */
  #channels(script: StoredScript): Channels {
    const pack = this.#packOf(script)
    const known = knownById(script.known)
    const source = script.source
    const github: Channels['github'] = source.kind === 'github'
      ? { repo: source.repo, from: 'install' }
      : script.updateFrom === null ? undefined
        : script.updateFrom !== undefined ? { repo: script.updateFrom, from: 'user' }
          : pack?.manifest.source.github !== undefined ? { repo: pack.manifest.source.github, from: 'pack' }
            : known?.repo !== undefined ? { repo: known.repo, from: 'known' } : undefined
    const byRepo = mirrorResourceFor(pack, github?.repo)
    const mirror: Channels['mirror'] = source.kind === 'mirrorchyan'
      ? { resource: resourceOf(source), from: 'install' }
      : script.mirrorchyan === null ? undefined
        : script.mirrorchyan !== undefined ? { resource: script.mirrorchyan, from: 'user' }
          : pack?.manifest.source.mirrorchyan !== undefined ? { resource: pack.manifest.source.mirrorchyan, from: 'pack' }
            : known?.mirrorchyan !== undefined ? { resource: known.mirrorchyan, from: 'known' }
              : byRepo !== undefined ? { resource: byRepo, from: 'known' } : undefined
    return { ...(github === undefined ? {} : { github }), ...(mirror === undefined ? {} : { mirror }) }
  }

  /** The channels a new install starts with. */
  #newChannels(source: ScriptSource, pack: LoadedPack | undefined): Channels {
    const draft: StoredScript = {
      id: '', name: '', source, versions: [], addedAt: 0,
      ...(pack === undefined ? {} : { packId: pack.manifest.id }),
      ...(() => {
        const known = source.kind === 'github' ? knownByRepo(source.repo) : source.kind === 'mirrorchyan' ? knownByMirror(source.rid) : undefined
        return pack === undefined && known !== undefined ? { known: known.id } : {}
      })(),
    }
    return this.#channels(draft)
  }

  /** A local import no pack describes: is it a known project? (Also for folders imported before it was known.) */
  async #recognize(script: StoredScript): Promise<void> {
    if (script.source.kind !== 'local' || script.packId !== undefined || script.known !== undefined) return
    const known = await knownByDir(script.source.path)
    if (known === undefined) return
    script.known = known.id
    if (script.family === undefined && known.family !== undefined) script.family = known.family
    await this.#save()
  }

  #packOf(script: StoredScript): LoadedPack | undefined {
    return script.packId === undefined ? undefined : this.#packs.get(script.packId)
  }

  #packForMirror(rid: string): LoadedPack | undefined {
    const lower = rid.toLowerCase()
    return [...this.#packs.values()].find(p => p.manifest.source.mirrorchyan?.rid.toLowerCase() === lower)
      ?? (knownByMirror(rid)?.repo === undefined ? undefined : packForRepo(this.#packs, knownByMirror(rid)!.repo!))
  }

  /** The version in a local import's directory: where its pack (or the known project) says, else the usual places and its main program's file version. */
  #detectVersion(script: StoredScript): Promise<DetectedVersion | undefined> {
    const pack = this.#packOf(script)
    const known = knownById(script.known)
    const top = (script.probe?.executables ?? []).filter(e => !/[\\/]/.test(e) && !/unins|update|crash|adb|setup|helper/i.test(e))
    const main = pack?.manifest.launch?.exe
    const executables = [...(main === undefined ? [] : [main]), ...top]
    const spec = pack?.manifest.install.version ?? known?.version
    return detectVersion((script.source as { path: string }).path, {
      ...(spec === undefined ? {} : { spec }),
      executables: [...new Set(executables)],
      host: this.#options.envHost ?? systemHost,
    })
  }

  /**
   * The release file over the script's channels: Mirror酱 with a CDK (an
   * incremental package from `from` when it has one), else GitHub. A script
   * only on Mirror酱 needs the CDK, and says so.
   */
  async #fetch(scriptId: string, channels: Channels, pack: LoadedPack | undefined, from: string | undefined, ctl: JobControl, request: Pick<InstallRequest, 'tag' | 'asset'> = {}, have?: (version: string) => boolean): Promise<Fetched> {
    const onlyMirror = channels.github === undefined
    if (channels.mirror !== undefined) {
      const fetched = await this.#fromMirror(scriptId, channels.mirror.resource, from, ctl, onlyMirror, have)
      if (fetched !== undefined) return fetched
    }
    if (channels.github === undefined) throw new Error('这个脚本没有可以下载的更新渠道')
    return this.#fromGitHub(scriptId, { repo: channels.github.repo, ...request }, pack, ctl, have)
  }

  /** The release's file from GitHub (through the download mirror); no download when `have` says the version is already there. */
  async #fromGitHub(scriptId: string, request: { repo: string; tag?: string | undefined; asset?: string | undefined }, pack: LoadedPack | undefined, ctl: JobControl, have?: (version: string) => boolean): Promise<Fetched> {
    const settings = this.#state.settings
    ctl.phase('resolving', { message: `读取 ${request.repo} 的发布信息` })
    const github = this.#github()
    const release = request.tag === undefined
      ? await github.latest(request.repo, { includePrereleases: this.#prereleases(pack), signal: ctl.signal })
      : await github.release(request.repo, request.tag, ctl.signal)
    const asset = request.asset === undefined
      ? (() => {
        const choice = chooseAsset(release.assets, { ...globsOf(pack), tag: release.tag })
        if (choice.asset === undefined) throw new Error(`${choice.reason}。可选文件：${release.assets.map(a => a.name).join('、') || '（无）'}`)
        return choice.asset
      })()
      : release.assets.find(a => a.name === request.asset) ?? (() => { throw new Error(`${release.tag} 里没有文件 ${request.asset}`) })()
    const version = versionOfTag(release.tag)
    if (have?.(version) === true) return { version, asset: { name: asset.name, size: asset.size }, incremental: false }

    const archive = join(this.toolsDir, scriptId, '.downloads', asset.name)
    ctl.phase('downloading', { message: asset.name, received: 0, total: asset.size })
    await download({
      url: asset.downloadUrl,
      dest: archive,
      mirror: settings.downloadMirror,
      mirrorFallback: settings.mirrorFallback,
      expectedSize: asset.size,
      ...(asset.digest === undefined ? {} : { digest: asset.digest }),
      signal: ctl.signal,
      onProgress: (received, total) => ctl.phase('downloading', { message: asset.name, received, ...(total === undefined ? {} : { total }) }),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    })
    return { version, archive, asset: { name: asset.name, size: asset.size }, incremental: false }
  }

  /**
   * With the user's CDK: the latest release from Mirror酱, as an incremental
   * package over `from` (the version there now) when it has one.
   * @returns undefined to use GitHub instead (no CDK, a CDK problem, no
   * download link — said in the job's message); with `required` (no GitHub
   * channel) those are errors instead.
   */
  async #fromMirror(scriptId: string, resource: MirrorResource, from: string | undefined, ctl: JobControl, required: boolean, have?: (version: string) => boolean): Promise<Fetched | undefined> {
    const cdk = await this.#options.credential(this.#state.settings.cdkRef)
    if (cdk === undefined || cdk === '') {
      if (required) throw new Error(`${resource.rid} 只能从 Mirror酱 下载：请先在「设置 → 脚本安装」填写 Mirror酱 CDK`)
      return undefined
    }
    const options = this.#mirrorOptions(cdk, ctl.signal)
    let latest: MirrorLatest
    try {
      ctl.phase('resolving', { message: `从 Mirror酱 查询 ${resource.rid} 的最新版本` })
      latest = await mirrorLatest(resource, options)
      // Asked again from the version there now: Mirror酱 then hands out only what changed.
      if (from !== undefined && compareVersions(versionOfTag(latest.version), from) > 0) {
        const current = latest.version.startsWith('v') ? `v${from}` : from
        const incremental = await mirrorLatest(resource, { ...options, currentVersion: current }).catch(() => undefined)
        if (incremental?.url !== undefined && incremental.version === latest.version) latest = incremental
      }
    } catch (error) {
      if (ctl.signal.aborted || required) throw error
      this.#options.log.warn(`${scriptId}: Mirror酱: ${errorText(error)}`)
      ctl.phase('resolving', { message: `${errorText(error)}；改从 GitHub 下载` })
      return undefined
    }
    const version = versionOfTag(latest.version)
    const incremental = latest.updateType === 'incremental' && from !== undefined
    const name = `Mirror酱 ${incremental ? '增量包' : '完整包'} ${latest.version}`
    if (have?.(version) === true) return { version, asset: { name, size: latest.size ?? 0 }, incremental: false }
    if (latest.url === undefined) {
      if (required) throw new Error(`Mirror酱 没有给出 ${resource.rid} 的下载地址`)
      ctl.phase('resolving', { message: 'Mirror酱 没有给出下载地址；改从 GitHub 下载' })
      return undefined
    }

    let archive = join(this.toolsDir, scriptId, '.downloads', mirrorFileName(latest.url, resource.rid, latest.version))
    ctl.phase('downloading', { message: `${name}（Mirror酱）`, received: 0, ...(latest.size === undefined ? {} : { total: latest.size }) })
    const downloaded = await download({
      url: latest.url,
      dest: archive,
      ...(latest.size === undefined ? {} : { expectedSize: latest.size }),
      ...(latest.sha256 === undefined ? {} : { digest: `sha256:${latest.sha256}` }),
      signal: ctl.signal,
      onProgress: (received, total) => ctl.phase('downloading', { message: `${name}（Mirror酱）`, received, ...(total === undefined ? {} : { total }) }),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    })
    archive = await realName(archive, downloaded.finalUrl)
    return { version, archive, asset: { name, size: latest.size ?? 0 }, incremental }
  }

  /**
   * The newest version where the update will come from: Mirror酱 with a CDK
   * (or when it is the only channel; asking needs no CDK), else GitHub.
   */
  async #latestVersion(channels: Channels, pack: LoadedPack | undefined, signal?: AbortSignal): Promise<string> {
    const mirror = channels.mirror?.resource
    const cdk = mirror === undefined ? undefined : await this.#options.credential(this.#state.settings.cdkRef)
    if (mirror !== undefined && ((cdk !== undefined && cdk !== '') || channels.github === undefined)) {
      try {
        return versionOfTag((await mirrorLatest(mirror, this.#mirrorOptions(undefined, signal))).version)
      } catch (error) {
        if (signal?.aborted === true || channels.github === undefined) throw error
        this.#options.log.warn(`${mirror.rid}: Mirror酱: ${errorText(error)}; asking GitHub`)
      }
    }
    const latest = await this.#github().latest(channels.github!.repo, { includePrereleases: this.#prereleases(pack), ...(signal === undefined ? {} : { signal }) })
    return versionOfTag(latest.tag)
  }

  #mirrorOptions(cdk: string | undefined, signal: AbortSignal | undefined) {
    return {
      ...(cdk === undefined ? {} : { cdk }),
      ...(signal === undefined ? {} : { signal }),
      ...(this.#options.mirrorchyanBase === undefined ? {} : { base: this.#options.mirrorchyanBase }),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    }
  }

  /** Keep the newest `keepVersions` versions, always including the current one. */
  async #prune(script: StoredScript): Promise<void> {
    const keep = this.#state.settings.keepVersions
    const ordered = [...script.versions].sort((a, b) => b.installedAt - a.installedAt)
    const kept = new Set(ordered.slice(0, keep).map(v => v.version))
    if (script.current !== undefined) kept.add(script.current)
    for (const version of ordered.filter(v => !kept.has(v.version))) {
      if (this.#ownsDir(version.dir)) await rm(version.dir, { recursive: true, force: true })
    }
    script.versions = script.versions.filter(v => kept.has(v.version))
  }

  async rollback(id: string, version?: string): Promise<ScriptInfo> {
    const script = this.#script(id)
    if (script.source.kind === 'local') throw new Error('本地导入的脚本只有一个目录，无法回滚；在这里更新过的可以「撤销上次更新」')
    if (this.#jobs.active(id) !== undefined) throw new Error(`${id} 有任务正在进行，请稍后再回滚`)
    const ordered = [...script.versions].sort((a, b) => b.installedAt - a.installedAt)
    const target = version === undefined
      ? ordered.find(v => v.version !== script.current)
      : ordered.find(v => v.version === version)
    if (target === undefined) throw new Error(version === undefined ? '没有可以回滚到的旧版本' : `没有安装版本 ${version}`)
    if (!(await exists(target.dir))) throw new Error(`版本目录已不存在：${target.dir}`)
    script.current = target.version
    await this.#save()
    this.#options.onChanged(id)
    return this.#info(script)
  }

  // ── local import ──────────────────────────────────────────────────────

  /** Where library state lives; plugins keep their own files beside it. */
  get dataDir(): string {
    return this.#options.dataDir
  }

  /** The user's pack directory: packs here override built-in ones by id. */
  get userPackDir(): string {
    return join(this.#options.dataDir, 'packs')
  }

  /** Describe a script with a (reloaded) pack, e.g. after the user accepted a draft. */
  async attachPack(scriptId: string, packId: string): Promise<ScriptInfo> {
    const script = this.#script(scriptId)
    const pack = this.#packs.get(packId)
    if (pack === undefined) throw new Error(`没有脚本包 ${packId}`)
    script.packId = packId
    if (pack.manifest.family !== undefined) script.family = pack.manifest.family
    await this.#save()
    this.#options.onChanged(scriptId)
    if (pack.manifest.install.requires.length > 0) await this.envCheck(scriptId)
    return this.#info(script)
  }

  /** Register a folder in place; the folder a waiting setup program installed into (by id, or by its folder) finishes that install instead. */
  async import(request: { path: string; id?: string | undefined; name?: string | undefined; packId?: string | undefined }): Promise<ScriptInfo> {
    const path = resolve(request.path)
    const setup = (request.id === undefined ? undefined : this.pendingSetup(request.id)) ?? this.#state.setups.find(s => samePath(s.dir, path))
    if (setup !== undefined) return this.#finishSetup(setup, path, request)
    return this.#importLocal(path, request)
  }

  async #importLocal(path: string, request: { id?: string | undefined; name?: string | undefined; packId?: string | undefined }): Promise<ScriptInfo> {
    if (!(await stat(path).then(s => s.isDirectory(), () => false))) throw new Error(`不是一个存在的目录：${path}`)
    if (this.#ownsDir(path)) throw new Error('这个目录在工具目录里，由安装器管理，不需要导入')
    const same = this.#state.scripts.find(s => s.source.kind === 'local' && samePath(s.source.path, path))
    if (same !== undefined) return this.#info(same)

    // Packs may have been added or removed on disk since the last load.
    await this.reloadPacks()
    let pack: LoadedPack | undefined
    if (request.packId !== undefined) {
      pack = this.#packs.get(request.packId)
      if (pack === undefined) throw new Error(`没有脚本包 ${request.packId}`)
    } else {
      for (const candidate of this.#packs.values()) {
        const files = candidate.manifest.detect?.files
        if (files !== undefined && await matchesDetect(path, files)) {
          pack = candidate
          break
        }
      }
    }
    const probe = await probeProject(path)
    const known = pack === undefined ? await knownByDir(path) : undefined
    const base = request.id ?? pack?.manifest.id ?? known?.id ?? slug(basename(path))
    const id = this.#freeId(base)
    const script: StoredScript = {
      id,
      name: request.name ?? pack?.manifest.name ?? known?.name ?? basename(path),
      source: { kind: 'local', path },
      current: 'local',
      versions: [{ version: 'local', dir: path, installedAt: this.#now() }],
      probe,
      addedAt: this.#now(),
      ...(pack === undefined ? {} : { packId: pack.manifest.id }),
      ...(known === undefined ? {} : { known: known.id }),
      ...(pack?.manifest.family ?? known?.family ?? probe.family) === undefined ? {} : { family: (pack?.manifest.family ?? known?.family ?? probe.family)! },
    }
    const found = await this.#detectVersion(script)
    if (found !== undefined) script.localVersion = found
    this.#state.scripts.push(script)
    await this.#save()
    this.#options.onChanged(id)
    if (pack !== undefined && pack.manifest.install.requires.length > 0) await this.envCheck(id)
    return this.#info(script)
  }

  /** Forget a script; installed versions are deleted only with `deleteFiles`, imported directories never. */
  async remove(id: string, deleteFiles = false): Promise<void> {
    const script = this.#script(id)
    if (this.#jobs.active(id) !== undefined) throw new Error(`${id} 有任务正在进行，请先取消`)
    if (deleteFiles && script.source.kind !== 'local') {
      const dir = join(this.toolsDir, id)
      if (this.#ownsDir(dir)) await rm(dir, { recursive: true, force: true })
    }
    // A local import's own directory stays; the backups of its updates were ours.
    if (script.source.kind === 'local') await rm(join(this.toolsDir, id, '.local-backup'), { recursive: true, force: true })
    for (const setup of this.#state.setups.filter(s => s.scriptId === id)) await rm(setup.file, { force: true })
    this.#state.setups = this.#state.setups.filter(s => s.scriptId !== id)
    this.#state.scripts = this.#state.scripts.filter(s => s.id !== id)
    await this.#save()
    this.#options.onChanged(id)
  }

  // ── environment ───────────────────────────────────────────────────────

  async envCheck(id: string): Promise<EnvReport> {
    const { report } = await this.#check(this.#script(id))
    return report
  }

  /** What fixing `kind` would run, from a fresh check; undefined when it is already fine. */
  async envFixPlan(id: string, kind: string): Promise<FixPlan | undefined> {
    const { plans } = await this.#check(this.#script(id))
    return plans.get(kind)
  }

  envFix(id: string, kind: string, plan: FixPlan): { job: ScriptJob; done: Promise<ScriptJob> } {
    return this.#jobs.start('env-fix', id, async ctl => {
      ctl.phase('running', { message: plan.description })
      await applyFix(plan, {
        sharedDir: this.sharedDir,
        signal: ctl.signal,
        download: async (url, dest, onProgress) => {
          // Mirrors only proxy GitHub; official vendor downloads go direct.
          const github = /^https:\/\/(github\.com|objects\.githubusercontent\.com)\//.test(url)
          await download({
            url, dest, signal: ctl.signal, onProgress,
            ...(github ? { mirror: this.#state.settings.downloadMirror, mirrorFallback: this.#state.settings.mirrorFallback } : {}),
            ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
          })
        },
        onPhase: (phase, received, total) => ctl.phase(phase, {
          message: plan.description,
          ...(received === undefined ? {} : { received }),
          ...(total === undefined ? {} : { total }),
        }),
        ...(this.#options.runElevated === undefined ? {} : { runElevated: this.#options.runElevated }),
      })
      ctl.phase('checking', { message: '重新检查运行环境' })
      const report = await this.envCheck(id)
      const item = report.items.find(i => i.kind === kind)
      if (item !== undefined && item.status !== 'ok') throw new Error(`处理完成，但 ${item.label} 仍为「${item.status}」${item.detail === undefined ? '' : `：${item.detail}`}`)
      return undefined
    })
  }

  async #check(script: StoredScript) {
    const pack = script.packId === undefined ? undefined : this.#packs.get(script.packId)
    const result = await checkEnvironment(pack?.manifest.install.requires ?? [], { host: this.#options.envHost ?? systemHost, sharedDir: this.sharedDir, checkers: Object.fromEntries(this.#checkers) }, this.#now())
    script.env = result.report
    await this.#save()
    this.#options.onChanged(script.id)
    return result
  }

  // ── helpers ───────────────────────────────────────────────────────────

  #github(): GitHubClient {
    const settings = this.#state.settings
    return new GitHubClient({
      apiBase: settings.apiBase,
      token: () => this.#options.credential(settings.tokenRef),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    })
  }

  #prereleases(pack: LoadedPack | undefined): boolean {
    return this.#state.settings.includePrereleases || pack?.manifest.source.release?.channel === 'prerelease'
  }

  #script(id: string): StoredScript {
    const script = this.#state.scripts.find(s => s.id === id)
    if (script === undefined) throw new Error(`脚本库里没有 ${id}`)
    return script
  }

  #info(script: StoredScript): ScriptInfo {
    const current = currentVersion(script)
    const job = this.#jobs.active(script.id)
    const channels = this.#channels(script)
    const last = script.backups?.at(-1)
    return {
      id: script.id,
      name: script.name,
      source: script.source,
      versions: [...script.versions].sort((a, b) => b.installedAt - a.installedAt).map(v => ({ ...v, current: v.version === script.current })),
      addedAt: script.addedAt,
      ...(script.packId === undefined ? {} : { packId: script.packId }),
      channels: {
        ...(channels.github === undefined ? {} : { github: channels.github }),
        ...(channels.mirror === undefined ? {} : { mirrorchyan: { rid: channels.mirror.resource.rid, from: channels.mirror.from } }),
      },
      ...(script.known === undefined ? {} : { known: script.known }),
      ...(script.localVersion === undefined ? {} : { localVersion: script.localVersion }),
      ...(last === undefined ? {} : { undo: { to: last.to, at: last.at, ...(last.from === undefined ? {} : { from: last.from }) } }),
      ...(script.family === undefined ? {} : { family: script.family }),
      ...(current === undefined ? {} : { current: current.version, dir: current.dir }),
      ...(script.env === undefined ? {} : { env: script.env }),
      ...(script.probe === undefined ? {} : { probe: script.probe }),
      ...(script.update === undefined ? {} : { update: script.update }),
      ...(job === undefined ? {} : { jobId: job.id }),
      ...(script.summary === undefined ? {} : { summary: script.summary }),
    }
  }

  /**
   * What the agent gets to sum a script up: where it came from, its pack, the
   * files at the top of its folder and its README (the start of it).
   */
  async summaryMaterial(id: string): Promise<string> {
    const script = this.#state.scripts.find(s => s.id === id)
    if (script === undefined) throw new Error(`脚本库里没有 ${id}`)
    const info = this.#info(script)
    const pack = this.packOf(id)
    const known = knownById(script.known)
    const lines = [
      `名字：${script.name}（id ${script.id}）`,
      `来源：${script.source.kind === 'github' ? `GitHub ${script.source.repo}` : script.source.kind === 'mirrorchyan' ? `Mirror酱 ${script.source.rid}` : `本地导入 ${script.source.path}`}`,
      ...(info.current === undefined ? [] : [`版本：${info.current}`]),
      ...(known === undefined ? [] : [`认出来是：${known.name}${known.repo === undefined ? '' : `（${known.repo}）`}`]),
      ...(info.channels.github === undefined ? [] : [`GitHub 更新渠道：${info.channels.github.repo}`]),
    ]
    if (pack !== undefined) {
      const m = pack.manifest
      lines.push(`脚本包：${m.name}${m.description === undefined ? '' : `——${m.description}`}`)
      if (m.game?.name !== undefined) lines.push(`玩的游戏：${m.game.name}`)
      if (m.tasks.length > 0) lines.push(`脚本包里的任务：${m.tasks.map(t => t.title).join('、')}`)
    }
    if (info.dir !== undefined) {
      const entries = await readdir(info.dir, { withFileTypes: true }).catch(() => [])
      const names = entries.map(e => (e.isDirectory() ? `${e.name}/` : e.name)).sort()
      lines.push(`文件夹里（${names.length} 项）：${names.slice(0, 60).join('  ')}${names.length > 60 ? ' …' : ''}`)
      const readme = entries.filter(e => e.isFile() && /^read[ _-]?me.*\.(md|txt)$|^read[ _-]?me$/i.test(e.name))
        .sort((a, b) => Number(/zh|cn|中文/i.test(b.name)) - Number(/zh|cn|中文/i.test(a.name)) || a.name.length - b.name.length)[0]
      if (readme !== undefined) {
        const text = (await readFile(join(info.dir, readme.name), 'utf8').catch(() => '')).replace(/<!--[\s\S]*?-->/g, '').replace(/\n{3,}/g, '\n\n').trim()
        if (text !== '') lines.push('', `${readme.name}（开头部分）：`, text.slice(0, 6000))
      }
    }
    return lines.join('\n')
  }

  /** Keep the agent's summary of a script (or how getting it went). */
  async setSummary(id: string, summary: ScriptSummary): Promise<void> {
    const script = this.#state.scripts.find(s => s.id === id)
    if (script === undefined) return
    script.summary = summary
    await this.#save()
    this.#options.onChanged(id)
  }

  #freeId(base: string): string {
    const taken = new Set(this.#state.scripts.map(s => s.id))
    if (!taken.has(base)) return base
    for (let n = 2; ; n++) if (!taken.has(`${base}-${n}`)) return `${base}-${n}`
  }

  #ownsDir(dir: string): boolean {
    const rel = relative(this.toolsDir, resolve(dir))
    return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
  }

  #save(): Promise<void> {
    return this.#store.save(this.#state)
  }
}

/** A script's update channels, resolved (see `#channels`). */
interface Channels {
  readonly github?: { readonly repo: string; readonly from: ChannelFrom }
  readonly mirror?: { readonly resource: MirrorResource; readonly from: ChannelFrom }
}

/** Just how to ask Mirror酱 for it (rid, platform, os, arch), from anything carrying them. */
function resourceOf(r: MirrorResource): MirrorResource {
  return { rid: r.rid, platform: r.platform, ...(r.os === undefined ? {} : { os: r.os }), ...(r.arch === undefined ? {} : { arch: r.arch }) }
}

/** Lowercase, without spaces and punctuation, for matching names (《原神》 · Genshin → 原神genshin). */
function squash(text: string): string {
  return text.toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '')
}

function sameSource(a: ScriptSource, b: ScriptSource): boolean {
  if (a.kind === 'github' && b.kind === 'github') return a.repo.toLowerCase() === b.repo.toLowerCase()
  if (a.kind === 'mirrorchyan' && b.kind === 'mirrorchyan') return a.rid.toLowerCase() === b.rid.toLowerCase()
  return false
}

function describeSource(source: ScriptSource): string {
  return source.kind === 'github' ? source.repo : source.kind === 'mirrorchyan' ? `Mirror酱 ${source.rid}` : source.path
}

/** A release file downloaded for an install or update. */
interface Fetched {
  readonly version: string
  /** Undefined when that version was already there and nothing was downloaded. */
  readonly archive?: string
  readonly asset: { name: string; size: number }
  /** A Mirror酱 incremental package: only what changed, and changes.json. */
  readonly incremental: boolean
}

/**
 * Where an incremental package's files sit: under the pack's root, or under
 * the package's top folder that the install lifted off (one the directory
 * being updated does not have itself); undefined at the package root.
 */
async function patchPrefix(patch: string, baseDir: string, root: string | undefined): Promise<string | undefined> {
  if (root !== undefined && await exists(join(patch, root))) return root.replace(/\\/g, '/')
  const entries = (await readdir(patch, { withFileTypes: true })).filter(e => e.name !== 'changes.json')
  return entries.length === 1 && entries[0]!.isDirectory() && !(await exists(join(baseDir, entries[0]!.name))) ? entries[0]!.name : undefined
}

/** Every file under `dir` (or its `sub` folder), as `/`-separated paths relative to `dir`. */
async function listFiles(dir: string, sub = ''): Promise<string[]> {
  const files: string[] = []
  for (const entry of await readdir(join(dir, sub), { withFileTypes: true })) {
    const rel = sub === '' ? entry.name : `${sub}/${entry.name}`
    if (entry.isDirectory()) files.push(...await listFiles(dir, rel))
    else if (entry.isFile()) files.push(rel)
  }
  return files
}

/** Folders scripts usually keep the user's data in: an in-place update leaves what is there. */
const USER_DATA = new Set(['config', 'configs', 'user', 'userdata', 'settings', 'cache', 'log', 'logs', 'debug'])

/**
 * Files an in-place update must not overwrite or delete, lowercased: the
 * pack's config files that exist in `dir`, and everything in the usual
 * user-data folders at its top.
 */
async function keptFiles(pack: LoadedPack | undefined, dir: string): Promise<Set<string>> {
  const kept = new Set<string>()
  for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
    if (entry.isDirectory() && USER_DATA.has(entry.name.toLowerCase())) {
      for (const rel of await listFiles(dir, entry.name).catch(() => [] as string[])) kept.add(rel.toLowerCase())
    }
  }
  for (const file of pack?.manifest.config.files ?? []) {
    if (file.keepOnUpdate === false) continue
    const parts = file.path.split(/[\\/]/)
    const last = parts.pop()!
    const sub = parts.join('/')
    const names = last.includes('*') || last.includes('?')
      ? (await readdir(join(dir, sub)).catch(() => [] as string[])).filter(n => globToRegExp(last).test(n))
      : [last]
    for (const name of names) {
      if (await stat(join(dir, sub, name)).then(s => s.isFile(), () => false)) kept.add((sub === '' ? name : `${sub}/${name}`).toLowerCase())
    }
  }
  return kept
}

/** Copy a file or folder to `dest`, making its parent folders. */
async function saveCopy(path: string, dest: string): Promise<void> {
  await mkdir(dirname(dest), { recursive: true })
  await cp(path, dest, { recursive: true, force: true })
}

/** Undo an in-place update of `target`: the files it added removed, the saved ones copied back. */
async function putBack(target: string, backup: LocalBackup): Promise<void> {
  for (const rel of backup.added) await rm(join(target, ...rel.split('/')), { force: true })
  for (const rel of backup.saved) {
    const saved = join(backup.dir, 'files', ...rel.split('/'))
    if (await exists(saved)) await saveCopy(saved, join(target, ...rel.split('/')))
  }
}

/** A new script's name: its pack's, the known project's, or from where it comes. */
function newName(scriptId: string, source: ScriptSource, pack: LoadedPack | undefined): string {
  const known = source.kind === 'github' ? knownByRepo(source.repo) : source.kind === 'mirrorchyan' ? knownByMirror(source.rid) : undefined
  return pack?.manifest.name ?? known?.name ?? (source.kind === 'github' ? source.repo.split('/')[1] : undefined) ?? (source.kind === 'mirrorchyan' ? source.rid : scriptId)
}

/**
 * A download saved under a made-up name (the link did not name the file)
 * gets the real one: from where the link redirected to, else from what the
 * bytes are. @returns its path now.
 */
async function realName(file: string, finalUrl: string): Promise<string> {
  let name: string | undefined
  try {
    const served = decodeURIComponent(basename(new URL(finalUrl).pathname))
    if (archiveKind(served) !== undefined && !/[\\/:*?"<>|]/.test(served)) name = served
  } catch { /* no name in it */ }
  if (name === undefined) {
    const found = await contentKind(file)
    if (found === undefined || archiveKind(basename(file)) === found.kind) return file
    name = basename(file).replace(/\.(zip|7z|tar(\.\w+)?|exe|msi)$/i, '') + found.ext
  }
  if (name === basename(file)) return file
  const renamed = join(dirname(file), name)
  await rm(renamed, { force: true })
  await rename(file, renamed)
  return renamed
}

/** The archive's name from Mirror酱's download link, or one made up with a zip extension. */
function mirrorFileName(url: string, rid: string, version: string): string {
  try {
    const name = basename(new URL(url).pathname)
    if (archiveKind(name) !== undefined) return name
  } catch { /* a made-up name below */ }
  return `mirrorchyan-${rid}-${version}.zip`.replace(/[\\/:*?"<>|]/g, '_')
}

function currentVersion(script: StoredScript): StoredVersion | undefined {
  return script.versions.find(v => v.version === script.current)
}

function globsOf(pack: LoadedPack | undefined): { globs?: string[] } {
  const asset = pack?.manifest.source.release?.asset
  return asset === undefined ? {} : { globs: Array.isArray(asset) ? asset : [asset] }
}

/** A directory name for a version: path separators and reserved characters replaced. */
function dirName(version: string): string {
  return version.replace(/[\\/:*?"<>|]/g, '_')
}

/** Lowercase id from a free-form name. */
function slug(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9._-]+/g, '-').replace(/^[-._]+|[-._]+$/g, '').slice(0, 64)
  return s === '' ? 'script' : s
}

function samePath(a: string, b: string): boolean {
  const norm = (p: string) => resolve(p).replace(/[\\/]+$/, '')
  return process.platform === 'win32' ? norm(a).toLowerCase() === norm(b).toLowerCase() : norm(a) === norm(b)
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

/**
 * Copy the pack's config files from the previous version into the new one,
 * so an update keeps the user's settings. `*` in the last path segment expands.
 * @returns the relative paths copied.
 */
async function carryConfig(pack: LoadedPack, fromDir: string, toDir: string): Promise<string[]> {
  const copied: string[] = []
  for (const file of pack.manifest.config.files) {
    if (file.keepOnUpdate === false) continue
    const parts = file.path.split(/[\\/]/)
    const last = parts.pop()!
    const sub = parts.join('/')
    const names = last.includes('*') || last.includes('?')
      ? (await readdir(join(fromDir, sub)).catch(() => [] as string[])).filter(n => globToRegExp(last).test(n))
      : [last]
    for (const name of names) {
      const source = join(fromDir, sub, name)
      if (!(await stat(source).then(s => s.isFile(), () => false))) continue
      const target = join(toDir, sub, name)
      await mkdir(dirname(target), { recursive: true })
      await copyFile(source, target)
      copied.push(sub === '' ? name : `${sub}/${name}`)
    }
  }
  return copied
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
