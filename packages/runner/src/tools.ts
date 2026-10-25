/**
 * Agent tools for running scripts. Running a library script's declared task is
 * what the user installed it for, so it needs no approval; what a task may
 * touch is fixed by its pack (config patches restored afterwards).
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { existsSync, statSync } from 'node:fs'
import { basename, isAbsolute } from 'node:path'
import { ScriptId } from '@adg/protocol'
import { z } from 'zod'
import { configStatus, importConfig, readConfig, writeConfig } from './config.ts'
import type { LibraryView, Runner } from './runs.ts'

export const TOOL_NAMES = {
  tasks: 'script_tasks',
  run: 'script_run',
  stop: 'script_stop',
  runs: 'script_runs',
  configGet: 'script_config_get',
  configSet: 'script_config_set',
  configStatus: 'script_config_status',
  configImport: 'script_config_import',
  settings: 'script_settings',
  choiceCreate: 'script_choice_create',
  runLog: 'script_run_log',
  gameLocate: 'game_locate',
  gamePathSet: 'game_path_set',
} as const

type Json = null | boolean | number | string | Json[] | { [key: string]: Json }
const json = (value: unknown): Json => JSON.parse(JSON.stringify(value ?? null)) as Json

/**
 * Task parameters arrive as name / value strings (a typed array, not a free
 * object: loose schemas make some models stall on whitespace); convert each
 * to the type the task declares.
 */
export function taskParams(pairs: readonly { name: string; value: string }[] | null | undefined, spec: Readonly<Record<string, { type: string }>>): Record<string, unknown> {
  const out: Record<string, unknown> = {}
  for (const { name, value } of pairs ?? []) {
    const type = spec[name]?.type
    out[name] = type === 'integer' || type === 'number' ? Number(value) : type === 'boolean' ? /^(true|1|是|yes)$/i.test(value.trim()) : value
  }
  return out
}

/** `value_json` is JSON text; text that is not JSON is taken as a string. */
export function parseValue(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return text
  }
}

/** Shared schema for name / value parameter lists. */
export const PARAMS_SCHEMA: JsonSchemaNode = {
  type: 'array',
  items: {
    type: 'object',
    properties: { name: { type: 'string', description: '参数名。' }, value: { type: 'string', description: '参数值（写成文字，数字和是否也一样，例如 "3"、"true"）。' } },
    required: ['name', 'value'],
    additionalProperties: false,
  },
} as JsonSchemaNode

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
  return parsed.data
}

function tool(spec: {
  name: string
  description: string
  properties: Record<string, JsonSchemaNode>
  required?: string[]
  timeoutMs?: number
  readOnly?: boolean
  kind: 'read' | 'execute' | 'other'
  title(args: Record<string, unknown>): string
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties, ...(spec.required === undefined ? {} : { required: spec.required }), additionalProperties: false },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] },
    timeoutMs: spec.timeoutMs ?? 60_000,
    isConcurrencySafe: () => spec.readOnly === true,
    execute: async (args, exec) => json(await spec.execute(args, exec)),
    presentCall: args => ({ card: 'generic', title: spec.title((args ?? {}) as Record<string, unknown>), kind: spec.kind }),
  }
}

const brief = (runner: Runner, runId: string, lines = 15) => {
  const info = runner.get(runId)
  return {
    run_id: info.id, script: info.scriptId, task: info.taskId, state: info.state, outcome: info.outcome, params: info.params,
    resources: info.resources, tags: info.tags, warnings: info.warnings, exit_code: info.exitCode,
    last_lines: runner.logs(runId, lines).map(l => `[${l.source}] ${l.text}`),
  }
}

