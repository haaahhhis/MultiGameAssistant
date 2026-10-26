/**
 * Unpack a downloaded release into a fresh directory.
 *
 * Zip archives are read in-process (yauzl rejects absolute paths and `..`
 * entries); 7z / tar.* go through the system bsdtar, which ships with
 * Windows 10+ and refuses the same paths by default. A lone `.exe` / `.msi`
 * is copied as is. When everything sits under one top-level folder, that
 * folder becomes the root, so `tools/<id>/<version>/` holds the files directly.
 */
import { execFile } from 'node:child_process'
import { createWriteStream } from 'node:fs'
import { copyFile, mkdir, open, readdir, rename, rm, stat } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { pipeline } from 'node:stream/promises'
import yauzl from 'yauzl'

export type ArchiveKind = 'zip' | 'tar' | 'single-file'

export function archiveKind(name: string): ArchiveKind | undefined {
  const lower = name.toLowerCase()
  if (lower.endsWith('.zip')) return 'zip'
  if (/\.(7z|tar|tar\.gz|tgz|tar\.xz|txz|tar\.bz2|tar\.zst)$/.test(lower)) return 'tar'
  if (/\.(exe|msi|apk|jar)$/.test(lower)) return 'single-file'
  return undefined
}

/**
 * What a file is by its first bytes, whatever its name says (a download link
 * may not name the file it serves), with the extension it should have.
 * Undefined when the bytes say nothing known.
 */
export async function contentKind(file: string): Promise<{ kind: ArchiveKind; ext: string } | undefined> {
  const handle = await open(file, 'r').catch(() => undefined)
  if (handle === undefined) return undefined
  const head = Buffer.alloc(512)
  try {
    await handle.read(head, 0, head.length, 0)
  } finally {
    await handle.close()
  }
  const starts = (...bytes: number[]) => bytes.every((b, i) => head[i] === b)
  if (starts(0x50, 0x4b, 0x03, 0x04) || starts(0x50, 0x4b, 0x05, 0x06)) return { kind: 'zip', ext: '.zip' }
  if (starts(0x37, 0x7a, 0xbc, 0xaf, 0x27, 0x1c)) return { kind: 'tar', ext: '.7z' }
  if (starts(0x1f, 0x8b)) return { kind: 'tar', ext: '.tar.gz' }
  if (starts(0xfd, 0x37, 0x7a, 0x58, 0x5a, 0x00)) return { kind: 'tar', ext: '.tar.xz' }
  if (starts(0x28, 0xb5, 0x2f, 0xfd)) return { kind: 'tar', ext: '.tar.zst' }
  if (head.toString('latin1', 257, 262) === 'ustar') return { kind: 'tar', ext: '.tar' }
  if (starts(0x4d, 0x5a)) return { kind: 'single-file', ext: '.exe' }
  if (starts(0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1)) return { kind: 'single-file', ext: '.msi' }
  return undefined
}

export interface ExtractResult {
  readonly files: number
  /** The archive's single top-level folder that was lifted, if any. */
  readonly liftedRoot?: string
}

/**
 * Extract `archive` into `dest`, which must not exist yet.
 * @param root - path inside the archive to use as the install root (pack `install.root`).
 */
