import { fileURLToPath } from 'node:url'

/**
 * The official Script Packs and Game Packs as they are published to the 技能库
 * (MultiGameAssistant/skills): kept here so the schema's tests check them, and
 * copied there with `node scripts/publish-packs.mjs <skills checkout>`. The app
 * does not ship them: it downloads them from the 技能库 on the first start, and
 * the user may delete any.
 */

/** packs/<id>/adg.script.yaml, one subdirectory per pack id (its SKILL.md is in the skills repository). */
export const PACKS_DIR = fileURLToPath(new URL('./packs/', import.meta.url))

/** games/<id>/game.yaml (its guide is the skills repository's game-<id> SKILL.md). */
export const GAMES_DIR = fileURLToPath(new URL('./games/', import.meta.url))
