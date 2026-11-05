/**
 * Where a skill belongs, for the 技能 page and the slash menu: under the game
 * it is about, and in it the script it is for. A skill saved for a script sits
 * under the game that script plays (the game pack lists its scripts); one saved
 * for a game sits under the game itself; one for neither is general.
 */
import type { SkillOwner } from '@adg/protocol'

/** What a game needs to be found (protocol GameInfo). */
export interface GameRef { readonly id: string; readonly name: string; readonly aliases: readonly string[]; readonly scripts: readonly string[] }
/** What a script needs to be found (protocol ScriptInfo). */
export interface ScriptRef { readonly id: string; readonly name: string; readonly packId?: string | undefined }

/** One place a skill shows: a game, a script, or a script in its game. */
export interface SkillPlace {
  readonly game?: { readonly id: string; readonly name: string }
  readonly script?: { readonly id: string; readonly name: string }
}

/** The game a script plays: the one whose pack lists the script's pack (or the script). */
export function gameOfScript(script: ScriptRef, games: readonly GameRef[]): GameRef | undefined {
  return games.find(g => g.scripts.includes(script.packId ?? script.id) || g.scripts.includes(script.id))
}

/** A game by id, name or alias (a saved skill may name it any of these ways). */
export function findGame(key: string, games: readonly GameRef[]): GameRef | undefined {
  const k = key.toLowerCase()
  return games.find(g => [g.id, g.name, ...g.aliases].some(n => n.toLowerCase() === k))
}

/** Every place a skill with this owner shows; none: a general skill. */
export function placesOf(owner: SkillOwner | undefined, scripts: readonly ScriptRef[], games: readonly GameRef[]): SkillPlace[] {
  const places: SkillPlace[] = []
  for (const id of new Set(owner?.scripts ?? [])) {
    const script = scripts.find(s => s.id === id || s.packId === id)
    const game = script === undefined ? games.find(g => g.scripts.includes(id)) : gameOfScript(script, games)
    places.push({ script: script === undefined ? { id, name: id } : { id: script.id, name: script.name }, ...(game === undefined ? {} : { game: { id: game.id, name: game.name } }) })
  }
  // A skill for scripts already sits under their games; one for games alone sits under each.
  if (places.length === 0) {
    for (const key of new Set(owner?.games ?? [])) {
      const game = findGame(key, games)
      places.push({ game: game === undefined ? { id: key, name: key } : { id: game.id, name: game.name } })
    }
  }
  return places
}

/** The slash menu's header for a place: 明日方舟 · MAA, 明日方舟, or MAA. */
export function placeLabel(place: SkillPlace): string {
  return [place.game?.name, place.script?.name].filter(n => n !== undefined).join(' · ')
}
