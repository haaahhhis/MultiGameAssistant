/**
 * Config edits for one run, with the originals kept so they can be put back.
 *
 * Only files a task's pack declares are touched (the guard enforces the same
 * rule for the agent). JSON keeps its BOM and indentation style; YAML is edited
 * as a document, so comments and layout survive.
 */
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'
import type { ConfigPatch } from '@adg/pack-schema'
import { parseDocument } from 'yaml'

export interface AppliedPatches {
  /** Relative paths edited. */
  readonly files: readonly string[]
  /** Relative paths skipped because they do not exist (and were not required). */
  readonly skipped: readonly string[]
  /** Write the original bytes back. Safe to call twice. */
  restore(): Promise<void>
}

/** Resolve `rel` under `dir`, refusing paths that escape it. */
export function inside(dir: string, rel: string): string {
  const target = resolve(dir, rel)
  const back = relative(resolve(dir), target)
  if (back === '' || back.startsWith('..') || isAbsolute(back)) throw new Error(`配置路径越界：${rel}`)
  return target
}

/**
 * Apply `patches` under `dir`; originals are also copied to `backupDir`
 * (so a crash mid-run still leaves a way back).
 * @throws Error for a required file that is missing or a file that cannot be parsed; nothing is left half-applied.
 */
export async function applyPatches(dir: string, patches: readonly ConfigPatch[], backupDir: string): Promise<AppliedPatches> {
  const originals = new Map<string, Buffer>()
  const skipped: string[] = []
  const edited = new Map<string, string>()
  // Group by file so several patches to one file are one read and one write.
  const byFile = new Map<string, ConfigPatch['set'][number][]>()
  for (const patch of patches) {
    const list = byFile.get(patch.file) ?? []
    list.push(...patch.set)
    byFile.set(patch.file, list)
  }
  for (const [file, ops] of byFile) {
    const path = inside(dir, file)
    let bytes: Buffer
    try {
      bytes = await readFile(path)
    } catch {
      if (patches.some(p => p.file === file && p.required)) throw new Error(`缺少配置文件 ${file}；请先运行一次脚本，让它生成默认配置`)
      skipped.push(file)
      continue
    }
    originals.set(file, bytes)
    edited.set(file, editText(file, bytes.toString('utf8'), ops))
  }

  for (const [file, bytes] of originals) {
    const backup = inside(backupDir, file)
    await mkdir(dirname(backup), { recursive: true })
    await writeFile(backup, bytes)
  }
  const written: string[] = []
  const restore = async () => {
    for (const file of written.splice(0)) await writeFile(inside(dir, file), originals.get(file)!)
  }
  try {
    for (const [file, text] of edited) {
      await writeFile(inside(dir, file), text)
      written.push(file)
    }
  } catch (error) {
    await restore()
    throw error
  }
  return { files: [...written], skipped, restore }
}

function editText(file: string, text: string, ops: ConfigPatch['set']): string {
  const bom = text.startsWith('﻿') ? '﻿' : ''
  const body = bom === '' ? text : text.slice(1)
  if (/\.ya?ml$/i.test(file)) {
    const doc = parseDocument(body)
    if (doc.errors.length > 0) throw new Error(`无法解析 ${file}：${doc.errors[0]!.message}`)
    for (const op of ops) doc.setIn(op.path, op.value)
    return bom + String(doc)
  }
  let data: unknown
  try {
    data = body.trim() === '' ? {} : JSON.parse(body)
  } catch (error) {
    throw new Error(`无法解析 ${file}：${error instanceof Error ? error.message : String(error)}`)
  }
  for (const op of ops) data = setIn(data, op.path, op.value, file)
  // Keep the file's own indentation: that of its first indented key.
  const indent = /^([ \t]+)"/m.exec(body)?.[1] ?? '    '
  const eol = body.includes('\r\n') ? '\r\n' : '\n'
  return bom + JSON.stringify(data, null, indent).replace(/\n/g, eol) + (body.endsWith('\n') ? eol : '')
}

/** Set `value` at `path`, creating objects along the way; arrays are indexed by number. */
export function setIn(root: unknown, path: readonly (string | number)[], value: unknown, file = 'config'): unknown {
  const [head, ...rest] = path
  if (head === undefined) return value
  if (typeof head === 'number') {
    const array = Array.isArray(root) ? [...root] : []
    if (!Array.isArray(root) && root !== undefined && root !== null) throw new Error(`${file}：${head} 处不是数组`)
    array[head] = setIn(array[head], rest, value, file)
    return array
  }
  if (root !== undefined && root !== null && (typeof root !== 'object' || Array.isArray(root))) throw new Error(`${file}：${head} 的上一级不是对象`)
  const object = { ...(root as Record<string, unknown> | undefined) }
  object[head] = setIn(object[head], rest, value, file)
  return object
}

export function backupDirFor(dataDir: string, runId: string): string {
  return join(dataDir, 'runs', runId, 'backup')
}
