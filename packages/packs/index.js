import { fileURLToPath } from 'node:url'

/** Directory holding the built-in Script Packs, one subdirectory per pack id (adg.script.yaml; their SKILL.md is in the skills repository). */
export const PACKS_DIR = fileURLToPath(new URL('./packs/', import.meta.url))

/**
 * Directory holding the built-in Game Packs: games/<id>/game.yaml. Their
 * guides (GAME.md) are in the skills repository (MultiGameAssistant/skills),
 * downloaded from the 技能 page; a game pack the user adds may carry its own.
 */
export const GAMES_DIR = fileURLToPath(new URL('./games/', import.meta.url))
