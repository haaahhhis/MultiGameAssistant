/**
 * @adg/emulator — Android emulators for ADB-driven scripts (`ctx.adgEmulators`).
 *
 * Emulators are a platform concern, not each script's (docs/PLAN.zh.md §5.8):
 * the runner asks this service for a ready instance before an `adb` task, so
 * two scripts never race to start their own. MuMu is managed through
 * MuMuManager.exe; any other emulator works through a manual ADB address.
 *
 * Contributes the `emulator` requirement check to the script library, the
 * `emulator_*` agent tools and the `emulators@1` capability.
 */
import { execFile } from 'node:child_process'
import { access, mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { Service, type Context } from '@deepseek-ai/cordis'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition } from '@deepseek-ai/dsh-tools'
import type {} from '@adg/gateway'
import type {} from '@adg/runner'
import type {} from '@adg/script-registry'
import { download, runElevated, type EnvChecker } from '@adg/installer'
import { EMULATORS_CAPABILITY, EmulatorSettings, type EmulatorProvider, type RequestParams } from '@adg/protocol'
import { z } from 'zod'
import { findMuMu, type Found } from './detect.ts'
import { MuMuManager, type Exec } from './mumu.ts'

export { MuMuManager, defaultMumuPort, parsePolluted, type Exec } from './mumu.ts'
export { findMuMu, type Found } from './detect.ts'

// ctx.adgEmulators is declared by @adg/runner as its EmulatorBridge; this service implements it.

const DEFAULTS: EmulatorSettings = { instance: 0, autoStart: true, bootTimeoutSeconds: 180 }

/** Hosts an emulator installer may be downloaded from (NetEase's site and CDNs). */
const INSTALLER_HOSTS = /(^|\.)(163\.com|netease\.com|126\.net|127\.net|nosdn\.127\.net)$/i

const ConfigSchema = z.object({
  /** Settings file and nothing else: `<dataDir>/emulators.json`. */
  dataDir: z.string().min(1),
  /** Where installers are downloaded: `<sharedDir>/downloads`. */
  sharedDir: z.string().min(1),
})
export type Config = z.input<typeof ConfigSchema>

export const systemExec: Exec = (file, args, options = {}) => new Promise(resolve => {
  execFile(file, [...args], { windowsHide: true, timeout: options.timeoutMs ?? 30_000, encoding: 'utf8', maxBuffer: 8 * 1024 * 1024 }, (error, stdout, stderr) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve(undefined)
    resolve({ code: typeof error?.code === 'number' ? error.code : error === null ? 0 : 1, stdout, stderr })
  })
})

/** Like {@link Exec} for programs that print binary data (`adb exec-out screencap`). */
export type ExecBuffer = (file: string, args: readonly string[], options?: { timeoutMs?: number }) => Promise<{ code: number; stdout: Buffer; stderr: string } | undefined>

export const systemExecBuffer: ExecBuffer = (file, args, options = {}) => new Promise(resolve => {
  execFile(file, [...args], { windowsHide: true, timeout: options.timeoutMs ?? 30_000, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024 }, (error, stdout, stderr) => {
    if ((error as NodeJS.ErrnoException | null)?.code === 'ENOENT') return resolve(undefined)
    resolve({ code: typeof error?.code === 'number' ? error.code : error === null ? 0 : 1, stdout, stderr: stderr.toString('utf8') })
  })
})

const PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47])

export class AdgEmulators extends Service {
  private readonly file: string
  private readonly sharedDir: string
  private readonly exec: Exec
  private readonly execBuffer: ExecBuffer
  private settings: EmulatorSettings = DEFAULTS
  private found: Found[] | undefined
  readonly ready: Promise<void>

