/**
 * How much of past runs stays on disk, after MAA's own rules
 * (MaaAssistantArknights caps its log by size — past 64 MiB `asst.log`
 * becomes `asst.bak.log`, one backup — and deletes old debug screenshots
 * outright, keeping only the newest few). A run here:
 *
 * - logs to one file, `log.jsonl` (no second copy as text). Past
 *   {@link LIVE_LOG_MAX} while it runs, the file starts over and the part
 *   before is kept as `log.prev.jsonl`, as MAA keeps `asst.bak.log`;
 * - once it has been over for {@link PACK_AFTER_MS} and nobody is handling
 *   it any more, its log is gzipped into `log.jsonl.gz` (about a tenth);
 * - the saved logs of one script's runs take about {@link SCRIPT_LOG_BUDGET}
 *   together, newest first: older runs' logs past that are deleted (their
 *   records stay, and a script's newest run keeps its log whatever its size);
 * - its folder (record, log, config backups) is deleted after {@link KEEP_DAYS} days.
 */
import { createReadStream, createWriteStream } from 'node:fs'
import { copyFile, readdir, readFile, rename, rm, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { promisify } from 'node:util'
import { createGzip, gunzip } from 'node:zlib'
import type { RunInfo, RunLogLine } from '@adg/protocol'

/** The log a run appends to. */
export const LOG_FILE = 'log.jsonl'
/** The part of a long run's log before it started over (MAA's `asst.bak.log`). */
export const PREV_LOG_FILE = 'log.prev.jsonl'
/** A finished run's log, gzipped. */
export const PACKED_LOG_FILE = 'log.jsonl.gz'
/** The text copy of the log that versions before this one wrote beside `log.jsonl`. */
export const TEXT_LOG_FILE = 'log.txt'
const LOG_FILES = [LOG_FILE, PREV_LOG_FILE, PACKED_LOG_FILE, TEXT_LOG_FILE] as const

const MiB = 1024 * 1024
/** A running log starts over past this (MAA: 64 MiB for `asst.log`). */
export const LIVE_LOG_MAX = 64 * MiB
/** One script's saved run logs, newest first, after gzip. */
export const SCRIPT_LOG_BUDGET = 64 * MiB
/** A run's log is gzipped this long after it ended (lines may still come while it is being handled). */
export const PACK_AFTER_MS = 10 * 60_000
/** Run folders are kept this long. */
export const KEEP_DAYS = 30

const gunzipAsync = promisify(gunzip)

export interface TidyResult {
  /** Run folders past {@link KEEP_DAYS}, deleted. */
  readonly expired: number
  /** Logs gzipped. */
  readonly packed: number
  /** Older runs' logs deleted to keep a script within its budget. */
  readonly trimmed: number
  /** Bytes freed. */
  readonly freed: number
}

/**
 * Apply the rules above to every saved run under `root` (`<dataDir>/runs`).
 * @param busy - runs to leave alone: still going, or someone is still handling them.
 * @param budget - one script's saved logs (tests set a small one). @default SCRIPT_LOG_BUDGET
 */
export async function tidyRuns(root: string, options: { now: number; busy: (runId: string) => boolean; budget?: number }): Promise<TidyResult> {
  const budget = options.budget ?? SCRIPT_LOG_BUDGET
  let names: string[]
  try { names = await readdir(root) } catch { return { expired: 0, packed: 0, trimmed: 0, freed: 0 } }
  let expired = 0, packed = 0, trimmed = 0, freed = 0
  const byScript = new Map<string, { dir: string; startedAt: number; endedAt: number; busy: boolean }[]>()
  for (const name of names) {
    const dir = join(root, name)
    let info: RunInfo
    try { info = JSON.parse(await readFile(join(dir, 'run.json'), 'utf8')) as RunInfo } catch { continue }
    if (typeof info.scriptId !== 'string' || typeof info.startedAt !== 'number') continue
    const busy = info.endedAt === undefined || options.busy(info.id ?? name)
    if (!busy && options.now - info.endedAt! > KEEP_DAYS * 86_400_000) {
      const size = await logBytes(dir)
      await rm(dir, { recursive: true, force: true }).then(() => { expired++; freed += size }, () => {})
      continue
    }
    const list = byScript.get(info.scriptId) ?? []
    list.push({ dir, startedAt: info.startedAt, endedAt: info.endedAt ?? Number.POSITIVE_INFINITY, busy })
    byScript.set(info.scriptId, list)
  }
  for (const runs of byScript.values()) {
    let total = 0
    for (const [i, run] of runs.sort((a, b) => b.startedAt - a.startedAt).entries()) {
      const before = await logBytes(run.dir)
      if (run.busy) { total += before; continue }
      if (i > 0 && total >= budget) {
        if (before === 0) continue
        await Promise.all(LOG_FILES.map(file => rm(join(run.dir, file), { force: true })))
        trimmed++
        freed += before - await logBytes(run.dir)
        continue
      }
      // The text copy older versions wrote is the same lines again.
      if (await exists(join(run.dir, LOG_FILE)) || await exists(join(run.dir, PACKED_LOG_FILE))) await rm(join(run.dir, TEXT_LOG_FILE), { force: true })
      if (options.now - run.endedAt >= PACK_AFTER_MS && await packLog(run.dir)) packed++
      const after = await logBytes(run.dir)
      freed += Math.max(0, before - after)
      total += after
    }
  }
  return { expired, packed, trimmed, freed }
}

/**
 * Gzip a run's plain log files into {@link PACKED_LOG_FILE} (a member added
 * after what is already there, for lines written after an earlier packing).
 * @returns whether there was anything to pack.
 */
export async function packLog(dir: string): Promise<boolean> {
  const parts = [PREV_LOG_FILE, LOG_FILE].map(file => join(dir, file))
  const present: string[] = []
  for (const part of parts) if (await exists(part)) present.push(part)
  if (present.length === 0) return false
  const packed = join(dir, PACKED_LOG_FILE)
  const temp = `${packed}.${process.pid}.tmp`
  try {
    if (await exists(packed)) await copyFile(packed, temp)
    await pipeline(concat(present), createGzip(), createWriteStream(temp, { flags: 'a' }))
    await rename(temp, packed)
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {})
    throw error
  }
  // The earlier part first: a reader caught in between sees the packed log plus a tail it already has (readRunLog).
  for (const part of present) await rm(part, { force: true })
  return true
}