export async function extract(archive: string, dest: string, options: { root?: string; signal?: AbortSignal; tar?: string } = {}): Promise<ExtractResult> {
  // The bytes decide (a `.zip` that is really an exe), except that an `.apk` or `.jar` is a zip inside and stays one file.
  const named = archiveKind(archive)
  const found = (await contentKind(archive))?.kind
  const kind = named === 'single-file' && found === 'zip' ? named : found ?? named
  if (kind === undefined) throw new Error(`不支持的文件类型：${basename(archive)}`)
  if (await stat(dest).then(() => true, () => false)) throw new Error(`目标目录已存在：${dest}`)
  const staging = `${dest}.extracting`
  await rm(staging, { recursive: true, force: true })
  await mkdir(staging, { recursive: true })
  try {
    let files: number
    if (kind === 'zip') files = await unzip(archive, staging, options.signal)
    else if (kind === 'tar') files = await untar(archive, staging, options.tar, options.signal)
    else {
      await copyFile(archive, join(staging, basename(archive)))
      files = 1
    }
    options.signal?.throwIfAborted()

    let source = staging
    let liftedRoot: string | undefined
    if (options.root !== undefined) {
      source = inside(staging, options.root)
      if (!(await stat(source).then(s => s.isDirectory(), () => false))) throw new Error(`压缩包里没有目录 ${options.root}`)
    } else {
      const top = await readdir(staging, { withFileTypes: true })
      if (top.length === 1 && top[0]!.isDirectory()) {
        liftedRoot = top[0]!.name
        source = join(staging, liftedRoot)
      }
    }
    await mkdir(dirname(dest), { recursive: true })
    await rename(source, dest)
    await rm(staging, { recursive: true, force: true })
    return { files, ...(liftedRoot === undefined ? {} : { liftedRoot }) }
  } catch (error) {
    await rm(staging, { recursive: true, force: true })
    throw error
  }
}

/** Resolve `child` under `parent`, refusing anything that escapes it. */
function inside(parent: string, child: string): string {
  const target = resolve(parent, child)
  const rel = relative(parent, target)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) throw new Error(`路径越界：${child}`)
  return target
}

function unzip(archive: string, dest: string, signal?: AbortSignal): Promise<number> {
  return new Promise((resolvePromise, reject) => {
    yauzl.open(archive, { lazyEntries: true, autoClose: true, validateEntrySizes: true }, (openError, zip) => {
      if (openError !== null) {
        reject(new Error(`无法打开压缩包：${openError.message}`))
        return
      }
      let files = 0
      let settled = false
      const fail = (error: unknown) => {
        if (settled) return
        settled = true
        try { zip.close() } catch { /* already closed */ }
        reject(error instanceof Error ? error : new Error(String(error)))
      }
      const onAbort = () => fail(signal?.reason ?? new Error('aborted'))
      signal?.addEventListener('abort', onAbort, { once: true })
      zip.on('error', error => fail(new Error(`压缩包损坏：${error.message}`)))
      zip.on('end', () => {
        signal?.removeEventListener('abort', onAbort)
        if (settled) return
        settled = true
        resolvePromise(files)
      })
      zip.on('entry', entry => {
        const target = resolve(dest, entry.fileName)
        if (!(target + sep).startsWith(resolve(dest) + sep) && target !== resolve(dest)) {
          fail(new Error(`压缩包包含越界路径：${entry.fileName}`))
          return
        }
        if (entry.fileName.endsWith('/')) {
          mkdir(target, { recursive: true }).then(() => zip.readEntry(), fail)
          return
        }
        zip.openReadStream(entry, (streamError, stream) => {
          if (streamError !== null) {
            fail(streamError)
            return
          }
          mkdir(dirname(target), { recursive: true })
            .then(() => pipeline(stream, createWriteStream(target)))
            .then(() => {
              files += 1
              zip.readEntry()
            }, fail)
        })
      })
      zip.readEntry()
    })
  })
}

async function untar(archive: string, dest: string, tar?: string, signal?: AbortSignal): Promise<number> {
  const exe = tar ?? (process.platform === 'win32' ? join(process.env['SystemRoot'] ?? 'C:\\Windows', 'System32', 'tar.exe') : 'tar')
  await new Promise<void>((resolvePromise, reject) => {
    execFile(exe, ['-xf', archive, '-C', dest], { windowsHide: true, maxBuffer: 16 * 1024 * 1024, ...(signal === undefined ? {} : { signal }) }, (error, _stdout, stderr) => {
      if (error === null) resolvePromise()
      else reject(new Error(`解压失败（${basename(archive)}）：${(stderr || error.message).trim().split('\n').slice(-3).join(' ')}`))
    })
  })
  return countFiles(dest)
}

async function countFiles(dir: string): Promise<number> {
  let count = 0
  for (const entry of await readdir(dir, { withFileTypes: true, recursive: true })) if (entry.isFile()) count += 1
  return count
}
