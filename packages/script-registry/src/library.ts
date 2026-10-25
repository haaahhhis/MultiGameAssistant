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
 * Nothing here names a particular script: behaviour comes from Script Packs.
 */
import { copyFile, cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve } from 'node:path'
import {
  applyFix, applyMirrorChanges, archiveKind, checkEnvironment, compareVersions, download, extract, GitHubClient, matchesDetect, mirrorLatest, probeProject, systemHost,
  type EnvChecker, type EnvHost, type FixPlan, type MirrorLatest,
} from '@adg/installer'
import { chooseAsset, globToRegExp, versionOfTag } from '@adg/pack-schema'
import type { EnvReport, InstallSettings, PackSummary, ReleaseInfo, ScriptInfo, ScriptJob } from '@adg/protocol'
import { JobBoard, type JobControl } from './jobs.ts'
import { mirrorResourceFor } from './mirror-resources.ts'
import { loadPacks, packForRepo, type LoadedPack, type PackDir, type PackLoadError } from './packs.ts'
import { DEFAULT_SETTINGS, StateStore, type LibraryState, type StoredScript, type StoredVersion } from './state.ts'

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
  readonly log: { info(message: string): void; warn(message: string): void }
}

export interface InstallRequest {
  readonly repo: string
  readonly tag?: string | undefined
  readonly asset?: string | undefined
  readonly id?: string | undefined
}

export class ScriptLibrary {
  readonly toolsDir: string
  readonly #options: LibraryOptions
  readonly #store: StateStore
  readonly #jobs: JobBoard
  readonly #now: () => number
  #state: LibraryState = { settings: DEFAULT_SETTINGS, scripts: [] }
  #packs = new Map<string, LoadedPack>()
  #packErrors: PackLoadError[] = []
  readonly #checkers = new Map<string, EnvChecker>()
  readonly #packListeners = new Set<() => void>()

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
    await this.reloadPacks()
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