  constructor(ctx: Context, config: Config, exec: Exec = systemExec, execBuffer: ExecBuffer = systemExecBuffer) {
    super(ctx, 'adgEmulators')
    const spec = ConfigSchema.parse(config)
    this.file = join(spec.dataDir, 'emulators.json')
    this.sharedDir = spec.sharedDir
    this.exec = exec
    this.execBuffer = execBuffer
    this.ready = this.load()
    const log = ctx.logger('adg-emulators')

    ctx.inject(['adgScripts'], scoped => {
      const checker: EnvChecker = async () => {
        await this.ready
        const selection = await this.selection()
        return selection.problem === undefined
          ? { item: { kind: 'emulator', label: '安卓模拟器', status: 'ok', found: selection.label } }
          : {
              item: { kind: 'emulator', label: '安卓模拟器', status: 'missing', detail: selection.problem },
              plan: { kind: 'manual', description: '对 agent 说「安装 MuMu 模拟器」，或在「设置 → 模拟器」填写已有模拟器的 ADB 地址' },
            }
      }
      scoped.effect(() => scoped.adgScripts.library.registerEnvChecker('emulator', checker), 'adg-emulators env check')
    })

    ctx.inject(['tools'], scoped => {
      for (const tool of this.tools()) scoped.tools.register(tool)
    })

    ctx.inject(['adgGateway'], scoped => {
      const changed = () => scoped.adgGateway.broadcast('emulators/changed', {})
      scoped.adgGateway.register({
        id: EMULATORS_CAPABILITY,
        version: 1,
        methods: {
          'emulators/status': async params => this.status((params as RequestParams<'emulators/status'>).refresh === true),
          'emulators/start': async params => {
            const r = await this.prepare({ index: (params as RequestParams<'emulators/start'>).index, signal: AbortSignal.timeout(15 * 60_000), onStatus: () => {} })
            changed()
            return r
          },
          'emulators/stop': async params => {
            await this.stop((params as RequestParams<'emulators/stop'>).index)
            changed()
            return {}
          },
          'emulators/settings/set': async params => {
            const result = await this.configure(params as RequestParams<'emulators/settings/set'>)
            changed()
            return result
          },
        },
      })
    })
    log.debug('emulator service ready')
  }

  // ── the runner's bridge ───────────────────────────────────────────────

  /**
   * Make sure the configured emulator is reachable and return its ADB address.
   * @throws Error saying what to do when there is no emulator to use.
   */
  async prepare(options: { prefer?: string | undefined; index?: number | undefined; signal: AbortSignal; onStatus: (text: string) => void }): Promise<{ address: string; label: string }> {
    await this.ready
    if (this.settings.manualAddress !== undefined && options.index === undefined) {
      return { address: this.settings.manualAddress, label: '手动配置的 ADB 地址' }
    }
    const mumu = await this.manager()
    if (mumu === undefined) throw new Error('没有找到 MuMu 模拟器。可以让 agent 安装（emulator_install），或在「设置 → 模拟器」填写已有模拟器的 ADB 地址')
    const index = options.index ?? this.settings.instance
    const current = await mumu.instance(index)
    if (current?.ready !== true && !this.settings.autoStart && options.index === undefined) {
      throw new Error(`MuMu 实例 ${index} 没有运行，且已关闭「任务需要时自动启动」`)
    }
    const ready = await mumu.ensureReady(index, { timeoutMs: this.settings.bootTimeoutSeconds * 1000, signal: options.signal, onStatus: options.onStatus })
    return { address: await mumu.adbAddress(index), label: `MuMu ${ready.index}（${ready.name}）` }
  }

  /**
   * Reconnect an ADB address for the monitor's L0 recovery: start the MuMu
   * instance again if it went down, then `adb disconnect` / `adb connect` and
   * check the device answers.
   * @throws Error when adb is missing or the device still does not answer.
   */
  async reconnect(address: string, signal: AbortSignal): Promise<string> {
    await this.ready
    const done: string[] = []
    if (this.settings.manualAddress === undefined) {
      const mumu = await this.manager()
      const current = mumu === undefined ? undefined : await mumu.instance(this.settings.instance)
      if (mumu !== undefined && current?.adb === address && current.ready !== true) {
        await mumu.ensureReady(this.settings.instance, { timeoutMs: this.settings.bootTimeoutSeconds * 1000, signal })
        done.push(`MuMu 实例 ${this.settings.instance} 已重新启动`)
      }
    }
    const adb = await this.adb()
    await this.exec(adb, ['disconnect', address], { timeoutMs: 10_000 })
    const connected = await this.exec(adb, ['connect', address], { timeoutMs: 20_000 })
    if (connected === undefined) throw new Error(`找不到 adb（${adb}）。可以在「设置 → 模拟器」填写 adb.exe 的位置`)
    if (!/connected to|already connected/i.test(connected.stdout)) throw new Error(`adb connect ${address} 没有成功：${(connected.stdout + connected.stderr).trim() || `退出代码 ${connected.code}`}`)
    const echo = await this.exec(adb, ['-s', address, 'shell', 'echo', 'adg-ok'], { timeoutMs: 15_000 })
    if (echo?.stdout.trim() !== 'adg-ok') throw new Error(`已连接 ${address}，但设备没有响应：${(echo?.stderr ?? '').trim() || '无输出'}`)
    done.push(`已重新连接 ${address}`)
    return done.join('；')
  }

  /** A PNG screenshot over ADB. @throws Error when adb fails or returns no image. */
  async screencap(address: string, _signal: AbortSignal): Promise<Buffer> {
    await this.ready
    const adb = await this.adb()
    const result = await this.execBuffer(adb, ['-s', address, 'exec-out', 'screencap', '-p'], { timeoutMs: 20_000 })
    if (result === undefined) throw new Error(`找不到 adb（${adb}）`)
    if (result.code !== 0 || !result.stdout.subarray(0, 4).equals(PNG)) throw new Error(`截图失败：${result.stderr.trim() || `退出代码 ${result.code}`}`)
    return result.stdout
  }

