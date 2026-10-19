/**
 * Running Script Pack tasks.
 *
 * A run: lock its resources → (for `adb` tasks) make sure an emulator is up →
 * render the task → apply config patches (originals backed up) → start the
 * program → follow stdout and log files through the pack's log rules → on
 * exit (or after `done` for GUIs that stay open) restore the configs, release
 * the locks, and judge the outcome from the script's own output: a `done`
 * rule, else the exit code. The runner never decides success on its own
 * signals (the black-box rule, docs/PLAN.zh.md §3.0).
 */
import { spawn, execFile, type ChildProcess } from 'node:child_process'
import { appendFile, mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { renderTask, type LogRule, type ScriptManifest } from '@adg/pack-schema'
import type { LaunchSettings, RunInfo, RunLogLine, ScriptInfo, TaskInfo } from '@adg/protocol'
import { listWithNew, readChoices } from './choices.ts'
import { describeSelfLaunch, ensureGame, LaunchStore, type GameStart } from './game.ts'
import { BusyError, ResourceLocks } from './locks.ts'
import { backupDirFor, inside } from './patch.ts'
import { ConfigProfiles } from './profiles.ts'
import { lineSplitter, LogTail } from './tail.ts'
import { gameKeywords, locateGame, type GameCandidate } from './locate.ts'

/** What the runner needs from the script library. */
export interface LibraryView {
  get(id: string): ScriptInfo
  packOf(id: string): { manifest: ScriptManifest } | undefined
}

/** What the runner needs from the emulator plugin. */
export interface EmulatorBridge {
  /**
   * Make sure an emulator instance is running and reachable over ADB.
   * @returns its ADB address (`host:port`) and a label for people.
   */
  prepare(options: { prefer?: string | undefined; signal: AbortSignal; onStatus: (text: string) => void }): Promise<{ address: string; label: string; managed?: boolean }>
  /** `adb shell` on the device (screen input). */
  shell?(address: string, args: readonly string[], timeoutMs?: number): Promise<string>
  /** Whether an Android app is running on the device. */
  appRunning?(address: string, pkg: string): Promise<boolean>
  /** Start an Android app's launcher activity. */
  launchApp?(address: string, pkg: string): Promise<void>
  /**
   * Reconnect an ADB address (starting the emulator again if it went down).
   * @returns what was done, for people. @throws Error when it is still unreachable.
   */
  reconnect?(address: string, signal: AbortSignal): Promise<string>
  /** The ADB address a task would get, without starting anything (so its lock can be taken first). */
  expectedAddress?(): Promise<string | undefined>
  /** A PNG screenshot of the device at this address. */
  screencap?(address: string, signal: AbortSignal): Promise<Buffer>
}

/** Live feed of runs for other plugins (the monitor). Listener errors are ignored. */
export interface RunListener {
  state?(run: RunInfo): void
  /** Every line as it arrives (unbatched), with the matching rule's level and tag. */
  line?(run: RunInfo, line: RunLogLine): void
}

export interface RunnerOptions {
  readonly library: LibraryView
  /** Where run records, logs and config backups go (`<dataDir>/runs/<id>/`). */
  readonly dataDir: string
  readonly emulators?: () => EmulatorBridge | undefined
  readonly onState: (run: RunInfo) => void
  readonly onLog: (runId: string, lines: RunLogLine[]) => void
  /** Map the pack's program to what is actually spawned (tests run fake scripts through Node). */
  readonly command?: (exe: string, args: readonly string[]) => { file: string; args: readonly string[] }
  readonly now?: () => number
  readonly log: { info(message: string): void; warn(message: string): void }
  /** Log file poll interval. @default 500 */
  readonly pollMs?: number
  /** Game start hooks, injected in tests. */
  readonly game?: Pick<GameStart, 'processRunning' | 'startProgram' | 'sleep'>
}

interface ActiveRun {
  info: RunInfo
  mode: 'task' | 'settings'
  child?: ChildProcess
  stopRequested: boolean
  /** Why it was stopped, when not by a plain user request. */
  stopReason?: string
  doneSeen: boolean
  errorLine?: string
  controller: AbortController
  lines: RunLogLine[]
  pendingLines: RunLogLine[]
  flushTimer?: ReturnType<typeof setTimeout> | undefined
  release: Array<() => void | Promise<void>>
  finished: Promise<RunInfo>
  resolveFinished: (run: RunInfo) => void
}

const KEEP_RUNS = 50
const KEEP_LINES = 2000

export class Runner {
  readonly locks = new ResourceLocks()
  /** The local config copies runs use (docs/PLAN.zh.md §5.7). */
  readonly profiles: ConfigProfiles
  /** Who starts the game before runs, per script. */
  readonly launch: LaunchStore
  readonly #options: RunnerOptions
  readonly #runs = new Map<string, ActiveRun>()
  readonly #listeners = new Set<RunListener>()
  /** Runs being restarted → the restart (resolves undefined when it did not start). */
  readonly #successors = new Map<string, Promise<RunInfo | undefined>>()
  readonly #now: () => number

  constructor(options: RunnerOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.profiles = new ConfigProfiles(options.dataDir)
    this.launch = new LaunchStore(options.dataDir)
  }

  /** Tasks of a library script, from its pack. */
  /** Tasks of a library script, from its pack; parameter choices are read from the local config copy. */
  async tasks(scriptId: string): Promise<{ tasks: TaskInfo[]; runnable: boolean; problem?: string }> {
    const script = this.#options.library.get(scriptId)
    const pack = this.#options.library.packOf(scriptId)
    if (pack === undefined) return { tasks: [], runnable: false, problem: `${script.name} 没有脚本包，还不知道怎么运行它；可以让 agent 分析这个脚本生成脚本包` }
    const tasks: TaskInfo[] = []
    for (const t of pack.manifest.tasks) {
      const params: TaskInfo['params'] = {}
      for (const [name, spec] of Object.entries(t.params)) {
        const { choices: from, ...rest } = spec
        params[name] = from === undefined ? rest : { ...rest, choices: readChoices(from, await this.#localText(scriptId, pack.manifest, from.file)), ...(from.create === undefined ? {} : { canCreate: true }) }
      }
      tasks.push({
        id: t.id,
        title: t.title,
        utterances: t.utterances,
        params,
        input: t.resources.input,
        ...(t.description === undefined ? {} : { description: t.description }),
        ...(t.resources.account === undefined ? {} : { account: t.resources.account }),
        ...(t.expectedDuration === undefined ? {} : { expectedDuration: t.expectedDuration }),
      })
    }
    if (tasks.length === 0) return { tasks, runnable: false, problem: `${pack.manifest.name} 的脚本包还没有任务` }
    if (script.dir === undefined) return { tasks, runnable: false, problem: `${script.name} 还没有安装` }
    return { tasks, runnable: true }
  }

  /**
   * Add a choice to a parameter's list in the local config copy (a copy of an existing item).
   * @returns the new value. @throws Error when the parameter has no creatable choices or the name is taken.
   */
  async createChoice(scriptId: string, taskId: string, param: string, name: string): Promise<string> {
    const script = this.#options.library.get(scriptId)
    const pack = this.#options.library.packOf(scriptId)
    const spec = pack?.manifest.tasks.find(t => t.id === taskId)?.params[param]?.choices
    if (pack === undefined || script.dir === undefined || spec?.create === undefined) throw new Error(`任务 ${taskId} 的参数 ${param} 不能新建`)
    const text = await this.#localText(scriptId, pack.manifest, spec.file)
    if (text === undefined) throw new Error(`本地配置里还没有 ${spec.file}：先「打开脚本修改设置」，在脚本里建一个，之后就可以在这里复制`)
    const { list, value } = listWithNew(spec, text, name.trim())
    const historyDir = join(this.#options.dataDir, 'config-history', scriptId, new Date(this.#now()).toISOString().replace(/[:.]/g, '-'))
    await this.profiles.write(scriptId, script.dir, pack.manifest, spec.file, spec.list, list, historyDir)
    return value
  }

  async #localText(scriptId: string, manifest: ScriptManifest, file: string): Promise<string | undefined> {
    const dir = this.#options.library.get(scriptId).dir
    if (dir === undefined) return undefined
    return this.profiles.read(scriptId, dir, manifest, file).catch(() => undefined)
  }

  /** Who starts the game before this script's runs, and what its pack says. */
  async launchView(scriptId: string): Promise<{ settings: LaunchSettings; game: { name?: string; androidPackage?: string; pcProcess?: string; selfLaunch: string }; uses: { adb: boolean; desktop: boolean } }> {
    const manifest = this.#options.library.packOf(scriptId)?.manifest
    const game = manifest?.game
    return {
      settings: await this.launch.get(scriptId),
      game: {
        ...(game?.name === undefined ? {} : { name: game.name }),
        ...(game?.android?.package === undefined ? {} : { androidPackage: game.android.package }),
        ...(game?.pc?.process === undefined ? {} : { pcProcess: game.pc.process }),
        selfLaunch: describeSelfLaunch(game),
      },
      uses: {
        adb: manifest?.tasks.some(t => t.resources.input === 'adb') ?? false,
        desktop: manifest?.tasks.some(t => t.resources.input === 'desktop' || t.resources.input === 'window') ?? false,
      },
    }
  }

  /** Look for this script's PC game. */
  async locateGame(scriptId: string, signal?: AbortSignal): Promise<{ exe?: string; candidates: GameCandidate[] }> {
    const game = this.#options.library.packOf(scriptId)?.manifest.game
    const settings = await this.launch.get(scriptId)
    const exe = settings.pcProcess ?? game?.pc?.process
    if (exe === undefined) return { candidates: [] }
    const name = exe.toLowerCase().endsWith('.exe') ? exe : `${exe}.exe`
    return { exe: name, candidates: await locateGame({ exe: name, keywords: gameKeywords(game ?? {}), ...(signal === undefined ? {} : { signal }) }) }
  }

  /** Follow every run's state and lines. @returns a disposer. */
  watch(listener: RunListener): () => void {
    this.#listeners.add(listener)
    return () => { this.#listeners.delete(listener) }
  }

  list(scriptId?: string): RunInfo[] {
    return [...this.#runs.values()].map(r => r.info).filter(r => scriptId === undefined || r.scriptId === scriptId).sort((a, b) => b.startedAt - a.startedAt)
  }

  get(runId: string): RunInfo {
    return this.#run(runId).info
  }

  logs(runId: string, limit = 200): RunLogLine[] {
    return this.#run(runId).lines.slice(-limit)
  }

  /** Settles when the run ends. */
  finished(runId: string): Promise<RunInfo> {
    return this.#run(runId).finished
  }

  /**
   * The resources a task would take, and the first one held by another run.
   * @throws Error for an unknown script or task.
   */
  async check(scriptId: string, taskId: string): Promise<{ keys: string[]; busy?: BusyError }> {
    const script = this.#options.library.get(scriptId)
    const pack = this.#options.library.packOf(scriptId)
    const task = pack?.manifest.tasks.find(t => t.id === taskId)
    if (pack === undefined || task === undefined) throw new Error(`${script.name} 没有任务 ${taskId}`)
    const keys = await this.#keys(scriptId, task.resources)
    const conflict = this.locks.conflict(keys)
    return conflict === undefined ? { keys } : { keys, busy: new BusyError(conflict.key, conflict.holder) }
  }

  async #keys(scriptId: string, resources: { input: string; account?: string | undefined }): Promise<string[]> {
    // Most telling first: a busy desktop says more than "the same script" (both are true).
    const keys: string[] = []
    if (resources.input === 'desktop') keys.push('desktop')
    if (resources.input === 'adb') {
      const expected = await this.#options.emulators?.()?.expectedAddress?.().catch(() => undefined)
      if (expected !== undefined) keys.push(`adb:${expected}`)
    }
    if (resources.account !== undefined) keys.push(`account:${resources.account}`)
    keys.push(`script:${scriptId}`)
    return keys
  }

  /**
   * Start a task. Resolves once the program has started (or the run failed to start).
   * @throws Error before anything ran: unknown script or task, bad parameters; BusyError for busy resources.
   */
  async start(scriptId: string, taskId: string, params: Readonly<Record<string, unknown>> = {}, options: { manifest?: ScriptManifest; mode?: 'task' | 'settings'; retryOf?: string } = {}): Promise<RunInfo> {
    const script = this.#options.library.get(scriptId)
    const pack = this.#options.library.packOf(scriptId)
    if (pack === undefined) throw new Error(`${script.name} 没有脚本包，还不知道怎么运行它`)
    if (script.dir === undefined) throw new Error(`${script.name} 还没有安装`)
    const manifest = options.manifest ?? pack.manifest
    const mode = options.mode ?? 'task'
    const task = manifest.tasks.find(t => t.id === taskId)
    // Validate parameters early (with a placeholder address) so mistakes fail before any lock or emulator start.
    renderTask(manifest, taskId, params, { dir: script.dir, adb: '0.0.0.0:0' })

    const runId = `run-${new Date(this.#now()).toISOString().replace(/[-:T]/g, '').slice(0, 14)}-${Math.random().toString(36).slice(2, 6)}`
    let resolveFinished!: (run: RunInfo) => void
    const finished = new Promise<RunInfo>(resolve => { resolveFinished = resolve })
    const run: ActiveRun = {
      info: {
        id: runId, scriptId, scriptName: script.name, taskId, taskTitle: task?.title ?? taskId, params: {}, state: 'starting',
        startedAt: this.#now(), command: [], resources: [], tags: [], warnings: [], kind: mode,
        ...(options.retryOf === undefined ? {} : { retryOf: options.retryOf }),
      },
      mode,
      stopRequested: false, doneSeen: false, controller: new AbortController(), lines: [], pendingLines: [], release: [], finished, resolveFinished,
    }

    const resources = task?.resources ?? { input: 'none' as const }
    // The emulator's lock is taken now when its address is known, so a busy emulator refuses before anything starts.
    const keys = await this.#keys(scriptId, resources)
    run.release.push(this.locks.acquire(keys, { runId, label: `${script.name} · ${run.info.taskTitle}` }))
    run.info.resources = keys.filter(k => !k.startsWith('script:'))
    this.#runs.set(runId, run)
    this.#prune()
    const runDir = join(this.#options.dataDir, 'runs', runId)
    await mkdir(runDir, { recursive: true })
    this.#publish(run)

    try {
      const vars: Record<string, string> = { dir: script.dir }
      let emulatorManaged = false
      if (resources.input === 'adb') {
        const bridge = this.#options.emulators?.()
        if (bridge === undefined) throw new Error('这个任务需要安卓模拟器，但模拟器插件没有加载')
        this.#line(run, 'adg', '准备模拟器…')
        const emulator = await bridge.prepare({ prefer: resources.emulator, signal: run.controller.signal, onStatus: text => this.#line(run, 'adg', text) })
        const key = `adb:${emulator.address}`
        if (!keys.includes(key)) {
          run.release.push(this.locks.acquire([key], { runId, label: `${script.name} · ${run.info.taskTitle}` }))
          run.info.resources.push(key)
        }
        vars['adb'] = emulator.address
        emulatorManaged = emulator.managed === true
        this.#line(run, 'adg', `使用模拟器 ${emulator.label}（${emulator.address}）`)
      }
      run.controller.signal.throwIfAborted()
      const rendered = renderTask(manifest, taskId, params, vars)
      run.info.params = { ...rendered.params }

      // The local config copy (plus this task's temporary edits) goes in for the run; the original comes back after.
      // Patches for a managed emulator only (e.g. turn the script's own emulator start off) apply when we started it.
      const patches = rendered.patches.filter(p => p.when !== 'emulator-managed' || emulatorManaged)
      const injection = await this.profiles.inject(scriptId, script.dir, manifest, patches, backupDirFor(this.#options.dataDir, runId))
      run.release.push(() => injection.restore())
      if (mode === 'settings') {
        // Runs before the restore above (releases run in reverse).
        run.release.push(async () => {
          if (run.stopRequested) {
            this.#line(run, 'adg', '设置会话被停止：这次的修改没有保存到本地配置')
            return
          }
          const saved = await injection.saveBack()
          this.#line(run, 'adg', saved.length > 0 ? `已保存到本地配置：${saved.join('、')}` : '脚本没有写出配置文件，本地配置未变')
        })
      }
      for (const file of injection.skipped) run.info.warnings.push(`没有找到配置文件 ${file}，这项临时修改跳过`)
      if (injection.drift.length > 0) run.info.warnings.push(`原项目的配置（${injection.drift.join('、')}）在导入本地配置后改过；本次按本地配置运行。需要的话在脚本页「导入原项目设置」`)
      if (injection.files.length > 0) this.#line(run, 'adg', `已放入本地配置：${injection.files.join('、')}（结束后还原原项目配置）`)

      // The game, for scripts that do not start it themselves (judged on the config now in place).
      if (mode === 'task') {
        await ensureGame({
          manifest, settings: await this.launch.get(scriptId), input: resources.input, scriptDir: script.dir, address: vars['adb'],
          android: this.#options.emulators?.(), signal: run.controller.signal, line: text => this.#line(run, 'adg', text),
          ...this.#options.game,
        })
        run.controller.signal.throwIfAborted()
      }

      const exe = inside(script.dir, rendered.exe)
      const cwd = rendered.cwd === undefined ? script.dir : inside(script.dir, rendered.cwd)
      const command = (this.#options.command ?? ((file, args) => ({ file, args })))(exe, rendered.args)
      run.info.command = [exe, ...rendered.args]
      const child = spawn(command.file, [...command.args], { cwd, windowsHide: false, stdio: ['ignore', 'pipe', 'pipe'] })
      run.child = child
      await new Promise<void>((resolve, reject) => {
        child.once('spawn', () => resolve())
        child.once('error', error => reject(new Error(`无法启动 ${rendered.exe}：${error.message}`)))
      })
      this.#follow(run, manifest, script.dir)
      run.info.state = 'running'
      this.#line(run, 'adg', `已启动：${run.info.command.map(quote).join(' ')}`)
      this.#publish(run)
      void writeFile(join(runDir, 'run.json'), JSON.stringify(run.info, null, 2)).catch(() => {})
      return run.info
    } catch (error) {
      await this.#finish(run, run.stopRequested ? 'cancelled' : 'failed', run.stopRequested ? run.stopReason ?? '已停止' : error instanceof Error ? error.message : String(error))
      return run.info
    }
  }

  /**
   * Open the script's own settings window with the local config in place.
   * When the user closes it, what the script saved is kept in the local copy
   * and the original project config is restored. Without a declared
   * `launch.settings` the main program is opened as it is (most GUIs are
   * their own settings window).
   * @throws Error when the pack declares no program at all.
   */
  async settings(scriptId: string): Promise<RunInfo> {
    const script = this.#options.library.get(scriptId)
    const pack = this.#options.library.packOf(scriptId)
    if (pack === undefined) throw new Error(`${script.name} 没有脚本包，不知道该打开哪个程序`)
    const launch = pack.manifest.launch
    if (launch === undefined) throw new Error(`${pack.manifest.name} 的脚本包没有声明启动程序；可以让 agent 用 script_config_set 修改本地配置`)
    const settings = launch.settings ?? { exe: launch.exe, args: launch.args }
    const manifest: ScriptManifest = {
      ...pack.manifest,
      launch: { exe: settings.exe, args: [], ...(launch.settings === undefined && launch.cwd !== undefined ? { cwd: launch.cwd } : {}), stopAfterDone: false, stopGraceSeconds: 0 },
      tasks: [{
        id: '__settings', title: '修改设置', utterances: [], params: {}, args: settings.args, patches: [],
        resources: { input: 'none' }, success: 'exit-code',
      }],
      logs: { sources: [{ stdout: true, encoding: 'auto' }], rules: [] },
    }
    return this.start(scriptId, '__settings', {}, { manifest, mode: 'settings' })
  }

  /**
   * Ask a run to stop: the program's process tree is ended and configs restored.
   * @param reason shown as the outcome instead of "stopped as requested".
   */
  async stop(runId: string, reason?: string): Promise<void> {
    const run = this.#run(runId)
    if (run.info.endedAt !== undefined) return
    run.stopRequested = true
    if (reason !== undefined) run.stopReason ??= reason
    run.controller.abort(new Error('stopped by user'))
    if (run.child !== undefined && run.child.exitCode === null) {
      run.info.state = 'stopping'
      this.#publish(run)
      await killTree(run.child)
    }
  }

  /**
   * Stop a run (if it is still going) and start its task again with the same
   * parameters; the new run records `retryOf`.
   * @throws Error when the task cannot start again (e.g. its resources are busy).
   */
  async restart(runId: string, reason: string): Promise<RunInfo> {
    const run = this.#run(runId)
    if (run.mode !== 'task') throw new Error('设置会话不能重启')
    const next = (async () => {
      if (run.info.endedAt === undefined) {
        this.#line(run, 'adg', `重启：${reason}`)
        await this.stop(runId, `已重启：${reason}`)
      }
      await run.finished
      return this.start(run.info.scriptId, run.info.taskId, run.info.params, { retryOf: runId })
    })()
    this.#successors.set(runId, next.catch(() => undefined))
    return next
  }

  /**
   * The run that directly replaced this one when it was restarted (L0
   * recovery, a retry); undefined when it was not. Who waits on a run (the
   * orchestrator) asks after it ends, and keeps following.
   */
  async successor(runId: string): Promise<RunInfo | undefined> {
    return this.#successors.get(runId)
  }

  /** The script's process id while it runs (to pause it). */
  processId(runId: string): number | undefined {
    const run = this.#run(runId)
    return run.info.endedAt === undefined ? run.child?.pid : undefined
  }

  /** Add a line to a run's log from outside (the intervention says what it is doing). */
  note(runId: string, text: string): void {
    this.#line(this.#run(runId), 'adg', text)
  }

  /** Add a warning to a run (shown with it), e.g. from the monitor. */
  warn(runId: string, text: string): void {
    const run = this.#run(runId)
    if (run.info.warnings.includes(text)) return
    run.info.warnings.push(text)
    this.#publish(run)
  }

  /** Stop everything (plugin unload). */
  async dispose(): Promise<void> {
    await Promise.all([...this.#runs.values()].filter(r => r.info.endedAt === undefined).map(r => this.stop(r.info.id).catch(() => {})))
  }

  #follow(run: ActiveRun, manifest: ScriptManifest, dir: string): void {
    const rules = manifest.logs.rules.map(rule => ({ rule, pattern: new RegExp(rule.match) }))
    const onLine = (source: string) => (text: string) => this.#scriptLine(run, source, text, rules, manifest)
    const tails: LogTail[] = []
    let stdoutEncoding = 'auto'
    for (const source of manifest.logs.sources) {
      if ('stdout' in source) stdoutEncoding = source.encoding
      else {
        const tail = new LogTail(inside(dir, source.path), source.encoding, onLine(source.path), this.#options.pollMs ?? 500)
        void tail.start()
        tails.push(tail)
      }
    }
    const child = run.child!
    const stdout = lineSplitter(stdoutEncoding, onLine('stdout'))
    const stderr = lineSplitter(stdoutEncoding, onLine('stderr'))
    child.stdout?.on('data', (chunk: Buffer) => stdout.push(chunk))
    child.stderr?.on('data', (chunk: Buffer) => stderr.push(chunk))
    child.once('exit', code => {
      void (async () => {
        stdout.end()
        stderr.end()
        for (const tail of tails) await tail.stop().catch(() => {})
        if (code !== null) run.info.exitCode = code
        const outcome = run.mode === 'settings'
          ? (run.stopRequested ? { state: 'cancelled' as const, reason: '设置会话已停止' } : { state: 'succeeded' as const, reason: '设置窗口已关闭' })
          : judge(run, manifest.tasks.find(t => t.id === run.info.taskId)?.success ?? 'exit-code', code)
        await this.#finish(run, outcome.state, outcome.reason)
      })()
    })
  }

  #scriptLine(run: ActiveRun, source: string, text: string, rules: readonly { rule: LogRule; pattern: RegExp }[], manifest: ScriptManifest): void {
    const hit = rules.find(r => r.pattern.test(text))
    const tag = hit === undefined ? undefined : hit.rule.tag ?? hit.rule.level
    this.#push(run, { at: this.#now(), source, text, ...(hit === undefined ? {} : { level: hit.rule.level, tag }) })
    if (hit === undefined || tag === undefined) return
    if (!run.info.tags.includes(tag)) {
      run.info.tags.push(tag)
      this.#publish(run)
    }
    if (hit.rule.level === 'error' && run.errorLine === undefined) run.errorLine = text
    if (hit.rule.level === 'done' && !run.doneSeen) {
      run.doneSeen = true
      if (manifest.launch?.stopAfterDone === true) {
        const grace = (manifest.launch.stopGraceSeconds ?? 10) * 1000
        this.#line(run, 'adg', `脚本已报告完成，${grace / 1000} 秒后关闭它`)
        setTimeout(() => { if (run.child?.exitCode === null) void killTree(run.child) }, grace).unref?.()
      }
    }
  }

  async #finish(run: ActiveRun, state: 'succeeded' | 'failed' | 'cancelled', reason: string): Promise<void> {
    if (run.info.endedAt !== undefined) return
    for (const release of run.release.splice(0).reverse()) {
      try {
        await release()
      } catch (error) {
        run.info.warnings.push(`还原配置失败：${error instanceof Error ? error.message : String(error)}；备份在 ${backupDirFor(this.#options.dataDir, run.info.id)}`)
      }
    }
    run.info.state = state
    run.info.outcome = reason
    run.info.endedAt = this.#now()
    this.#line(run, 'adg', `${state === 'succeeded' ? '完成' : state === 'cancelled' ? '已停止' : '失败'}：${reason}`)
    this.#flush(run)
    this.#publish(run)
    const runDir = join(this.#options.dataDir, 'runs', run.info.id)
    await mkdir(runDir, { recursive: true }).catch(() => {})
    await writeFile(join(runDir, 'run.json'), JSON.stringify(run.info, null, 2)).catch(() => {})
    this.#options.log.info(`run ${run.info.id} ${state}: ${reason}`)
    run.resolveFinished(run.info)
  }

  #line(run: ActiveRun, source: string, text: string): void {
    this.#push(run, { at: this.#now(), source, text })
  }

  #push(run: ActiveRun, line: RunLogLine): void {
    run.lines.push(line)
    if (run.lines.length > KEEP_LINES) run.lines.splice(0, run.lines.length - KEEP_LINES)
    run.pendingLines.push(line)
    for (const listener of this.#listeners) {
      try { listener.line?.(run.info, line) } catch { /* a listener's problem, not the run's */ }
    }
    void appendFile(join(this.#options.dataDir, 'runs', run.info.id, 'log.txt'), `${new Date(line.at).toISOString()} [${line.source}] ${line.text}\n`).catch(() => {})
    if (run.flushTimer === undefined) run.flushTimer = setTimeout(() => this.#flush(run), 100)
  }

  #flush(run: ActiveRun): void {
    clearTimeout(run.flushTimer)
    run.flushTimer = undefined
    if (run.pendingLines.length === 0) return
    this.#options.onLog(run.info.id, run.pendingLines.splice(0))
  }

  #publish(run: ActiveRun): void {
    const snapshot = { ...run.info, resources: [...run.info.resources], tags: [...run.info.tags], warnings: [...run.info.warnings] }
    this.#options.onState(snapshot)
    for (const listener of this.#listeners) {
      try { listener.state?.(snapshot) } catch { /* a listener's problem, not the run's */ }
    }
  }

  #run(runId: string): ActiveRun {
    const run = this.#runs.get(runId)
    if (run === undefined) throw new Error(`没有运行记录 ${runId}`)
    return run
  }

  #prune(): void {
    const ended = [...this.#runs.values()].filter(r => r.info.endedAt !== undefined).sort((a, b) => b.info.startedAt - a.info.startedAt)
    for (const run of ended.slice(KEEP_RUNS)) this.#runs.delete(run.info.id)
  }
}

/** Decide the outcome from the script's own signals. */
function judge(run: ActiveRun, success: 'exit-code' | 'done-log', code: number | null): { state: 'succeeded' | 'failed' | 'cancelled'; reason: string } {
  if (run.stopRequested) return { state: 'cancelled', reason: run.stopReason ?? '已按要求停止' }
  if (run.doneSeen) return { state: 'succeeded', reason: run.errorLine === undefined ? '脚本报告已完成' : `脚本报告已完成（期间出现过错误：${run.errorLine}）` }
  if (run.errorLine !== undefined) return { state: 'failed', reason: `脚本报告错误：${run.errorLine}` }
  if (success === 'done-log') return { state: 'failed', reason: `脚本已退出（代码 ${code ?? '无'}），但没有看到完成标志` }
  return code === 0 ? { state: 'succeeded', reason: '脚本正常退出' } : { state: 'failed', reason: `脚本退出代码 ${code ?? '无'}` }
}

export function parseDuration(value: string | undefined): number | undefined {
  const match = /^(\d+)(s|m|h)$/.exec(value ?? '')
  if (match === null) return undefined
  return Number(match[1]) * ({ s: 1000, m: 60_000, h: 3_600_000 } as const)[match[2] as 's' | 'm' | 'h']
}

/** End a process and everything it started. */
export function killTree(child: ChildProcess): Promise<void> {
  return new Promise(resolve => {
    if (child.pid === undefined || child.exitCode !== null) return resolve()
    child.once('exit', () => resolve())
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {})
    else child.kill('SIGTERM')
    setTimeout(resolve, 10_000).unref?.()
  })
}

function quote(value: string): string {
  return /\s/.test(value) ? `"${value}"` : value
}
