/**
 * Which installed scripts play which game, for games whose pack does not
 * list them (a game followed from SRA, one the agent added, a script the
 * user installed from any repository): a script plays the game whose words
 * appear in its id, name, repository, folder or its pack's game. When words
 * of several games appear, the most specific match wins ("明日方舟：终末地"
 * over "明日方舟"), so MaaEnd is not taken for a 明日方舟 script.
 */

export interface ScriptText {
  readonly id: string
  /** id, name, repository, folder name, the pack's game name… */
  readonly texts: readonly string[]
}

export interface GameWords {
  readonly id: string
  /** Its name, aliases and the usual names of its scripts. */
  readonly words: readonly string[]
}

/** Lower case, without spaces and punctuation: "Ok-Wuthering Waves" → "okwutheringwaves". */
export function normalize(text: string): string {
  return text.toLowerCase().replace(/[\s\-_.:：·・,，、/\\()（）「」【】[\]'"!！?？]+/g, '')
}

/** How specific a word is: a Chinese character counts as two letters. */
function weight(word: string): number {
  let n = 0
  for (const ch of word) n += ch.charCodeAt(0) > 0x2e80 ? 2 : 1
  return n
}

/** Shorter than this, a word would match too much ("ak", "ys"). */
const MIN_WEIGHT = 3

/** @returns script id → the games it plays (empty: none matched). */
export function matchScripts(scripts: readonly ScriptText[], games: readonly GameWords[]): Map<string, string[]> {
  const prepared = games.map(g => ({ id: g.id, words: [...new Set(g.words.map(normalize))].filter(w => weight(w) >= MIN_WEIGHT) }))
  const out = new Map<string, string[]>()
  for (const script of scripts) {
    const text = script.texts.map(normalize).join('|')
    let best = 0
    let ids: string[] = []
    for (const game of prepared) {
      const score = Math.max(0, ...game.words.filter(w => text.includes(w)).map(weight))
      if (score === 0 || score < best) continue
      if (score > best) { best = score; ids = [] }
      ids.push(game.id)
    }
    out.set(script.id, ids)
  }
  return out
}
