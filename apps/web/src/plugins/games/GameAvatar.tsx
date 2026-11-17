import type { AdgClient } from '@adg/client-core'
import type { GameInfo } from '@adg/protocol'
import { ProgramAvatar } from '../../components/ProgramAvatar.tsx'

/** A game's avatar: its program's own icon (games/icon), else its name's first character on its colour. */
export function GameAvatar({ client, game, className = '' }: { client: AdgClient; game: GameInfo; className?: string }) {
  return (
    <ProgramAvatar client={client} iconKey={`game:${game.id}`} name={game.name} className={`rail-avatar game-avatar ${className}`}
      load={() => client.connection.call('games/icon', { game: game.id })} />
  )
}