export function runnerTools(runner: Runner, config: { library: LibraryView; dataDir: string }): ToolDefinition[] {
  const id = { type: 'string', description: '脚本库里的脚本 id（script_list 可查）。' } as const
  return [
    tool({
      name: TOOL_NAMES.configGet,
      description: '读取脚本的一个配置文件——读的是 MultiGameAssistant 保存的本地配置副本（运行时用的就是它），不是原项目里的文件。只能是脚本包声明的配置文件。改设置前先读，弄清楚键的位置。',
      properties: { id, file: { type: 'string', description: '配置文件的相对路径，例如 config/gui.json。' } },
      required: ['id', 'file'],
      readOnly: true,
      kind: 'read',
      title: a => `读取配置：${String(a['id'] ?? '')} / ${String(a['file'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId, file: z.string().min(1).max(300) }), args)
        return readConfig(config.library, runner.profiles, a.id, a.file)
      },
    }),
    tool({
      name: TOOL_NAMES.configSet,
      description: '修改脚本配置里的一个值。改的是本地配置副本，原项目的配置不变（用户自己打开脚本时仍是它原来的设置）；下次通过 MultiGameAssistant 运行时生效。只能是脚本包声明的配置文件（JSON / YAML）。path 是键的数组，键里带点号时整体作为一个元素，例如 ["Configurations", "Default", "Start.RunDirectly"]；数组下标也写成文字，例如 "0"。value_json 是新值的 JSON 写法：字符串要带引号 "\"CE-6\""，数字 3，是否 true，对象 {"a":1}。修改前会自动备份。不要直接写脚本目录里的文件。',
      properties: {
        id,
        file: { type: 'string', description: '配置文件的相对路径。' },
        path: { type: 'array', items: { type: 'string' }, description: '键路径。' },
        value_json: { type: 'string', description: '新的值，JSON 写法。' },
      },
      required: ['id', 'file', 'path', 'value_json'],
      kind: 'other',
      title: a => `修改配置：${String(a['id'] ?? '')} / ${String(a['file'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId, file: z.string().min(1).max(300), path: z.array(z.string().min(1)).min(1).max(20), value_json: z.string().max(100_000) }), args)
        const busy = runner.list(a.id).find(r => r.endedAt === undefined)
        if (busy?.kind === 'settings') throw new Error(`${a.id} 的设置界面正开着；用户关掉它时会把脚本里的设置存回本地配置并覆盖这次修改，请等它关闭后再改`)
        const result = await writeConfig(config.library, runner.profiles, config.dataDir, a.id, a.file, a.path, parseValue(a.value_json))
        return { ok: true, ...result, takesEffect: busy === undefined ? '下次运行' : '当前运行结束后的下一次运行' }
      },
    }),
    tool({
      name: TOOL_NAMES.configStatus,
      description: '查看脚本的本地配置副本：有哪些文件、什么时候从原项目导入的、原项目的配置在那之后有没有被用户改过（drift）。',
      properties: { id },
      required: ['id'],
      readOnly: true,
      kind: 'read',
      title: a => `查看本地配置：${String(a['id'] ?? '')}`,
      execute: async args => configStatus(config.library, runner.profiles, parse(z.object({ id: ScriptId }), args).id),
    }),
    tool({
      name: TOOL_NAMES.configImport,
      description: '用原项目当前的配置覆盖本地配置副本（例如用户在脚本自己的界面里改了设置，想让 MultiGameAssistant 也用上）。会丢掉本地副本里的修改，先征得用户同意再调用。',
      properties: { id },
      required: ['id'],
      kind: 'other',
      title: a => `导入原项目设置：${String(a['id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId }), args)
        return { ok: true, imported: await importConfig(config.library, runner.profiles, a.id) }
      },
    }),
    tool({
      name: TOOL_NAMES.settings,
      description: '打开脚本自己的设置界面让用户修改设置：先放入本地配置，用户关掉窗口后，把脚本保存的设置存回本地配置，并还原原项目的配置。用户说「我要改 MAA 的设置」「打开三月七设置一下」时使用。立即返回 run_id，用户关窗后才算结束。',
      properties: { id },
      required: ['id'],
      kind: 'execute',
      title: a => `打开设置界面：${String(a['id'] ?? '')}`,
      execute: async args => brief(runner, (await runner.settings(parse(z.object({ id: ScriptId }), args).id)).id),
    }),
    tool({
      name: TOOL_NAMES.tasks,
      description: '列出一个脚本能运行的任务：任务 id、名称、用户可能的说法、参数（类型、默认值、可选值；choices 是从脚本配置里读出的可选项，例如 MaaEnd 的实例名，canCreate 表示可以用 script_choice_create 新建）、占用的资源（desktop 抢占鼠标键盘、adb 使用模拟器）。运行前先调用它把用户的话对应到任务和参数。',
      properties: { id },
      required: ['id'],
      readOnly: true,
      kind: 'read',
      title: a => `查看任务：${String(a['id'] ?? '')}`,
      execute: async args => runner.tasks(parse(z.object({ id: ScriptId }), args).id),
    }),
    tool({
      name: TOOL_NAMES.choiceCreate,
      description: '为任务参数新建一个选项，例如给 MaaEnd 新建一个 MXU 实例：复制一个现有的实例（结构和脚本自己写的一样），起一个新名字，保存在本地配置里。只在 script_tasks 里该参数带 canCreate 时可用。建好后用 script_config_set 改它的任务、或让用户「打开脚本修改设置」调整。',
      properties: {
        id,
        task: { type: 'string', description: '任务 id。' },
        param: { type: 'string', description: '参数名，例如 instance。' },
        name: { type: 'string', description: '新选项的名字，例如「MultiGameAssistant 模拟器」。' },
      },
      required: ['id', 'task', 'param', 'name'],
      kind: 'other',
      title: a => `新建选项：${String(a['id'] ?? '')} / ${String(a['name'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId, task: z.string().min(1), param: z.string().min(1), name: z.string().trim().min(1).max(40) }), args)
        return { ok: true, value: await runner.createChoice(a.id, a.task, a.param, a.name) }
      },
    }),
    tool({
      name: TOOL_NAMES.run,
      description: '运行脚本的一个任务。会按脚本包修改它的配置（结束后还原）、需要时先启动模拟器、启动脚本并跟踪日志。默认启动后立即返回 run_id；wait 为 true 时等到结束再返回结果。同一个脚本、同一台模拟器或桌面鼠标键盘被占用时会拒绝运行。',
      properties: {
        id,
        task: { type: 'string', description: '任务 id（script_tasks 可查）。' },
        params: { ...PARAMS_SCHEMA, description: '任务参数，例如 [{"name":"stage","value":"1-7"}]；省略的参数用默认值。' },
        wait: { type: 'boolean', description: '等运行结束再返回（最长 3 小时）。' },
      },
      required: ['id', 'task'],
      timeoutMs: 3 * 60 * 60_000,
      kind: 'execute',
      title: a => `运行：${String(a['id'] ?? '')} / ${String(a['task'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: ScriptId, task: z.string().min(1).max(64), params: z.array(z.object({ name: z.string().min(1), value: z.string() })).max(40).nullish(), wait: z.boolean().nullish() }), args)
        const spec = config.library.packOf(a.id)?.manifest.tasks.find(t => t.id === a.task)?.params ?? {}
        const started = await runner.start(a.id, a.task, taskParams(a.params, spec))
        if (a.wait !== true || started.endedAt !== undefined) return brief(runner, started.id)
        const onAbort = () => void runner.stop(started.id)
        exec.signal.addEventListener('abort', onAbort, { once: true })
        try {
          await runner.finished(started.id)
        } finally {
          exec.signal.removeEventListener('abort', onAbort)
        }
        return brief(runner, started.id, 30)
      },
    }),
    tool({
      name: TOOL_NAMES.stop,
      description: '停止一个正在运行的任务（结束脚本进程并还原配置）。',
      properties: { run_id: { type: 'string', description: 'script_run 返回的 run_id。' } },
      required: ['run_id'],
      kind: 'other',
      title: a => `停止运行：${String(a['run_id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ run_id: z.string().min(1) }), args)
        await runner.stop(a.run_id)
        return brief(runner, a.run_id)
      },
    }),
    tool({
      name: TOOL_NAMES.runs,
      description: '查看最近的运行记录和它们最后几行日志；带 run_id 时返回这一次运行的详情和更多日志。',
      properties: { id: { ...id, description: '只看这个脚本的运行。' }, run_id: { type: 'string', description: '查看这一次运行。' } },
      readOnly: true,
      kind: 'read',
      title: () => '查看运行记录',
      execute: async args => {
        const a = parse(z.object({ id: ScriptId.nullish(), run_id: z.string().nullish() }), args)
        if (a.run_id !== undefined && a.run_id !== null) return brief(runner, a.run_id, 80)
        return { runs: runner.list(a.id ?? undefined).slice(0, 10).map(r => brief(runner, r.id, 5)) }
      },
    }),
    tool({
      name: TOOL_NAMES.runLog,
      description: '读一次运行保存下来的完整日志（包括程序重启前的运行），用来排查问题：可以按文字或 /正则/ 搜索、只看错误或警告、从某一行开始往后翻。script_runs 只给最后几行，这里能看全部。',
      properties: {
        run_id: { type: 'string', description: '运行 id（script_runs 或异常记录里有）。' },
        search: { type: 'string', description: '要找的文字，或 /正则/（不区分大小写）。' },
        levels: { type: 'array', items: { type: 'string', enum: ['error', 'warning', 'done', 'progress', 'info'] }, description: '只看这些级别（日志规则标出来的）。' },
        from_line: { type: 'integer', description: '从第几行开始往后看（1 开始）；不填就看最后的。' },
        limit: { type: 'integer', description: '最多返回几行，默认 120，最多 500。' },
      },
      required: ['run_id'],
      readOnly: true,
      kind: 'read',
      title: a => `查看运行日志：${String(a['run_id'] ?? '')}${a['search'] === undefined ? '' : ` · ${String(a['search'])}`}`,
      execute: async args => {
        const a = parse(z.object({
          run_id: z.string().min(1), search: z.string().nullish(), levels: z.array(z.enum(['error', 'warning', 'done', 'progress', 'info'])).nullish(),
          from_line: z.number().int().min(1).nullish(), limit: z.number().int().min(1).max(500).nullish(),
        }), args)
        const log = await runner.readLog(a.run_id, { search: a.search ?? undefined, levels: a.levels ?? undefined, fromLine: a.from_line ?? undefined, limit: a.limit ?? 120 })
        let info
        try { info = runner.get(a.run_id) } catch { info = undefined }
        return {
          run: info === undefined ? a.run_id : { id: info.id, script: info.scriptId, task: info.taskId, state: info.state, outcome: info.outcome, started: new Date(info.startedAt).toLocaleString('zh-CN', { hour12: false }) },
          total_lines: log.total, matched: log.matched, file: log.file,
          lines: log.lines.map(l => `${l.n} ${new Date(l.at).toLocaleTimeString('zh-CN', { hour12: false })} [${l.source}]${l.level === undefined ? '' : `[${l.level}]`} ${l.text}`),
        }
      },
    }),
    tool({
      name: TOOL_NAMES.gameLocate,
      description: '找某个脚本要玩的 PC 游戏装在哪里：查正在运行的游戏、已安装程序（注册表）、开始菜单和桌面快捷方式、常见游戏目录。找不到时可以用文件搜索工具在用户说的位置或其他磁盘上找同名程序，再用 game_path_set 保存。',
      properties: { id },
      required: ['id'],
      readOnly: true,
      timeoutMs: 90_000,
      kind: 'read',
      title: a => `查找游戏位置：${String(a['id'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: ScriptId }), args)
        const found = await runner.locateGame(a.id, exec.signal)
        if (found.exe === undefined) return { error: '这个脚本包没有写游戏的进程名，先问用户游戏程序叫什么（或用 game_path_set 直接保存用户给的位置）' }
        return { looking_for: found.exe, candidates: found.candidates, current: (await runner.launch.get(a.id)).pcExe ?? null }
      },
    }),
    tool({
      name: TOOL_NAMES.gamePathSet,
      description: '保存某个脚本的 PC 游戏程序位置（运行前由本应用启动游戏时用）。只在找到并确认了程序后调用；路径必须是存在的 .exe。',
      properties: { id, path: { type: 'string', description: '游戏程序的完整路径，例如 D:\\Games\\Endfield\\Endfield.exe。' } },
      required: ['id', 'path'],
      kind: 'other',
      title: a => `保存游戏位置：${String(a['path'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId, path: z.string().trim().min(1) }), args)
        const path = a.path.replace(/^"|"$/g, '')
        if (!isAbsolute(path) || !/\.exe$/i.test(path)) throw new Error('要填 .exe 程序的完整路径')
        if (!existsSync(path) || !statSync(path).isFile()) throw new Error(`找不到 ${path}`)
        const settings = await runner.launch.set(a.id, { pcExe: path })
        return { saved: settings.pcExe, process: settings.pcProcess ?? basename(path), note: '已保存，下次运行生效' }
      },
    }),
  ]
}
