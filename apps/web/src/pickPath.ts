import type { AdgClient } from '@adg/client-core'
import { desktop } from './desktop.ts'

export type PickRequest = {
  kind: 'file' | 'folder'
  title?: string
  defaultPath?: string | undefined
  filterName?: string
  extensions?: string[]
}

/**
 * Let the user pick a file or folder and learn its path: the desktop app's
 * dialog, else one the gateway opens on its computer (files/pick: the dsh
 * plugin, a browser). @returns null when the dialog was closed.
 */
export async function pickPath(client: AdgClient, request: PickRequest): Promise<string | null> {
  const bridge = desktop()
  if (bridge !== undefined) {
    const { kind, ...rest } = request
    return bridge.pickFile({ ...rest, folder: kind === 'folder' })
  }
  const { path } = await client.connection.call('files/pick', {
    kind: request.kind,
    ...(request.title === undefined ? {} : { title: request.title }),
    ...(request.defaultPath === undefined || request.defaultPath === '' ? {} : { defaultPath: request.defaultPath }),
    ...(request.filterName === undefined ? {} : { filterName: request.filterName }),
    ...(request.extensions === undefined ? {} : { extensions: request.extensions }),
  })
  return path ?? null
}
