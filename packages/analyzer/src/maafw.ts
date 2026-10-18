/**
 * Read a MaaFramework ProjectInterface (`interface.json`): controllers, tasks
 * and their options, following `import` files and resolving `$key` labels
 * through the project's Chinese locale file when it has one.
 */
import { readFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { parseJsonc } from './jsonc.ts'

export interface MaaInterface {
  readonly name?: string
  readonly version?: string
  readonly controllers: readonly { name: string; type: string; label?: string; mouse?: string; keyboard?: string }[]
  readonly tasks: readonly MaaTask[]
  /** Files that could not be read or parsed. */
  readonly problems: readonly string[]
}

export interface MaaTask {
  readonly name: string
  readonly label?: string
  readonly description?: string
  readonly entry?: string
  readonly controllers?: readonly string[]
  readonly options: readonly { name: string; label?: string; type?: string; cases?: readonly string[] }[]
}

type Json = Record<string, unknown>

export async function readInterface(file: string): Promise<MaaInterface> {
  const root = dirname(file)
  const problems: string[] = []
  const load = async (path: string): Promise<Json | undefined> => {
    try {
      return parseJsonc(await readFile(path, 'utf8')) as Json
    } catch (error) {
      problems.push(`${path}: ${error instanceof Error ? error.message : String(error)}`)
      return undefined
    }
  }
  const main = await load(file)
  if (main === undefined) return { controllers: [], tasks: [], problems }

  const rawTasks: Json[] = []
  const options: Record<string, Json> = {}
  const collect = (doc: Json) => {
    for (const task of asArray(doc['task'])) if (isObject(task)) rawTasks.push(task)
    if (isObject(doc['option'])) Object.assign(options, doc['option'])
  }
  collect(main)
  for (const rel of asArray(main['import']).filter((v): v is string => typeof v === 'string')) {
    const doc = await load(join(root, rel))
    if (doc !== undefined) collect(doc)
  }

  const locale = await localeOf(main, root)
  const text = (value: unknown): string | undefined => {
    if (typeof value !== 'string') return undefined
    if (!value.startsWith('$')) return value
    const resolved = locale?.[value.slice(1)]
    return typeof resolved === 'string' ? resolved : undefined
  }
  const controllers = asArray(main['controller']).filter(isObject).map(c => {
    const win32 = isObject(c['win32']) ? c['win32'] : {}
    const label = text(c['label'])
    return {
      name: String(c['name'] ?? ''), type: String(c['type'] ?? ''),
      ...(label === undefined ? {} : { label }),
      ...(typeof win32['mouse'] === 'string' ? { mouse: win32['mouse'] } : {}),
      ...(typeof win32['keyboard'] === 'string' ? { keyboard: win32['keyboard'] } : {}),
    }
  })
  const tasks: MaaTask[] = rawTasks.map(t => {
    const label = text(t['label'])
    const description = text(t['description'])
    return {
      name: String(t['name'] ?? ''),
      ...(label === undefined ? {} : { label }),
      ...(description === undefined ? {} : { description: description.slice(0, 300) }),
      ...(typeof t['entry'] === 'string' ? { entry: t['entry'] } : {}),
      ...(Array.isArray(t['controller']) ? { controllers: t['controller'].map(String) } : {}),
      options: asArray(t['option']).filter((o): o is string => typeof o === 'string').map(name => {
        const spec = options[name] ?? {}
        const optionLabel = text(spec['label'])
        const cases = asArray(spec['cases']).filter(isObject).map(c => String(c['name'] ?? ''))
        return { name, ...(optionLabel === undefined ? {} : { label: optionLabel }), ...(typeof spec['type'] === 'string' ? { type: spec['type'] } : {}), ...(cases.length === 0 ? {} : { cases }) }
      }),
    }
  })
  return {
    ...(typeof main['name'] === 'string' ? { name: main['name'] } : {}),
    ...(typeof main['version'] === 'string' ? { version: main['version'] } : {}),
    controllers, tasks, problems,
  }
}

/** The zh_cn locale map (flattened `a.b.c` keys), when the project declares one. */
async function localeOf(main: Json, root: string): Promise<Record<string, unknown> | undefined> {
  const languages = isObject(main['languages']) ? main['languages'] : {}
  const rel = languages['zh_cn'] ?? languages['zh-CN'] ?? languages['zh_CN']
  if (typeof rel !== 'string') return undefined
  try {
    return flatten(parseJsonc(await readFile(join(root, rel), 'utf8')))
  } catch {
    return undefined
  }
}

function flatten(value: unknown, prefix = '', out: Record<string, unknown> = {}): Record<string, unknown> {
  if (isObject(value)) {
    for (const [k, v] of Object.entries(value)) {
      const key = prefix === '' ? k : `${prefix}.${k}`
      if (isObject(v)) flatten(v, key, out)
      out[key] = v
    }
  }
  return out
}

const asArray = (v: unknown): unknown[] => (Array.isArray(v) ? v : [])
const isObject = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v)
