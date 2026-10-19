/**
 * Parameter values read from the script's own config (the local copy), e.g.
 * MaaEnd's MXU instances: the user picks a name from a list instead of typing
 * it, and can make a new one — copied from an existing item, so its structure
 * stays exactly what the script itself writes.
 */
import { randomUUID } from 'node:crypto'
import type { ParamChoices } from '@adg/pack-schema'
import { parse as parseYaml } from 'yaml'

export interface Choice {
  readonly value: string
  readonly label: string
  readonly detail?: string
}

export function parseConfig(file: string, text: string): unknown {
  const body = text.startsWith('﻿') ? text.slice(1) : text
  return /\.ya?ml$/i.test(file) ? parseYaml(body) : body.trim() === '' ? {} : JSON.parse(body)
}

function listOf(data: unknown, path: readonly string[]): unknown[] | undefined {
  let node = data
  for (const key of path) node = node !== null && typeof node === 'object' ? (node as Record<string, unknown>)[key] : undefined
  return Array.isArray(node) ? node : undefined
}

const field = (item: unknown, name: string): unknown => (item !== null && typeof item === 'object' ? (item as Record<string, unknown>)[name] : undefined)

function matches(spec: ParamChoices, item: unknown): boolean {
  if (spec.where === undefined) return true
  return new RegExp(spec.where.match, 'i').test(String(field(item, spec.where.field) ?? ''))
}

/** The choices in a config file's text (none when the file or list is missing or unreadable). */
export function readChoices(spec: ParamChoices, text: string | undefined): Choice[] {
  if (text === undefined) return []
  let data: unknown
  try {
    data = parseConfig(spec.file, text)
  } catch {
    return []
  }
  const out: Choice[] = []
  for (const item of listOf(data, spec.list) ?? []) {
    const value = field(item, spec.value)
    if (typeof value !== 'string' && typeof value !== 'number') continue
    if (!matches(spec, item)) continue
    const label = field(item, spec.label ?? spec.value)
    const detail = spec.detail === undefined ? undefined : field(item, spec.detail)
    out.push({ value: String(value), label: String(label ?? value), ...(detail === undefined || detail === null || detail === '' ? {} : { detail: String(detail) }) })
  }
  return out
}

/**
 * The list with one more item: a copy of the first item that matches
 * `where`, with the `create.set` fields filled in.
 * @throws Error when the name is taken or there is nothing to copy.
 */
export function listWithNew(spec: ParamChoices, text: string, name: string): { list: unknown[]; value: string } {
  if (spec.create === undefined) throw new Error('这个参数不能新建')
  const data = parseConfig(spec.file, text)
  const list = listOf(data, spec.list)
  if (list === undefined) throw new Error(`${spec.file} 里还没有 ${spec.list.join('.')}：先打开脚本自己的界面建一个，之后就可以在这里复制`)
  if (list.some(item => String(field(item, spec.value)) === name)) throw new Error(`已经有「${name}」了，换一个名字`)
  const template = list.find(item => matches(spec, item))
  if (template === undefined) throw new Error('没有可以复制的现有项：先打开脚本自己的界面建一个')
  const copy = structuredClone(template) as Record<string, unknown>
  const vars: Record<string, string> = { name, uuid: randomUUID() }
  for (const [key, value] of Object.entries(spec.create.set)) copy[key] = value.replace(/\{(name|uuid)\}/g, (_, v: string) => vars[v]!)
  const value = String(copy[spec.value] ?? name)
  return { list: [...list, copy], value }
}
