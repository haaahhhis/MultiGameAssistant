import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { useStore } from '../hooks.ts'

type IconResult = { icon?: { mediaType: string; data: string } | undefined }

/** Program icons once a page load, by what they are of (`game:…`, `script:…`): null, it has none. */
const icons = new Map<string, Promise<string | null>>()

function iconOf(key: string, load: () => Promise<IconResult>): Promise<string | null> {
  let icon = icons.get(key)
  if (icon === undefined) {
    icon = load().then(r => (r.icon === undefined ? null : `data:${r.icon.mediaType};base64,${r.icon.data}`))
    icon.catch(() => icons.delete(key))
    icons.set(key, icon)
  }
  return icon
}

/**
 * An avatar from a program's own icon (a game's, a script's: games/icon,
 * scripts/icon), as on the desktop and in the Start menu; the name's first
 * character until that comes, where there is none, or when it does not load.
 */
export function ProgramAvatar({ client, iconKey, load, name, className = '' }: {
  client: AdgClient
  /** What the icon is of, for the page's cache. */
  iconKey: string
  load: () => Promise<IconResult>
  name: string
  className?: string
}) {
  const status = useStore(client.connection.status)
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    iconOf(iconKey, load).then(url => { if (live) setSrc(url) }, () => {})
    return () => { live = false }
    // `load` is a new function each render; the key says what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iconKey, status.state])
  return (
    <span className={`program-avatar${src === null ? '' : ' with-icon'} ${className}`}>
      {src === null ? [...name][0] ?? '?' : <img src={src} alt="" draggable={false} onError={() => setSrc(null)} />}
    </span>
  )
}
