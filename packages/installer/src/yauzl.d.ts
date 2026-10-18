// Minimal typings for the parts of yauzl 3 the installer uses (the package ships none).
declare module 'yauzl' {
  import type { EventEmitter } from 'node:events'
  import type { Readable } from 'node:stream'

  export interface Entry {
    readonly fileName: string
    readonly uncompressedSize: number
    readonly externalFileAttributes: number
  }

  export interface ZipFile extends EventEmitter {
    readonly entryCount: number
    readEntry(): void
    openReadStream(entry: Entry, callback: (error: Error | null, stream: Readable) => void): void
    close(): void
    on(event: 'entry', listener: (entry: Entry) => void): this
    on(event: 'end' | 'close', listener: () => void): this
    on(event: 'error', listener: (error: Error) => void): this
  }

  export interface Options {
    lazyEntries?: boolean
    autoClose?: boolean
    decodeStrings?: boolean
    validateEntrySizes?: boolean
    strictFileNames?: boolean
  }

  export function open(path: string, options: Options, callback: (error: Error | null, zipfile: ZipFile) => void): void

  const yauzl: { open: typeof open }
  export default yauzl
}