  async stop(index?: number): Promise<void> {
    const mumu = await this.manager()
    if (mumu === undefined) throw new Error('没有找到 MuMu 模拟器')
    await mumu.shutdown(index ?? this.settings.instance)
  }

  async status(refresh = false) {
    await this.ready
    if (refresh) this.found = undefined
    const providers: EmulatorProvider[] = []
    for (const found of await this.detected()) {
      const mumu = new MuMuManager(found.manager, this.exec)
      try {
        providers.push({ kind: 'mumu', name: found.name, manager: found.manager, instances: await mumu.instances(), ...(found.version === undefined ? {} : { version: found.version }) })
      } catch (error) {
        providers.push({ kind: 'mumu', name: found.name, manager: found.manager, instances: [], error: error instanceof Error ? error.message : String(error), ...(found.version === undefined ? {} : { version: found.version }) })
      }
    }
    return { providers, settings: this.settings, selection: await this.selection() }
  }

  /** What a task would use right now. */
  async selection(): Promise<{ label: string; address?: string; problem?: string }> {
    if (this.settings.manualAddress !== undefined) return { label: `手动配置的 ADB 地址 ${this.settings.manualAddress}`, address: this.settings.manualAddress }
    const mumu = await this.manager()
    if (mumu === undefined) return { label: '无', problem: '没有找到 MuMu 模拟器，也没有配置手动 ADB 地址' }
    return { label: `MuMu 实例 ${this.settings.instance}（${mumu.path}）` }
  }

  async configure(patch: { mumuManager?: string | null | undefined; instance?: number | undefined; manualAddress?: string | null | undefined; adbPath?: string | null | undefined; autoStart?: boolean | undefined; bootTimeoutSeconds?: number | undefined }): Promise<EmulatorSettings> {
    await this.ready
    const next: Record<string, unknown> = { ...this.settings }
    for (const [key, value] of Object.entries(patch)) {
      if (value === undefined) continue
      if (value === null || value === '') delete next[key]
      else next[key] = value
    }
    this.settings = EmulatorSettings.parse(next)
    this.found = undefined
    await this.save()
    return this.settings
  }

  /** Download an official installer from NetEase and run it; the user may see the setup wizard and a UAC prompt. */
  async install(url: string, signal: AbortSignal, onProgress: (text: string) => void): Promise<{ found: Found[]; exitCode: number }> {
    const parsed = new URL(url)
    if (parsed.protocol !== 'https:' || !INSTALLER_HOSTS.test(parsed.hostname)) {
      throw new Error(`只从网易官方地址下载模拟器安装程序（*.163.com / *.netease.com / *.126.net），这个地址不符合：${parsed.hostname}`)
    }
    const name = basename(decodeURIComponent(parsed.pathname)) || 'mumu-installer.exe'
    if (!/\.exe$/i.test(name)) throw new Error(`下载地址不是安装程序（.exe）：${name}`)
    const dest = join(this.sharedDir, 'downloads', name)
    onProgress(`下载 ${name}`)
    await download({ url, dest, signal, onProgress: (received, total) => onProgress(`下载中 ${Math.round(received / 1048576)} / ${total === undefined ? '?' : Math.round(total / 1048576)} MB`) })
    onProgress('运行安装程序（可能出现安装向导和管理员授权）')
    const exitCode = await runElevated(dest, [])
    this.found = undefined
    return { found: await this.detected(), exitCode }
  }

  private async manager(): Promise<MuMuManager | undefined> {
    const path = this.settings.mumuManager ?? (await this.detected())[0]?.manager
    return path === undefined ? undefined : new MuMuManager(path, this.exec)
  }

  /** adb.exe: the configured one, else MuMu's own next to MuMuManager.exe, else `adb` on PATH. */
  private async adb(): Promise<string> {
    if (this.settings.adbPath !== undefined) return this.settings.adbPath
    const manager = this.settings.mumuManager ?? (await this.detected())[0]?.manager
    if (manager !== undefined) {
      const sibling = join(dirname(manager), 'adb.exe')
      if (await access(sibling).then(() => true, () => false)) return sibling
    }
    return 'adb'
  }

  private async detected(): Promise<Found[]> {
    this.found ??= await findMuMu(this.exec)
    return this.found
  }

  private async load(): Promise<void> {
    try {
      this.settings = EmulatorSettings.parse({ ...DEFAULTS, ...JSON.parse(await readFile(this.file, 'utf8')) })
    } catch {
      this.settings = DEFAULTS
    }
  }

