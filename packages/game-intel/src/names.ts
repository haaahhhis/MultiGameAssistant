/**
 * Event names meet in different spellings: PRTS's 名称 is
 * "SideStory「昨日海」", its page is "昨日海", the game shows 「昨日海」 and
 * the agent may write "昨日海 活动". A key drops what differs.
 */

/** Words that only say what kind of event it is. */
const KIND_WORDS = /sidestory|story|活动|限时|复刻|签到|支线故事|别传|插曲/gi

/** A name reduced to letters, digits and CJK, without event-kind words. */
export function nameKey(name: string): string {
  return name.normalize('NFKC').toLowerCase().replace(KIND_WORDS, '').replace(/[^\p{L}\p{N}]+/gu, '')
}

/** Whether two sets of names belong to the same event. */
export function sameEvent(a: readonly string[], b: readonly string[]): boolean {
  const ka = a.map(nameKey).filter(k => k.length >= 2)
  const kb = b.map(nameKey).filter(k => k.length >= 2)
  for (const x of ka) {
    for (const y of kb) {
      if (x === y) return true
      // One name inside the other, when the shorter one is specific enough ("昨日海" in "昨日海复刻纪念").
      const [short, long] = x.length <= y.length ? [x, y] : [y, x]
      if (short.length >= 3 && long.includes(short)) return true
    }
  }
  return false
}

/** A key usable in an activity id: the name key, or a hash when nothing is left. */
export function idKey(name: string): string {
  const key = nameKey(name)
  if (key !== '') return key
  let hash = 0
  for (const c of name) hash = (hash * 31 + c.codePointAt(0)!) >>> 0
  return `e${hash.toString(36)}`
}
