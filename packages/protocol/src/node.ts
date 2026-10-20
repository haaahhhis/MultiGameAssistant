/// <reference types="node" />
/**
 * `@adg/protocol/node`: small Node-side helpers the plugins share. Kept out
 * of the main entry so browser clients never pull in `node:fs`.
 */
import { randomBytes } from 'node:crypto'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'

/** The last write queued per file: writes to one file run one after another. */
const queues = new Map<string, Promise<void>>()

/**
 * Replace a file's content atomically (write a temporary file, then rename),
 * one write per file at a time. Each write gets its own temporary name, so
 * two quick saves of the same file cannot rename each other's temporary file
 * away; the last queued write wins.
 */
export function writeFileAtomic(file: string, text: string): Promise<void> {
  const previous = queues.get(file) ?? Promise.resolve()
  const next = previous.catch(() => {}).then(async () => {
    await mkdir(dirname(file), { recursive: true })
    const tmp = `${file}.${process.pid}.${randomBytes(4).toString('hex')}.tmp`
    try {
      await writeFile(tmp, text)
      await rename(tmp, file)
    } catch (error) {
      await rm(tmp, { force: true }).catch(() => {})
      throw error
    }
  })
  queues.set(file, next)
  void next.finally(() => { if (queues.get(file) === next) queues.delete(file) }).catch(() => {})
  return next
}