  private async save(): Promise<void> {
    await mkdir(dirname(this.file), { recursive: true })
    await writeFile(`${this.file}.tmp`, `${JSON.stringify(this.settings, null, 2)}\n`)
    await rename(`${this.file}.tmp`, this.file)
  }

  private tools(): ToolDefinition[] {
    const json = (value: unknown) => JSON.parse(JSON.stringify(value ?? null)) as never
    const tool = (spec: { name: string; description: string; properties: Record<string, JsonSchemaNode>; required?: string[]; timeoutMs?: number; title: string; execute(args: Record<string, unknown>, signal: AbortSignal): Promise<unknown> }): ToolDefinition => ({
      name: spec.name,
      description: spec.description,
      parameters: { type: 'object', properties: spec.properties, ...(spec.required === undefined ? {} : { required: spec.required }), additionalProperties: false },
      output: { schema: {}, render: (_a, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] },
      timeoutMs: spec.timeoutMs ?? 120_000,
      isConcurrencySafe: () => false,
      execute: async (args, exec) => json(await spec.execute((args ?? {}) as Record<string, unknown>, exec.signal)),
      presentCall: () => ({ card: 'generic', title: spec.title, kind: 'other' }),
    })
    const index = { type: 'integer', description: '实例编号；省略为设置里选定的实例（默认 0）。' } as const
    const optionalIndex = (v: unknown) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 ? v : undefined)
    return [
      tool({
        name: 'emulator_status',
        description: '查看本机的安卓模拟器：找到的 MuMu 安装、各实例是否运行、ADB 地址，以及任务当前会用哪一个。',
        properties: { refresh: { type: 'boolean', description: '重新检测安装情况。' } },
        title: '查看模拟器',
        execute: async a => this.status(a['refresh'] === true),
      }),
      tool({
        name: 'emulator_start',
        description: '启动模拟器实例并等到安卓系统启动完成，返回 ADB 地址。运行需要模拟器的任务时 script_run 会自动做这一步。',
        properties: { index },
        timeoutMs: 15 * 60_000,
        title: '启动模拟器',
        execute: async (a, signal) => this.prepare({ index: optionalIndex(a['index']), signal, onStatus: () => {} }),
      }),
      tool({
        name: 'emulator_stop',
        description: '关闭模拟器实例。',
        properties: { index },
        title: '关闭模拟器',
        execute: async a => { await this.stop(optionalIndex(a['index'])); return { ok: true } },
      }),
      tool({
        name: 'emulator_configure',
        description: '设置任务使用哪个模拟器：MuMuManager.exe 路径、实例编号、或其他模拟器的手动 ADB 地址（如 127.0.0.1:5555；传空字符串清除）、任务需要时是否自动启动。',
        properties: {
          mumu_manager: { type: 'string', description: 'MuMuManager.exe 的完整路径；空字符串恢复自动检测。' },
          instance: { type: 'integer', description: '任务使用的 MuMu 实例编号。' },
          manual_address: { type: 'string', description: '其他模拟器或设备的 ADB 地址，例如 127.0.0.1:5555；空字符串清除。' },
          auto_start: { type: 'boolean', description: '任务需要时自动启动模拟器。' },
        },
        title: '设置模拟器',
        execute: async a => this.configure({
          mumuManager: typeof a['mumu_manager'] === 'string' ? a['mumu_manager'] : undefined,
          instance: optionalIndex(a['instance']),
          manualAddress: typeof a['manual_address'] === 'string' ? a['manual_address'] : undefined,
          autoStart: typeof a['auto_start'] === 'boolean' ? a['auto_start'] : undefined,
        }),
      }),
      tool({
        name: 'emulator_install',
        description: '下载并运行 MuMu 模拟器的官方安装程序（只接受网易官方地址）。先用 web_fetch 打开 https://mumu.163.com/ 找到 Windows 版下载链接再调用。安装向导可能需要点击下一步、取消捆绑软件；系统管理员授权需要用户确认。完成后会重新检测。',
        properties: { url: { type: 'string', description: '官方安装程序的 https 下载地址（.exe）。' } },
        required: ['url'],
        timeoutMs: 60 * 60_000,
        title: '安装 MuMu 模拟器',
        execute: async (a, signal) => {
          const url = typeof a['url'] === 'string' ? a['url'] : ''
          const result = await this.install(url, signal, () => {})
          return result.found.length > 0
            ? { ok: true, installed: result.found, exit_code: result.exitCode, next: '如有需要，用 emulator_configure 选择实例；分辨率请设为 16:9（如 1280×720）' }
            : { ok: false, exit_code: result.exitCode, message: result.exitCode === 1223 ? '用户取消了管理员授权' : '安装程序已退出，但没有检测到 MuMu；安装可能没有完成' }
        },
      }),
    ]
  }
}

export default AdgEmulators
