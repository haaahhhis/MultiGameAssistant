import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'

/** Pictures already fetched this session (the host keeps them on disk too). */
const cache = new Map<string, Promise<string>>()

function fetchImage(client: AdgClient, url: string): Promise<string> {
  let pending = cache.get(url)
  if (pending === undefined) {
    pending = client.connection.call('games/image', { url }).then(r => `data:${r.mediaType};base64,${r.data}`)
    // A failure is not kept: the next look tries again.
    pending.catch(() => cache.delete(url))
    cache.set(url, pending)
  }
  return pending
}

/**
 * The first of `urls` that can be had (a dead link at the source is skipped):
 * the version's art, then the pack's own picture, then an event's cover.
 */
export function useFirstImage(client: AdgClient, urls: readonly (string | undefined)[]): string | undefined {
  const [src, setSrc] = useState<string | undefined>(undefined)
  const key = urls.filter((u): u is string => u !== undefined).filter((u, i, all) => all.indexOf(u) === i)
  useEffect(() => {
    setSrc(undefined)
    let live = true
    void (async () => {
      for (const url of key) {
        const got = await fetchImage(client, url).catch(() => undefined)
        if (got !== undefined) { if (live) setSrc(got); return }
      }
    })()
    return () => { live = false }
  }, [client, key.join('\n')])
  return src
}

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
    fetchImage(client, url).then(s => { if (live) setSrc(s) }, () => {})
    return () => { live = false }
  }, [client, url])
  return src
}
