import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ErrorCode, RpcError } from '@adg/protocol'

/** The image files a reply may show, by extension. */
const IMAGE_TYPES: Readonly<Record<string, string>> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
}

/** Larger than this is not an image to show in a chat (a 4K PNG is a few MB). */
export const IMAGE_FILE_MAX_BYTES = 25 * 1024 * 1024

/**
 * Where a path written in a reply points: a file:// URL, a Windows path, a
 * Git Bash path (/c/Users/…), or one relative to the agents' workspace.
 */
export function imageFilePath(written: string, workspace: string | undefined): string {
  let path = written.trim()
  if (/^file:/i.test(path)) {
    try { path = fileURLToPath(path) } catch { throw new RpcError(ErrorCode.InvalidParams, `不是有效的文件地址：${written}`) }
  }
  try { path = decodeURIComponent(path) } catch { /* not encoded */ }
  const drive = /^\/([A-Za-z])\/(.*)$/.exec(path)
  if (drive !== null && process.platform === 'win32') path = `${drive[1]!.toUpperCase()}:/${drive[2]}`
  path = path.replace(/[?#].*$/, '')
  if (!isAbsolute(path)) {
    if (workspace === undefined) throw new RpcError(ErrorCode.InvalidParams, `不知道相对路径从哪里算起：${written}`)
    path = resolve(workspace, path)
  }
  return resolve(path)
}

/** The media type of an image file by its extension; undefined for anything else. */
export function imageMediaType(path: string): string | undefined {
  return IMAGE_TYPES[/\.([A-Za-z0-9]+)$/.exec(path)?.[1]?.toLowerCase() ?? '']
}

/** Read an image file a reply shows, for the UI (attachments/file). */
export async function readImageFile(written: string, workspace: string | undefined): Promise<{ mediaType: string; data: string; path: string }> {
  const path = imageFilePath(written, workspace)
  const mediaType = imageMediaType(path)
  if (mediaType === undefined) throw new RpcError(ErrorCode.InvalidParams, `不是图片文件：${path}`)
  const info = await stat(path).catch(() => undefined)
  if (info === undefined || !info.isFile()) throw new RpcError(ErrorCode.NotFound, `找不到这个文件：${path}`)
  if (info.size > IMAGE_FILE_MAX_BYTES) throw new RpcError(ErrorCode.InvalidParams, `图片太大（${Math.round(info.size / 1024 / 1024)} MB），打开文件看`)
  return { mediaType, data: (await readFile(path)).toString('base64'), path }
}
