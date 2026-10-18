/**
 * @adg/pack-schema — the Script Pack contract shared by host plugins and UIs.
 *
 * A Script Pack (`<pack dir>/<id>/`) is `adg.script.yaml` (this schema) plus
 * `SKILL.md` for the agent. Core code only reads packs; nothing here names a
 * particular script.
 */
export {
  ConfigFile, ConfigPatch, Launch, LogEncoding, LogRule, Logs, LogSource, Recovery, Requirement, Resources, ScriptManifest, Task, TaskParam,
  type ScriptManifestInput,
} from './manifest.ts'
export { renderTask, TaskInputError, type RenderedTask } from './render.ts'
export { PackError, parseManifest } from './parse.ts'
export { chooseAsset, expand, globToRegExp, versionOfTag, type AssetChoice } from './match.ts'

/** File names inside a pack directory. */
export const MANIFEST_FILE = 'adg.script.yaml'
export const SKILL_FILE = 'SKILL.md'
