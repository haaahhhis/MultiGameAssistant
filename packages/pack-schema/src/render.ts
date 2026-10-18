/**
 * Turn a pack task plus the caller's parameters into exactly what will run:
 * program, arguments and config edits, with `{placeholders}` filled in.
 * Pure, so the UI can preview a run and tests need no processes.
 */
import type { ConfigPatch, ScriptManifest, Task, TaskParam } from './manifest.ts'

/** Bad task input, phrased for the user and the agent. */
export class TaskInputError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'TaskInputError'
  }
}

export interface RenderedTask {
  readonly task: Task
  /** Relative to the script directory. */
  readonly exe: string
  readonly args: readonly string[]
  readonly cwd: string | undefined
  readonly patches: readonly ConfigPatch[]
  /** Parameters after defaults and coercion. */
  readonly params: Readonly<Record<string, string | number | boolean>>
}

type Value = string | number | boolean

/**
 * @param vars - run facts available as placeholders, e.g. `adb` (emulator address), `dir` (script directory).
 * @throws TaskInputError for an unknown task, unknown or invalid parameters, or a missing required one.
 */
export function renderTask(manifest: ScriptManifest, taskId: string, input: Readonly<Record<string, unknown>> = {}, vars: Readonly<Record<string, string>> = {}): RenderedTask {
  const task = manifest.tasks.find(t => t.id === taskId)
  if (task === undefined) {
    const known = manifest.tasks.map(t => `${t.id}（${t.title}）`).join('、')
    throw new TaskInputError(`${manifest.name} 没有任务 ${taskId}${known === '' ? '' : `；可用任务：${known}`}`)
  }
  if (manifest.launch === undefined) throw new TaskInputError(`${manifest.name} 的脚本包没有声明启动方式`)

  for (const name of Object.keys(input)) {
    if (task.params[name] === undefined) throw new TaskInputError(`任务 ${task.id} 没有参数 ${name}${Object.keys(task.params).length === 0 ? '' : `；可用参数：${Object.keys(task.params).join('、')}`}`)
  }
  const params: Record<string, Value> = {}
  for (const [name, spec] of Object.entries(task.params)) {
    const raw = input[name] ?? spec.default
    if (raw === undefined || raw === null || raw === '') throw new TaskInputError(`任务 ${task.id} 需要参数 ${name}${spec.description === undefined ? '' : `（${spec.description}）`}`)
    params[name] = coerce(name, spec, raw)
  }

  const scope: Record<string, Value> = { ...vars, ...params }
  const fill = (template: string) => substitute(template, scope)
  return {
    task,
    exe: manifest.launch.exe,
    args: [...manifest.launch.args, ...task.args].map(a => String(fill(a))),
    cwd: manifest.launch.cwd,
    patches: task.patches.map(patch => ({ ...patch, set: patch.set.map(op => ({ path: op.path, value: fillDeep(op.value, fill) })) })),
    params,
  }
}

function coerce(name: string, spec: TaskParam, raw: unknown): Value {
  let value: Value
  switch (spec.type) {
    case 'boolean':
      if (typeof raw === 'boolean') value = raw
      else if (raw === 'true' || raw === 'false') value = raw === 'true'
      else throw new TaskInputError(`参数 ${name} 应为 true 或 false`)
      break
    case 'integer':
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' && raw.trim() !== '' ? Number(raw) : Number.NaN
      if (!Number.isFinite(n) || (spec.type === 'integer' && !Number.isInteger(n))) throw new TaskInputError(`参数 ${name} 应为${spec.type === 'integer' ? '整数' : '数字'}`)
      value = n
      break
    }
    default:
      if (typeof raw !== 'string' && typeof raw !== 'number') throw new TaskInputError(`参数 ${name} 应为文本`)
      value = String(raw)
  }
  if (spec.enum !== undefined && !spec.enum.some(e => e === value || String(e) === String(value))) {
    throw new TaskInputError(`参数 ${name} 只能是：${spec.enum.join('、')}`)
  }
  return value
}

/**
 * A template that is exactly one placeholder keeps the value's type
 * (`"{medicine}"` → 3); otherwise placeholders are interpolated as text.
 * @throws TaskInputError for an unknown placeholder.
 */
function substitute(template: string, scope: Readonly<Record<string, Value>>): Value {
  const whole = /^\{([A-Za-z][A-Za-z0-9_.]*)\}$/.exec(template)
  if (whole !== null) return lookup(whole[1]!, scope, template)
  return template.replace(/\{([A-Za-z][A-Za-z0-9_.]*)\}/g, (_, name: string) => String(lookup(name, scope, template)))
}

function lookup(name: string, scope: Readonly<Record<string, Value>>, template: string): Value {
  const value = scope[name]
  if (value === undefined) throw new TaskInputError(`"${template}" 里的 {${name}} 没有对应的参数或运行信息`)
  return value
}

function fillDeep(value: unknown, fill: (template: string) => Value): unknown {
  if (typeof value === 'string') return fill(value)
  if (Array.isArray(value)) return value.map(v => fillDeep(v, fill))
  if (value !== null && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, fillDeep(v, fill)]))
  return value
}
