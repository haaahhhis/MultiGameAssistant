/**
 * The games the StarRailAssistant public API has activity files for
 * (https://starrailassistant.top/reference/public-api/). One without a Game
 * Pack can still be followed: it becomes a game of its own on the board, read
 * once a day like the others, with no scripts and no screen reading.
 */
import { GameManifest } from '@adg/pack-schema'

export interface SraGame {
  readonly sra: string
  readonly name: string
  /** Where its times are written; the API gives server time without a zone. */
  readonly timezone: string
  /** Other names, and words in the names of its usual scripts (script-match.ts): an installed ok-ww plays 鸣潮. */
  readonly words: readonly string[]
}

export const SRA_GAMES: readonly SraGame[] = [
  { sra: 'sr', name: '崩坏：星穹铁道', timezone: 'Asia/Shanghai', words: ['星穹铁道', '星铁', '崩铁', 'Star Rail', 'StarRail', 'HSR', 'March7th', '三月七'] },
  { sra: 'ys', name: '原神', timezone: 'Asia/Shanghai', words: ['Genshin', 'BetterGI', 'better-genshin'] },
  { sra: 'zzz', name: '绝区零', timezone: 'Asia/Shanghai', words: ['Zenless', 'ZZZ', 'OneDragon', '一条龙'] },
  { sra: 'ww', name: '鸣潮', timezone: 'Asia/Shanghai', words: ['Wuthering', 'ok-ww', 'okww', 'WutheringWaves'] },
  { sra: 'nte', name: '异环', timezone: 'Asia/Shanghai', words: ['Neverness'] },
  { sra: 'ak', name: '明日方舟', timezone: 'Asia/Shanghai', words: ['方舟', 'Arknights', 'MaaAssistantArknights'] },
  { sra: 'end', name: '明日方舟：终末地', timezone: 'Asia/Shanghai', words: ['终末地', 'Endfield', 'Arknights Endfield', 'MaaEnd'] },
  { sra: 'ba-cn', name: '蔚蓝档案（国服）', timezone: 'Asia/Shanghai', words: ['蔚蓝档案', 'Blue Archive', 'BlueArchive', 'BAAH', 'BAAS'] },
  { sra: 'ba-jp', name: '蔚蓝档案（日服）', timezone: 'Asia/Tokyo', words: ['蔚蓝档案日服', 'Blue Archive JP'] },
  { sra: 'ba-global', name: '蔚蓝档案（国际服）', timezone: 'Asia/Shanghai', words: ['蔚蓝档案国际服', 'Blue Archive Global'] },
  { sra: 'xtlr', name: '星塔旅人', timezone: 'Asia/Shanghai', words: [] },
  { sra: 'infinitynikki', name: '无限暖暖', timezone: 'Asia/Shanghai', words: ['Infinity Nikki', 'InfinityNikki'] },
  { sra: 'gf2', name: '少女前线2：追放', timezone: 'Asia/Shanghai', words: ['少女前线2', '少前2', 'GF2', 'Exilium'] },
  { sra: 'pgr', name: '战双帕弥什', timezone: 'Asia/Shanghai', words: ['战双', 'Punishing Gray Raven'] },
  { sra: 'czn', name: '卡厄斯梦境（国际服）', timezone: 'Asia/Shanghai', words: ['卡厄斯梦境', 'Chaos Zero Nightmare'] },
  { sra: 'bd2', name: '棕色尘埃2', timezone: 'Asia/Shanghai', words: ['Brown Dust 2', 'BrownDust2'] },
  { sra: 'nikke', name: 'NIKKE（国际服）', timezone: 'Asia/Shanghai', words: ['NIKKE', '胜利女神'] },
  { sra: 'hyrz', name: '火影忍者', timezone: 'Asia/Shanghai', words: ['火影'] },
]

/** The board's id for a followed SRA game. */
export const followedId = (sra: string): string => `sra-${sra}`

/** A followed game as if it had a pack: one source, the SRA API. */
export function followedManifest(game: SraGame): GameManifest {
  return GameManifest.parse({
    id: followedId(game.sra),
    name: game.name,
    timezone: game.timezone,
    sources: [{ id: 'sra', name: 'SRA 公共 API', homepage: 'https://starrailassistant.top/reference/public-api/', sra: { game: game.sra } }],
  })
}
