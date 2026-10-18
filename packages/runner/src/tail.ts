/**
 * Follow a log file a script appends to: only lines written after the run
 * started, decoded in the file's encoding, surviving truncation and the file
 * appearing late. Polling, because `fs.watch` misses writes on network drives
 * and some editors' save patterns.
 */
import { open, stat } from 'node:fs/promises'
import { TextDecoder } from 'node:util'

export class LogTail {
  readonly #path: string
  readonly #decoder: TextDecoder
  readonly #onLine: (line: string) => void
  readonly #intervalMs: number
  #offset = -1
  #pending = ''
  #timer: ReturnType<typeof setInterval> | undefined
  #reading = false

  constructor(path: string, encoding: string, onLine: (line: string) => void, intervalMs = 500) {
    this.#path = path
    this.#decoder = new TextDecoder(encoding === 'gbk' ? 'gbk' : encoding)
    this.#onLine = onLine
    this.#intervalMs = intervalMs
  }

  /** Start at the current end of the file (or 0 if it does not exist yet). */
  async start(): Promise<void> {
    this.#offset = await stat(this.#path).then(s => s.size, () => 0)
    this.#timer = setInterval(() => void this.poll(), this.#intervalMs)
  }

  /** Read what was appended since the last poll. */
  async poll(): Promise<void> {
    if (this.#reading || this.#offset < 0) return
    this.#reading = true
    try {
      const size = await stat(this.#path).then(s => s.size, () => -1)
      if (size < 0) return
      if (size < this.#offset) this.#offset = 0 // truncated or rotated
      if (size === this.#offset) return
      const handle = await open(this.#path, 'r')
      try {
        const length = size - this.#offset
        const buffer = Buffer.alloc(length)
        await handle.read(buffer, 0, length, this.#offset)
        this.#offset = size
        this.#emit(this.#decoder.decode(buffer, { stream: true }))
      } finally {
        await handle.close()
      }
    } finally {
      this.#reading = false
    }
  }

  /** Stop polling after one last read; a trailing partial line is emitted. */
  async stop(): Promise<void> {
    clearInterval(this.#timer)
    await this.poll()
    const rest = this.#pending + this.#decoder.decode()
    this.#pending = ''
    if (rest.trim() !== '') this.#onLine(rest.replace(/\r$/, ''))
  }

  #emit(text: string): void {
    const parts = (this.#pending + text).split('\n')
    this.#pending = parts.pop() ?? ''
    for (const line of parts) {
      const clean = line.replace(/\r$/, '')
      if (clean !== '') this.#onLine(clean)
    }
  }
}

/** Split a stream's chunks into lines, decoding as `encoding`. */
export function lineSplitter(encoding: string, onLine: (line: string) => void): { push(chunk: Buffer): void; end(): void } {
  const decoder = new TextDecoder(encoding)
  let pending = ''
  const emit = (text: string) => {
    const parts = (pending + text).split('\n')
    pending = parts.pop() ?? ''
    for (const line of parts) {
      const clean = line.replace(/\r$/, '')
      if (clean !== '') onLine(clean)
    }
  }
  return {
    push: chunk => emit(decoder.decode(chunk, { stream: true })),
    end: () => {
      emit(decoder.decode())
      if (pending.trim() !== '') onLine(pending.replace(/\r$/, ''))
      pending = ''
    },
  }
}
