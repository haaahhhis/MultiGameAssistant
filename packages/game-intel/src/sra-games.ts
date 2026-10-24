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
}

export const SRA_GAMES: readonly SraGame[] = [
  { sra: 'sr', name: '崩坏：星穹铁道', timezone: 'Asia/Shanghai' },
  { sra: 'ys', name: '原神', timezone: 'Asia/Shanghai' },
  { sra: 'zzz', name: '绝区零', timezone: 'Asia/Shanghai' },
  { sra: 'ww', name: '鸣潮', timezone: 'Asia/Shanghai' },
  { sra: 'nte', name: '异环', timezone: 'Asia/Shanghai' },
  { sra: 'ak', name: '明日方舟', timezone: 'Asia/Shanghai' },
  { sra: 'end', name: '明日方舟：终末地', timezone: 'Asia/Shanghai' },
  { sra: 'ba-cn', name: '蔚蓝档案（国服）', timezone: 'Asia/Shanghai' },
  { sra: 'ba-jp', name: '蔚蓝档案（日服）', timezone: 'Asia/Tokyo' },
  { sra: 'ba-global', name: '蔚蓝档案（国际服）', timezone: 'Asia/Shanghai' },
  { sra: 'xtlr', name: '星塔旅人', timezone: 'Asia/Shanghai' },
  { sra: 'infinitynikki', name: '无限暖暖', timezone: 'Asia/Shanghai' },
  { sra: 'gf2', name: '少女前线2：追放', timezone: 'Asia/Shanghai' },
  { sra: 'pgr', name: '战双帕弥什', timezone: 'Asia/Shanghai' },
  { sra: 'czn', name: '卡厄斯梦境（国际服）', timezone: 'Asia/Shanghai' },
  { sra: 'bd2', name: '棕色尘埃2', timezone: 'Asia/Shanghai' },
  { sra: 'nikke', name: 'NIKKE（国际服）', timezone: 'Asia/Shanghai' },
  { sra: 'hyrz', name: '火影忍者', timezone: 'Asia/Shanghai' },
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
