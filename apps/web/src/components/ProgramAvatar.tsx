import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { useStore } from '../hooks.ts'

type IconResult = { icon?: { mediaType: string; data: string } | undefined }

/**
 * Program icons once a page load, by what they are of (`game:…`, `script:…`).
 * Only icons found are kept: a game or script without one yet may get one
 * once its program is found or chosen.
 */
const icons = new Map<string, Promise<string | null>>()
/** Bumped when programs may have changed, so avatars without an icon ask again. */
let revision = 0
const listeners = new Set<() => void>()

function iconOf(key: string, load: () => Promise<IconResult>): Promise<string | null> {
  let icon = icons.get(key)
  if (icon === undefined) {
    icon = load().then(r => (r.icon === undefined ? null : `data:${r.icon.mediaType};base64,${r.icon.data}`))
    const pending = icon
    icon.then(url => { if (url === null && icons.get(key) === pending) icons.delete(key) }, () => { if (icons.get(key) === pending) icons.delete(key) })
    icons.set(key, icon)
  }
  return icon
}

/** A program was found or chosen (a game's 游戏位置, a script installed…): ask for the icons again. */
export function programsChanged(): void {
  icons.clear()
  revision++
  for (const listener of listeners) listener()
}

/** Clients whose change notices clear the icons, and how many avatars use each. */
const watched = new Map<AdgClient, { count: number; off: () => void }>()

function watch(client: AdgClient): () => void {
  let entry = watched.get(client)
  if (entry === undefined) {
    const offs = ['games/changed', 'scripts/changed', 'packs/changed'].map(event => client.connection.on(event as 'games/changed', programsChanged))
    entry = { count: 0, off: () => { for (const off of offs) off() } }
    watched.set(client, entry)
  }
  entry.count++
  const mine = entry
  return () => { if (--mine.count === 0) { mine.off(); watched.delete(client) } }
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
  const [seen, setSeen] = useState(revision)
  useEffect(() => {
    const listener = () => setSeen(revision)
    listeners.add(listener)
    return () => { listeners.delete(listener) }
  }, [])
  useEffect(() => watch(client), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    iconOf(iconKey, load).then(url => { if (live) setSrc(url) }, () => {})
    return () => { live = false }
    // `load` is a new function each render; the key says what it loads.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [iconKey, status.state, seen])
  return (
    <span className={`program-avatar${src === null ? '' : ' with-icon'} ${className}`}>
      {src === null ? [...name][0] ?? '?' : <img src={src} alt="" draggable={false} onError={() => setSrc(null)} />}
    </span>
  )
}
