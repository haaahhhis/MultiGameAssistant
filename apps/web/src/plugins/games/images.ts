import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'

/** Pictures already fetched this session (the host keeps them on disk too). */
const cache = new Map<string, Promise<string>>()

/**
 * A data site's picture as a data: URL. The page's content policy loads no
 * outside addresses, so the host fetches it (`games/image`) and keeps it.
 * @returns undefined until it is there, or when it cannot be had.
 */
export function useRemoteImage(client: AdgClient, url: string | undefined): string | undefined {
  const [src, setSrc] = useState<string | undefined>(undefined)
  useEffect(() => {
    setSrc(undefined)
    if (url === undefined) return
    let live = true
    let pending = cache.get(url)
    if (pending === undefined) {
      pending = client.connection.call('games/image', { url }).then(r => `data:${r.mediaType};base64,${r.data}`)
      // A failure is not kept: the next look tries again.
      pending.catch(() => cache.delete(url))
      cache.set(url, pending)
    }
    pending.then(s => { if (live) setSrc(s) }, () => {})
    return () => { live = false }
  }, [client, url])
  return src
}
