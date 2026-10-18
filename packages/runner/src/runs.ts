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
import type { RunInfo, RunLogLine, ScriptInfo, TaskInfo } from '@adg/protocol'
import { ResourceLocks } from './locks.ts'
import { backupDirFor, inside } from './patch.ts'
import { ConfigProfiles } from './profiles.ts'
import { lineSplitter, LogTail } from './tail.ts'

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
  prepare(options: { prefer?: string | undefined; signal: AbortSignal; onStatus: (text: string) => void }): Promise<{ address: string; label: string }>
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
}

interface ActiveRun {
  info: RunInfo
  mode: 'task' | 'settings'
  child?: ChildProcess
  stopRequested: boolean
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
  readonly #options: RunnerOptions
  readonly #runs = new Map<string, ActiveRun>()
  readonly #now: () => number

  constructor(options: RunnerOptions) {
    this.#options = options
    this.#now = options.now ?? Date.now
    this.profiles = new ConfigProfiles(options.dataDir)
  }

  /** Tasks of a library script, from its pack. */
  tasks(scriptId: string): { tasks: TaskInfo[]; runnable: boolean; problem?: string } {
    const script = this.#options.library.get(scriptId)
    const pack = this.#options.library.packOf(scriptId)
    if (pack === undefined) return { tasks: [], runnable: false, problem: `${script.name} 没有脚本包，还不知道怎么运行它；可以让 agent 分析这个脚本生成脚本包` }
    const tasks = pack.manifest.tasks.map(t => ({
      id: t.id,
      title: t.title,
      utterances: t.utterances,
      params: t.params,
      input: t.resources.input,
      ...(t.description === undefined ? {} : { description: t.description }),
      ...(t.resources.account === undefined ? {} : { account: t.resources.account }),
      ...(t.expectedDuration === undefined ? {} : { expectedDuration: t.expectedDuration }),
    }))
    if (tasks.length === 0) return { tasks, runnable: false, problem: `${pack.manifest.name} 的脚本包还没有任务` }
    if (script.dir === undefined) return { tasks, runnable: false, problem: `${script.name} 还没有安装` }
    return { tasks, runnable: true }
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
   * Start a task. Resolves once the program has started (or the run failed to start).
   * @throws Error before anything ran: unknown script or task, bad parameters, busy resources.
   */
  async start(scriptId: string, taskId: string, params: Readonly<Record<string, unknown>> = {}, options: { manifest?: ScriptManifest; mode?: 'task' | 'settings' } = {}): Promise<RunInfo> {
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
      },
      mode,
      stopRequested: false, doneSeen: false, controller: new AbortController(), lines: [], pendingLines: [], release: [], finished, resolveFinished,
    }

    const resources = task?.resources ?? { input: 'none' as const }
    const keys = [`script:${scriptId}`, ...(resources.input === 'desktop' ? ['desktop'] : []), ...(resources.account === undefined ? [] : [`account:${resources.account}`])]
    run.release.push(this.locks.acquire(keys, { runId, label: `${script.name} · ${run.info.taskTitle}` }))
    run.info.resources = keys.filter(k => !k.startsWith('script:'))
    this.#runs.set(runId, run)
    this.#prune()
    const runDir = join(this.#options.dataDir, 'runs', runId)
    await mkdir(runDir, { recursive: true })
    this.#publish(run)

    try {
      const vars: Record<string, string> = { dir: script.dir }
      if (resources.input === 'adb') {
        const bridge = this.#options.emulators?.()
        if (bridge === undefined) throw new Error('这个任务需要安卓模拟器，但模拟器插件没有加载')
        this.#line(run, 'adg', '准备模拟器…')
        const emulator = await bridge.prepare({ prefer: resources.emulator, signal: run.controller.signal, onStatus: text => this.#line(run, 'adg', text) })
        const key = `adb:${emulator.address}`
        run.release.push(this.locks.acquire([key], { runId, label: `${script.name} · ${run.info.taskTitle}` }))
        run.info.resources.push(key)
        vars['adb'] = emulator.address
        this.#line(run, 'adg', `使用模拟器 ${emulator.label}（${emulator.address}）`)
      }
      run.controller.signal.throwIfAborted()
      const rendered = renderTask(manifest, taskId, params, vars)
      run.info.params = { ...rendered.params }

      // The local config copy (plus this task's temporary edits) goes in for the run; the original comes back after.
      const injection = await this.profiles.inject(scriptId, script.dir, manifest, rendered.patches, backupDirFor(this.#options.dataDir, runId))
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
      await this.#finish(run, run.stopRequested ? 'cancelled' : 'failed', run.stopRequested ? '已停止' : error instanceof Error ? error.message : String(error))
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

  /** Ask a run to stop: the program's process tree is ended and configs restored. */
  async stop(runId: string): Promise<void> {
    const run = this.#run(runId)
    if (run.info.endedAt !== undefined) return
    run.stopRequested = true
    run.controller.abort(new Error('stopped by user'))
    if (run.child !== undefined && run.child.exitCode === null) {
      run.info.state = 'stopping'
      this.#publish(run)
      await killTree(run.child)
    }
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
    const expected = parseDuration(manifest.tasks.find(t => t.id === run.info.taskId)?.expectedDuration)
    const overtime = expected === undefined ? undefined : setTimeout(() => {
      run.info.warnings.push(`已运行超过预计时长的 2 倍（${manifest.tasks.find(t => t.id === run.info.taskId)?.expectedDuration}）`)
      this.#publish(run)
    }, expected * 2)
    child.once('exit', code => {
      clearTimeout(overtime)
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
    this.#push(run, { at: this.#now(), source, text, ...(hit === undefined ? {} : { level: hit.rule.level }) })
    if (hit === undefined) return
    const tag = hit.rule.tag ?? hit.rule.level
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
    this.#options.onState({ ...run.info, resources: [...run.info.resources], tags: [...run.info.tags], warnings: [...run.info.warnings] })
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
  if (run.stopRequested) return { state: 'cancelled', reason: '已按要求停止' }
  if (run.doneSeen) return { state: 'succeeded', reason: run.errorLine === undefined ? '脚本报告已完成' : `脚本报告已完成（期间出现过错误：${run.errorLine}）` }
  if (run.errorLine !== undefined) return { state: 'failed', reason: `脚本报告错误：${run.errorLine}` }
  if (success === 'done-log') return { state: 'failed', reason: `脚本已退出（代码 ${code ?? '无'}），但没有看到完成标志` }
  return code === 0 ? { state: 'succeeded', reason: '脚本正常退出' } : { state: 'failed', reason: `脚本退出代码 ${code ?? '无'}` }
}

function parseDuration(value: string | undefined): number | undefined {
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