  list(): { scripts: ScriptInfo[]; packs: PackSummary[]; toolsDir: string } {
    const used = new Set(this.#state.scripts.map(s => s.packId).filter(Boolean))
    const packs: PackSummary[] = [...this.#packs.values()].map(({ manifest, builtin }) => ({
      id: manifest.id,
      name: manifest.name,
      builtin,
      installed: used.has(manifest.id),
      ...(manifest.description === undefined ? {} : { description: manifest.description }),
      ...(manifest.source.github === undefined ? {} : { repo: manifest.source.github }),
      ...(manifest.family === undefined ? {} : { family: manifest.family }),
    }))
    for (const error of this.#packErrors) packs.push({ id: error.id, name: error.id, builtin: error.builtin, installed: false, error: error.error })
    return { scripts: this.#state.scripts.map(s => this.#info(s)), packs, toolsDir: this.toolsDir }
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

  /** Whether `repo` is described by a pack this installation ships (curated). */
  isKnownRepo(repo: string): boolean {
    return packForRepo(this.#packs, repo)?.builtin === true
  }

  /** Id an install of `repo` would use. */
  scriptIdFor(repo: string, id?: string): string {
    return id ?? packForRepo(this.#packs, repo)?.manifest.id ?? slug(repo.split('/')[1] ?? repo)
  }

  // ── installing ────────────────────────────────────────────────────────

  /** Start an install; the returned promise settles when the job ends. */
  install(request: InstallRequest): { job: ScriptJob; done: Promise<ScriptJob> } {
    const scriptId = this.scriptIdFor(request.repo, request.id)
    const existing = this.#state.scripts.find(s => s.id === scriptId)
    if (existing !== undefined && existing.source.kind === 'local') {
      throw new Error(`id ${scriptId} 已被本地导入的脚本使用，请换一个 id`)
    }
    if (existing !== undefined && existing.source.kind === 'github' && existing.source.repo.toLowerCase() !== request.repo.toLowerCase()) {
      throw new Error(`id ${scriptId} 已属于 ${existing.source.repo}，请换一个 id`)
    }
    return this.#jobs.start(existing === undefined ? 'install' : 'update', scriptId, ctl => this.#installJob(scriptId, request, ctl))
  }

  async checkUpdate(id: string, signal?: AbortSignal): Promise<{ current?: string; latest: string; available: boolean }> {
    const script = this.#script(id)
    if (script.source.kind !== 'github') throw new Error('本地导入的脚本没有发布来源，无法检查更新')
    const pack = script.packId === undefined ? undefined : this.#packs.get(script.packId)
    const version = await this.#latestVersion(script.source.repo, pack, signal)
    const available = script.current === undefined || compareVersions(version, script.current) > 0 || (compareVersions(version, script.current) === 0 && version !== script.current)
    script.update = { latest: version, available, checkedAt: this.#now() }
    await this.#save()
    this.#options.onChanged(id)
    return { ...(script.current === undefined ? {} : { current: script.current }), latest: version, available }
  }

  async update(id: string, signal?: AbortSignal): Promise<{ upToDate: true } | { upToDate: false; job: ScriptJob; done: Promise<ScriptJob> }> {
    const script = this.#script(id)
    const check = await this.checkUpdate(id, signal)
    if (!check.available) return { upToDate: true }
    const source = script.source as { kind: 'github'; repo: string }
    return { upToDate: false, ...this.install({ repo: source.repo, id }) }
  }

  async #installJob(scriptId: string, request: InstallRequest, ctl: JobControl): Promise<string> {
    const pack = packForRepo(this.#packs, request.repo)
    let script = this.#state.scripts.find(s => s.id === scriptId)
    const previous = script === undefined ? undefined : currentVersion(script)
    const fetched = await this.#fromMirror(scriptId, request, pack, previous, ctl) ?? await this.#fromGitHub(scriptId, request, pack, ctl)
    const { version, versionDir } = fetched
    if (script?.versions.some(v => v.version === version) === true) {
      script.current = version
      await this.#save()
      this.#options.onChanged(scriptId)
      ctl.phase('done', { message: `${version} 已安装，已切换为当前版本` })
      return version
    }
    if (previous !== undefined && pack !== undefined) {
      const carried = await carryConfig(pack, previous.dir, versionDir)
      if (carried.length > 0) this.#options.log.info(`${scriptId}: carried ${carried.length} config file(s) from ${previous.version}`)
    }

    if (script === undefined) {
      script = {
        id: scriptId,
        name: pack?.manifest.name ?? request.repo.split('/')[1] ?? scriptId,
        source: { kind: 'github', repo: request.repo },
        versions: [],
        addedAt: this.#now(),
        ...(pack === undefined ? {} : { packId: pack.manifest.id }),
        ...(pack?.manifest.family === undefined ? {} : { family: pack.manifest.family }),
      }
      this.#state.scripts.push(script)
    }
    script.versions.push({ version, dir: versionDir, installedAt: this.#now(), asset: fetched.asset })
    script.current = version
    delete script.update
    script.probe = await probeProject(versionDir)
    if (script.family === undefined && script.probe.family !== undefined) script.family = script.probe.family
    await this.#prune(script)
    await this.#save()
    this.#options.onChanged(scriptId)

    if (pack !== undefined && pack.manifest.install.requires.length > 0) {
      ctl.phase('checking', { message: '检查运行环境' })
      await this.envCheck(scriptId)
    }
    return version
  }

  /** The release's file from GitHub (through the download mirror), unpacked into its version's folder. */
  async #fromGitHub(scriptId: string, request: InstallRequest, pack: LoadedPack | undefined, ctl: JobControl): Promise<Fetched> {
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
    const versionDir = join(this.toolsDir, scriptId, dirName(version))
    if (this.#state.scripts.find(s => s.id === scriptId)?.versions.some(v => v.version === version) === true) return { version, versionDir, asset: { name: asset.name, size: asset.size } }

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
    ctl.phase('extracting', { message: `解压到 ${versionDir}` })
    await rm(versionDir, { recursive: true, force: true })
    await extract(archive, versionDir, { signal: ctl.signal, ...(pack?.manifest.install.root === undefined ? {} : { root: pack.manifest.install.root }) })
    await rm(archive, { force: true })
    return { version, versionDir, asset: { name: asset.name, size: asset.size } }
  }

  /**
   * With the user's CDK and a script published on Mirror酱 (installing or
   * updating to the latest): download it from there, as an incremental
   * package over the current version when Mirror酱 has one.
   * @returns undefined to use GitHub instead (no CDK, a specific release
   * asked for, nothing on Mirror酱, a CDK problem — said in the job's message).
   */
  async #fromMirror(scriptId: string, request: InstallRequest, pack: LoadedPack | undefined, previous: StoredVersion | undefined, ctl: JobControl): Promise<Fetched | undefined> {
    const resource = mirrorResourceFor(pack, request.repo)
    if (resource === undefined || request.tag !== undefined || request.asset !== undefined) return undefined
    const cdk = await this.#options.credential(this.#state.settings.cdkRef)
    if (cdk === undefined || cdk === '') return undefined
    const options = this.#mirrorOptions(cdk, ctl.signal)
    let latest: MirrorLatest
    try {
      ctl.phase('resolving', { message: `从 Mirror酱 查询 ${resource.rid} 的最新版本` })
      latest = await mirrorLatest(resource, options)
      // Asked again from the version installed: Mirror酱 then hands out only what changed.
      if (previous !== undefined && compareVersions(versionOfTag(latest.version), previous.version) > 0) {
        const from = latest.version.startsWith('v') ? `v${previous.version}` : previous.version
        const incremental = await mirrorLatest(resource, { ...options, currentVersion: from }).catch(() => undefined)
        if (incremental?.url !== undefined && incremental.version === latest.version) latest = incremental
      }
    } catch (error) {
      if (ctl.signal.aborted) throw error
      this.#options.log.warn(`${scriptId}: Mirror酱: ${errorText(error)}`)
      ctl.phase('resolving', { message: `${errorText(error)}；改从 GitHub 下载` })
      return undefined
    }
    const version = versionOfTag(latest.version)
    const versionDir = join(this.toolsDir, scriptId, dirName(version))
    const name = `Mirror酱 ${latest.updateType === 'incremental' ? '增量包' : '完整包'} ${latest.version}`
    if (this.#state.scripts.find(s => s.id === scriptId)?.versions.some(v => v.version === version) === true) return { version, versionDir, asset: { name, size: latest.size ?? 0 } }
    if (latest.url === undefined) {
      ctl.phase('resolving', { message: 'Mirror酱 没有给出下载地址；改从 GitHub 下载' })
      return undefined
    }

    const incremental = latest.updateType === 'incremental' && previous !== undefined
    const file = mirrorFileName(latest.url, resource.rid, latest.version)
    const archive = join(this.toolsDir, scriptId, '.downloads', file)
    ctl.phase('downloading', { message: `${name}（Mirror酱）`, received: 0, ...(latest.size === undefined ? {} : { total: latest.size }) })
    await download({
      url: latest.url,
      dest: archive,
      ...(latest.size === undefined ? {} : { expectedSize: latest.size }),
      ...(latest.sha256 === undefined ? {} : { digest: `sha256:${latest.sha256}` }),
      signal: ctl.signal,
      onProgress: (received, total) => ctl.phase('downloading', { message: `${name}（Mirror酱）`, received, ...(total === undefined ? {} : { total }) }),
      ...(this.#options.fetch === undefined ? {} : { fetch: this.#options.fetch }),
    })
    ctl.phase('extracting', { message: incremental ? `在 ${previous.version} 的基础上更新到 ${version}` : `解压到 ${versionDir}` })
    await rm(versionDir, { recursive: true, force: true })
    const root = pack?.manifest.install.root
    if (!incremental) {
      await extract(archive, versionDir, { signal: ctl.signal, ...(root === undefined ? {} : { root }) })
    } else {
      // A copy of the installed version, the changed files over it, then what changes.json says went away.
      const patch = `${versionDir}.patch`
      await rm(patch, { recursive: true, force: true })
      await extract(archive, patch, { signal: ctl.signal })
      try {
        await cp(previous.dir, versionDir, { recursive: true })
        // The files may sit under the package's top folder, which the full install lifted off (or under the pack's root).
        const entries = (await readdir(patch, { withFileTypes: true })).filter(e => e.name !== 'changes.json')
        const top = entries.length === 1 && entries[0]!.isDirectory() && !(await stat(join(previous.dir, entries[0]!.name)).then(() => true, () => false)) ? entries[0]!.name : undefined
        const prefix = root !== undefined && await stat(join(patch, root)).then(() => true, () => false) ? root : top
        const from = prefix === undefined ? patch : join(patch, prefix)
        await cp(from, versionDir, { recursive: true, force: true })
        if (from !== patch && await stat(join(patch, 'changes.json')).then(() => true, () => false)) await copyFile(join(patch, 'changes.json'), join(versionDir, 'changes.json'))
        const removed = await applyMirrorChanges(versionDir, prefix?.replace(/\\/g, '/'))
        if (removed > 0) this.#options.log.info(`${scriptId}: the incremental package removed ${removed} file(s)`)
      } catch (error) {
        await rm(versionDir, { recursive: true, force: true })
        throw error
      } finally {
        await rm(patch, { recursive: true, force: true })
      }
    }
    await rm(archive, { force: true })
    return { version, versionDir, asset: { name, size: latest.size ?? 0 } }
  }

  /** The newest version where the update will come from: Mirror酱 with a CDK (for a script published there), else GitHub. */
  async #latestVersion(repo: string, pack: LoadedPack | undefined, signal?: AbortSignal): Promise<string> {
    const resource = mirrorResourceFor(pack, repo)
    const cdk = resource === undefined ? undefined : await this.#options.credential(this.#state.settings.cdkRef)
    if (resource !== undefined && cdk !== undefined && cdk !== '') {
      try {
        return versionOfTag((await mirrorLatest(resource, this.#mirrorOptions(undefined, signal))).version)
      } catch (error) {
        if (signal?.aborted === true) throw error
        this.#options.log.warn(`${repo}: Mirror酱: ${errorText(error)}; asking GitHub`)
      }
    }
    const latest = await this.#github().latest(repo, { includePrereleases: this.#prereleases(pack), ...(signal === undefined ? {} : { signal }) })
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
    if (script.source.kind !== 'github') throw new Error('本地导入的脚本只有一个目录，无法回滚')
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

  async import(request: { path: string; id?: string | undefined; name?: string | undefined; packId?: string | undefined }): Promise<ScriptInfo> {
    const path = resolve(request.path)
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
    const base = request.id ?? pack?.manifest.id ?? slug(basename(path))
    const id = this.#freeId(base)
    const script: StoredScript = {
      id,
      name: request.name ?? pack?.manifest.name ?? basename(path),
      source: { kind: 'local', path },
      current: 'local',
      versions: [{ version: 'local', dir: path, installedAt: this.#now() }],
      probe,
      addedAt: this.#now(),
      ...(pack === undefined ? {} : { packId: pack.manifest.id }),
      ...(pack?.manifest.family ?? probe.family) === undefined ? {} : { family: (pack?.manifest.family ?? probe.family)! },
    }
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
    if (deleteFiles && script.source.kind === 'github') {
      const dir = join(this.toolsDir, id)
      if (this.#ownsDir(dir)) await rm(dir, { recursive: true, force: true })
    }
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
    return {
      id: script.id,
      name: script.name,
      source: script.source,
      versions: [...script.versions].sort((a, b) => b.installedAt - a.installedAt).map(v => ({ ...v, current: v.version === script.current })),
      addedAt: script.addedAt,
      ...(script.packId === undefined ? {} : { packId: script.packId }),
      ...(script.source.kind === 'github' && mirrorResourceFor(script.packId === undefined ? undefined : this.#packs.get(script.packId), script.source.repo) !== undefined ? { mirrorchyan: mirrorResourceFor(script.packId === undefined ? undefined : this.#packs.get(script.packId), script.source.repo)!.rid } : {}),
      ...(script.family === undefined ? {} : { family: script.family }),
      ...(current === undefined ? {} : { current: current.version, dir: current.dir }),
      ...(script.env === undefined ? {} : { env: script.env }),
      ...(script.probe === undefined ? {} : { probe: script.probe }),
      ...(script.update === undefined ? {} : { update: script.update }),
      ...(job === undefined ? {} : { jobId: job.id }),
    }
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

/** What an install job fetched and unpacked. */
interface Fetched {
  readonly version: string
  readonly versionDir: string
  readonly asset: { name: string; size: number }
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
