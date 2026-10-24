/**
 * @adg/pack-schema — the Script Pack and Game Pack contracts shared by host
 * plugins and UIs.
 *
 * A Script Pack (`<pack dir>/<id>/`) is `adg.script.yaml` (this schema) plus
 * `SKILL.md` for the agent; a Game Pack is `game.yaml` plus `GAME.md`. Core
 * code only reads packs; nothing here names a particular script or game.
 */
export {
  ConfigFile, ConfigPatch, Game, Launch, LogEncoding, LogRule, Logs, LogSource, ParamChoices, PathSegment, Recovery, Requirement, Resources, ScriptManifest, Task, TaskParam,
  type ScriptManifestInput,
} from './manifest.ts'
export { renderTask, TaskInputError, type RenderedTask } from './render.ts'
export { PackError, parseManifest } from './parse.ts'
export { GAME_GUIDE_FILE, GAME_MANIFEST_FILE, GameManifest, GameSource, parseGameManifest, SmwSource, SraSource, type GameManifestInput } from './game.ts'
export { chooseAsset, expand, globToRegExp, versionOfTag, type AssetChoice } from './match.ts'

/** File names inside a pack directory. */
export const MANIFEST_FILE = 'adg.script.yaml'
export const SKILL_FILE = 'SKILL.md'
