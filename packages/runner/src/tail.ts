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
  readonly #lines: LineSplitter
  readonly #intervalMs: number
  #offset = -1
  #timer: ReturnType<typeof setInterval> | undefined
  #reading = false

  constructor(path: string, encoding: string, onLine: (line: string) => void, intervalMs = 500) {
    this.#path = path
    this.#lines = lineSplitter(encoding, onLine)
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
        this.#lines.push(buffer)
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
    this.#lines.end()
  }
}

export interface LineSplitter {
  push(chunk: Buffer): void
  end(): void
}

/**
 * What Windows programs print when they do not print UTF-8: the ANSI code
 * page, GBK on Chinese systems (GB18030 decodes all of GBK).
 */
const LEGACY = 'gb18030'

/**
 * Split a stream's chunks into lines, decoding as `encoding`.
 *
 * `auto` decodes each line as UTF-8 when it is valid UTF-8, otherwise as
 * GB18030. Python scripts, for one, print in the console code page when their
 * output is piped. Once a line needed GB18030, later non-ASCII lines use it
 * too, so a short GBK line that happens to be valid UTF-8 is not misread.
 */
export function lineSplitter(encoding: string, onLine: (line: string) => void): LineSplitter {
  const emitLine = (line: string) => {
    const clean = line.replace(/\r$/, '')
    if (clean.trim() !== '') onLine(clean)
  }
  if (encoding === 'utf-16le') return textSplitter(new TextDecoder('utf-16le'), emitLine)

  // UTF-8 and GBK never have a 0x0A byte inside a character, so lines split on bytes.
  const strict = new TextDecoder('utf-8', { fatal: true })
  const utf8 = new TextDecoder('utf-8')
  const legacy = new TextDecoder(encoding === 'gbk' ? 'gbk' : LEGACY)
  let sawLegacy = false
  const decode = (bytes: Buffer): string => {
    if (encoding === 'utf-8') return utf8.decode(bytes)
    if (encoding === 'gbk') return legacy.decode(bytes)
    if (sawLegacy && bytes.some(b => b >= 0x80)) return legacy.decode(bytes)
    try {
      return strict.decode(bytes)
    } catch {
      sawLegacy = true
      return legacy.decode(bytes)
    }
  }
  let pending: Buffer = Buffer.alloc(0)
  return {
    push: chunk => {
      let data = pending.length === 0 ? chunk : Buffer.concat([pending, chunk])
      for (let nl = data.indexOf(0x0a); nl >= 0; nl = data.indexOf(0x0a)) {
        emitLine(decode(data.subarray(0, nl)))
        data = data.subarray(nl + 1)
      }
      pending = Buffer.from(data)
    },
    end: () => {
      if (pending.length > 0) emitLine(decode(pending))
      pending = Buffer.alloc(0)
    },
  }
}

function textSplitter(decoder: TextDecoder, emitLine: (line: string) => void): LineSplitter {
  let pending = ''
  const emit = (text: string) => {
    const parts = (pending + text).split('\n')
    pending = parts.pop() ?? ''
    for (const line of parts) emitLine(line)
  }
  return {
    push: chunk => emit(decoder.decode(chunk, { stream: true })),
    end: () => {
      emit(decoder.decode())
      emitLine(pending)
      pending = ''
    },
  }
}
