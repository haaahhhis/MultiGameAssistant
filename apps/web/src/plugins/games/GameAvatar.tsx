import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { GameInfo } from '@adg/protocol'
import { useStore } from '../../hooks.ts'

/** Program icons by game, once a page load: null, the game has none (a phone game, no program found). */
const icons = new Map<string, Promise<string | null>>()

function iconOf(client: AdgClient, game: string): Promise<string | null> {
  let icon = icons.get(game)
  if (icon === undefined) {
    icon = client.connection.call('games/icon', { game }).then(r => (r.icon === undefined ? null : `data:${r.icon.mediaType};base64,${r.icon.data}`))
    icon.catch(() => icons.delete(game))
    icons.set(game, icon)
  }
  return icon
}

/**
 * A game's avatar: its program's own icon (games/icon), as on the desktop and
 * in the Start menu; its name's first character on its colour until that
 * comes, where there is none, or when it does not load.
 */
export function GameAvatar({ client, game, className = '' }: { client: AdgClient; game: GameInfo; className?: string }) {
  const status = useStore(client.connection.status)
  const [src, setSrc] = useState<string | null>(null)
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    iconOf(client, game.id).then(url => { if (live) setSrc(url) }, () => {})
    return () => { live = false }
  }, [client, game.id, status.state])
  return (
    <span className={`rail-avatar game-avatar${src === null ? '' : ' with-icon'} ${className}`}>
      {src === null ? [...game.name][0] ?? '?' : <img src={src} alt="" draggable={false} onError={() => setSrc(null)} />}
    </span>
  )
}