/** Every saved line of a run, oldest first. @returns undefined when it has no saved log. */
export async function readRunLog(dir: string): Promise<RunLogLine[] | undefined> {
  const packed = await readFile(join(dir, PACKED_LOG_FILE)).then(bytes => gunzipAsync(bytes), () => undefined)
  const prev = await readFile(join(dir, PREV_LOG_FILE), 'utf8').catch(() => undefined)
  const current = await readFile(join(dir, LOG_FILE), 'utf8').catch(() => undefined)
  if (packed === undefined && prev === undefined && current === undefined) return undefined
  const old = packed === undefined ? [] : parseLines(packed.toString('utf8'))
  const plain = [...parseLines(prev ?? ''), ...parseLines(current ?? '')]
  // Read while being packed: the plain files left are already the end of the packed log.
  if (plain.length > 0 && old.length >= plain.length && sameLine(old[old.length - plain.length], plain[0]) && sameLine(old.at(-1), plain.at(-1))) return old
  return [...old, ...plain]
}

/** The run's saved log file to name to people: the plain one while there is one. */
export async function runLogFile(dir: string): Promise<string> {
  return await exists(join(dir, LOG_FILE)) || !(await exists(join(dir, PACKED_LOG_FILE))) ? join(dir, LOG_FILE) : join(dir, PACKED_LOG_FILE)
}

/** What a run's log files take. */
export async function logBytes(dir: string): Promise<number> {
  let total = 0
  for (const file of LOG_FILES) total += await stat(join(dir, file)).then(s => s.size, () => 0)
  return total
}

function parseLines(text: string): RunLogLine[] {
  return text.split('\n').filter(l => l !== '').flatMap(l => { try { return [JSON.parse(l) as RunLogLine] } catch { return [] } })
}

function sameLine(a: RunLogLine | undefined, b: RunLogLine | undefined): boolean {
  return a !== undefined && b !== undefined && a.at === b.at && a.source === b.source && a.text === b.text
}

async function* concat(files: readonly string[]): AsyncGenerator<Buffer> {
  for (const file of files) yield* createReadStream(file) as AsyncIterable<Buffer>
}

function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}
