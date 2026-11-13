/**
 * Matching words in memory and conversation text, for the searches
 * (memory.ts, history.ts) and for what a turn recalls by itself (recall.ts).
 *
 * Chinese is written without spaces, so a word there is a substring; where a
 * whole phrase is not found, the pairs of characters inside it stand for the
 * words it is made of.
 */

const HAN_RUN = /[一-鿿]{2,}/g

/** A text as it is compared: one case, one kind of space. */
export const flat = (text: string): string => text.toLowerCase().replace(/\s+/g, ' ').trim()

/** The pairs of characters in a run of Chinese. */
function pairs(run: string): string[] {
  const out: string[] = []
  for (let at = 0; at + 1 < run.length; at++) out.push(run.slice(at, at + 2))
  return out
}

/** What a search was asked for: its words, as typed (spaces apart, any case). */
export function termsOf(query: string): string[] {
  return [...new Set(query.toLowerCase().split(/\s+/).filter(term => term !== ''))]
}

/**
 * How much of one search word a text holds: 1 when it is there whole;
 * for a Chinese phrase of three characters or more that is not, the share of
 * its character pairs that are (a phrase said another way still shares most).
 */
export function termShare(lower: string, term: string): number {
  if (lower.includes(term)) return 1
  const runs = (term.match(HAN_RUN) ?? []).filter(run => run.length >= 3)
  if (runs.length === 0) return 0
  const all = runs.flatMap(pairs)
  const found = all.filter(pair => lower.includes(pair)).length
  const share = found / all.length
  return share >= 0.5 ? share / 2 : 0
}

/** How many of the search words a text holds (a phrase found in part counts for part). */
export function termScore(text: string, terms: readonly string[]): number {
  const lower = text.toLowerCase()
  return terms.reduce((sum, term) => sum + termShare(lower, term), 0)
}

/** Does a text hold every search word, whole? */
export function hasAll(text: string, terms: readonly string[]): boolean {
  const lower = text.toLowerCase()
  return terms.every(term => lower.includes(term))
}

/**
 * The words of a free text (a message, an entry), to compare two texts by:
 * Latin words and numbers of two characters or more, and pairs of Chinese
 * characters.
 */
export function wordsOf(text: string): Set<string> {
  const lower = flat(text)
  const words = new Set(lower.match(/[a-z0-9]{2,}/g) ?? [])
  for (const run of lower.match(HAN_RUN) ?? []) for (const pair of pairs(run)) words.add(pair)
  return words
}

export interface Ranked<T> {
  readonly item: T
  /** Rarer shared words weigh more. */
  readonly score: number
  /** How many of the asked words it shares. */
  readonly hits: number
  /** The share of its own words that were asked for. */
  readonly covers: number
}

const K1 = 1.2
const B = 0.75

/**
 * Items sharing words with what was said, best first (BM25 over the items
 * given: they are few, so nothing is indexed).
 */
export function rankByWords<T>(items: readonly T[], said: string, textOf: (item: T) => string): Ranked<T>[] {
  const asked = wordsOf(said)
  if (asked.size === 0) return []
  const docs = items.map(item => ({ item, words: wordsOf(textOf(item)) }))
  const average = docs.reduce((sum, doc) => sum + doc.words.size, 0) / Math.max(docs.length, 1)
  const seenIn = new Map<string, number>()
  for (const doc of docs) for (const word of doc.words) if (asked.has(word)) seenIn.set(word, (seenIn.get(word) ?? 0) + 1)
  const idf = (word: string) => Math.log(1 + (docs.length - seenIn.get(word)! + 0.5) / (seenIn.get(word)! + 0.5))
  return docs.flatMap(doc => {
    const hits = [...doc.words].filter(word => asked.has(word))
    if (hits.length === 0) return []
    const norm = K1 * (1 - B + B * doc.words.size / Math.max(average, 1))
    const score = hits.reduce((sum, word) => sum + idf(word) * (K1 + 1) / (1 + norm), 0)
    return [{ item: doc.item, score, hits: hits.length, covers: hits.length / doc.words.size }]
  }).sort((a, b) => b.score - a.score)
}

/** Around the first search word found, `width` characters of the text on one line. */
export function snippetAround(text: string, terms: readonly string[], width: number): string {
  const line = text.replace(/\s+/g, ' ')
  const lower = line.toLowerCase()
  const found = terms.map(term => lower.indexOf(term)).filter(at => at >= 0)
  const at = found.length === 0 ? 0 : Math.min(...found)
  const start = Math.max(0, at - Math.floor(width / 2))
  const end = Math.min(line.length, start + width)
  return `${start > 0 ? '…' : ''}${line.slice(start, end)}${end < line.length ? '…' : ''}`
}
