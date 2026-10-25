/**
 * `adg.script.yaml`: the machine-readable half of a Script Pack
 * (docs/PLAN.zh.md §3). The other half, `SKILL.md`, is prose for the agent.
 *
 * M1 consumes identity, source, install, config and detect. The run-time
 * sections (launch, tasks, logs, intervention, update) are validated as open
 * objects so packs can already carry them; their schemas tighten in the
 * milestones that execute them (M2 runner, M3 monitor, M5 intervene).
 */
import { ScriptFamily, ScriptId } from '@adg/protocol'
import { z } from 'zod'

/** One runtime requirement, checked by the installer's environment checks. */
export const Requirement = z.object({
  /** e.g. `dotnet-desktop-runtime`, `vcredist`, `adb`, `python`, `node`, `emulator`. */
  kind: z.string().regex(/^[a-z][a-z0-9-]*$/),
  /** Version range: `>=8`, `>=3.11`, or an exact version. */
  version: z.string().optional(),
  arch: z.enum(['x64', 'x86', 'arm64']).optional(),
  /** Preferred provider, e.g. `mumu` for an emulator. */
  prefer: z.string().optional(),
  /** Reported but never blocks. */
  optional: z.boolean().optional(),
  /** Shown to the user next to the requirement. */
  note: z.string().optional(),
})
export type Requirement = z.infer<typeof Requirement>

/** A file the pack is allowed to write: the only writes the guard permits. */
export const ConfigFile = z.object({
  /** Relative to the install directory; `*` matches within one path segment. */
  path: z.string().min(1).refine(p => !p.split(/[\\/]/).includes('..') && !/^([A-Za-z]:|[\\/])/.test(p), 'must stay inside the install directory'),
  format: z.enum(['json', 'yaml', 'toml', 'ini', 'text']),
  /** Carried over to the new version on update (default true). */
  keepOnUpdate: z.boolean().optional(),
})
export type ConfigFile = z.infer<typeof ConfigFile>

const open = z.record(z.string(), z.unknown())

/** A path relative to the script directory that cannot escape it. */
const RelativePath = z.string().min(1).refine(p => !p.split(/[\\/]/).includes('..') && !/^([A-Za-z]:|[\\/])/.test(p), 'must stay inside the script directory')

/** One task parameter; values are substituted as `{name}` in args and patch values. */
const Regex = z.string().min(1).refine(value => { try { new RegExp(value); return true } catch { return false } }, 'invalid regular expression')

/**
 * The parameter's values come from a list in one of the script's config
 * files (read from the local copy), e.g. MXU instances:
 * `{ file: config/mxu-MaaEnd.json, list: [instances], value: name, detail: controllerName }`.
 */
export const ParamChoices = z.object({
  /** One of `config.files`. */
  file: z.string().min(1),
  /** Keys leading to the array. */
  list: z.array(z.string().min(1)).min(1),
  /** Field of each item that is the parameter's value. */
  value: z.string().min(1),
  /** Field shown to people (default: `value`). */
  label: z.string().optional(),
  /** Field shown beside it, e.g. the controller. */
  detail: z.string().optional(),
  /** Only items whose `field` matches (a regular expression, case-insensitive). */
  where: z.object({ field: z.string().min(1), match: Regex }).optional(),
  /**
   * New items may be made by copying an existing one (the first that
   * matches `where`), so the structure stays the script's own; `set` fields
   * are templates over `{name}` and `{uuid}`.
   */
  create: z.object({ set: z.record(z.string(), z.string()) }).optional(),
})
export type ParamChoices = z.infer<typeof ParamChoices>

export const TaskParam = z.object({
  type: z.enum(['string', 'integer', 'number', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Allowed values (for `string` / `integer`). */
  enum: z.array(z.union([z.string(), z.number()])).min(1).optional(),
  /** Allowed values read from the script's config. */
  choices: ParamChoices.optional(),
  description: z.string().optional(),
})
export type TaskParam = z.infer<typeof TaskParam>

/** A key, an array index, or the array item whose `field` equals `equals` (a template). */
export const PathSegment = z.union([
  z.string().min(1),
  z.number().int().min(0),
  z.object({ where: z.object({ field: z.string().min(1), equals: z.string() }) }),
])
export type PathSegment = z.infer<typeof PathSegment>

/**
 * One config edit made for a run: set `value` at `path` (an array, so keys
 * containing dots stay intact). String values are templates.
 */
export const ConfigPatch = z.object({
  file: RelativePath,
  /** A missing file is skipped with a warning unless required. */
  required: z.boolean().default(false),
  /**
   * Apply only then. `emulator-managed`: MultiGameAssistant started the
   * emulator (MuMu), so the script's own "start the emulator" goes off; with a
   * manual ADB address the script keeps starting its emulator itself.
   */
  when: z.enum(['emulator-managed']).optional(),
  set: z.array(z.object({
    path: z.array(PathSegment).min(1),
    value: z.unknown(),
  })).min(1),
})
export type ConfigPatch = z.infer<typeof ConfigPatch>

/** What a task occupies while it runs (docs/PLAN.zh.md §3.2); the orchestrator serializes conflicts. */
export const Resources = z.object({
  /** `desktop`: takes the mouse and keyboard; `window`: background window input; `adb`: an emulator; `none`. */
  input: z.enum(['desktop', 'window', 'adb', 'none']).default('none'),
  /** Emulator provider to prefer for `adb` (e.g. `mumu`). */
  emulator: z.string().optional(),
  /** Game account; two runs on one account never overlap. */
  account: z.string().optional(),
})
export type Resources = z.infer<typeof Resources>

export const Task = z.object({
  id: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/),
  title: z.string().min(1),
  description: z.string().optional(),
  /** What a user might say for this task; helps the agent match requests. */
  utterances: z.array(z.string()).default([]),
  params: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]*$/), TaskParam).default({}),
  /** Arguments appended to `launch.args`; templates. */
  args: z.array(z.string()).default([]),
  /** Config edits made before launch. */
  patches: z.array(ConfigPatch).default([]),
  resources: Resources.default({ input: 'none' }),
  /**
   * How success is judged from the script's own output: `exit-code` (0 is
   * success; a `done` log line also counts), or `done-log` (a `done` log rule
   * must match; for GUIs whose exit code says nothing).
   */
  success: z.enum(['exit-code', 'done-log']).default('exit-code'),
  /** Typical duration, e.g. `40m`; runs far beyond it are flagged. */
  expectedDuration: z.string().regex(/^\d+(s|m|h)$/).optional(),
})
export type Task = z.infer<typeof Task>

export const Launch = z.object({
  /** Program to start, relative to the script directory. */
  exe: RelativePath,
  args: z.array(z.string()).default([]),
  /** Working directory relative to the script directory (default: the script directory). */
  cwd: RelativePath.optional(),
  /** Stop the program once a `done` log rule matches (for GUIs that stay open). */
  stopAfterDone: z.boolean().default(false),
  /** Seconds to wait after a `done` match before stopping. */
  stopGraceSeconds: z.number().int().min(0).max(600).default(10),
  /**
   * The script's own settings window, opened in a settings session: the
   * local config is put in place, the user changes settings there, and what
   * the script saves is kept in the local copy. Omitted: the main program
   * (`exe` + `args`) is opened instead, which suits GUIs that are their own
   * settings window; declare it when the main program starts working on its own.
   */
  settings: z.object({
    exe: RelativePath,
    args: z.array(z.string()).default([]),
  }).optional(),
})
export type Launch = z.infer<typeof Launch>

/**
 * How a log's bytes are decoded. `auto`: each line as UTF-8 when valid,
 * otherwise as GBK/GB18030 (what Windows programs print in the console code
 * page on Chinese systems).
 */
export const LogEncoding = z.enum(['auto', 'utf-8', 'gbk', 'utf-16le'])
export type LogEncoding = z.infer<typeof LogEncoding>

export const LogSource = z.union([
  z.object({ stdout: z.literal(true), encoding: LogEncoding.default('auto') }),
  z.object({ path: RelativePath, encoding: LogEncoding.default('auto') }),
])
export type LogSource = z.infer<typeof LogSource>

export const LogRule = z.object({
  /** Regular expression tested against each line. */
  match: z.string().min(1).refine(value => { try { new RegExp(value); return true } catch { return false } }, 'invalid regular expression'),
  /**
   * `done`: the run's work finished successfully; `error`: something failed
   * (the run fails unless a later `done` overrides it, and the monitor raises
   * an incident); `warning`: worth recording (an incident, not pushed by
   * default) without failing the run, e.g. errors the script retries itself;
   * `progress` / `info` are shown only.
   */
  level: z.enum(['info', 'progress', 'done', 'warning', 'error']),
  tag: z.string().optional(),
})
export type LogRule = z.infer<typeof LogRule>

const Duration = z.string().regex(/^\d+(s|m|h)$/, 'a duration like 90s, 8m or 2h')

export const Logs = z.object({
  sources: z.array(LogSource).min(1).default([{ stdout: true, encoding: 'auto' }]),
  rules: z.array(LogRule).default([]),
  /** No new script log line for this long counts as stalled (monitor incident, `recovery` on `stalled`). */
  stallAfter: Duration.optional(),
})
export type Logs = z.infer<typeof Logs>

/**
 * L0 recovery (docs/PLAN.zh.md §5.4): what the monitor does by itself when a
 * rule tag matches, the run stalls, or the run fails. Entries for the same
 * event run in order; `max` limits how often per run chain (a run and its
 * restarts). Anything not handled here is pushed to the user.
 */
/**
 * The game a script plays, so MultiGameAssistant can start it for scripts that
 * do not, and leave it alone for those that do.
 */
export const Game = z.object({
  name: z.string().optional(),
  /** Started in the emulator before `adb` tasks. */
  android: z.object({ package: z.string().regex(/^[A-Za-z][\w]*(\.[A-Za-z_][\w]*)+$/, 'an Android package name like com.example.game') }).optional(),
  /** The PC game for `desktop` tasks: its process name; the program's path is a per-user setting. */
  pc: z.object({
    process: z.string().min(1).optional(),
    /** Names to look for when finding the program (installed programs, shortcuts, folders): the game's, its launcher's. */
    keywords: z.array(z.string().min(2)).optional(),
  }).optional(),
  /**
   * When the script starts the game itself: `always`, `never`, or when any
   * of these config values (the effective config of the run) is set.
   */
  selfLaunch: z.union([
    z.enum(['always', 'never']),
    z.array(z.object({ file: z.string().min(1), path: z.array(z.string().min(1)).min(1), equals: z.union([z.string(), z.number(), z.boolean()]) })).min(1),
  ]).default('never'),
  /** Seconds to give the game after starting it, before the script starts. */
  startupSeconds: z.number().int().min(0).max(600).default(30),
})
export type Game = z.infer<typeof Game>

export const Recovery = z.object({
  /** A log rule tag, `stalled`, or `failed`. */
  on: z.string().min(1),
  /**
   * `reconnect-adb`: reconnect the run's emulator over ADB (starting the
   * instance again if it is down); `restart`: stop the run and start the same
   * task again; `stop`: stop the run.
   */
  do: z.enum(['reconnect-adb', 'restart', 'stop']),
  max: z.number().int().min(1).max(10).default(1),
})
export type Recovery = z.infer<typeof Recovery>

export const ScriptManifest = z.object({
  id: ScriptId,
  name: z.string().min(1),
  description: z.string().optional(),
  family: ScriptFamily.optional(),
  /** Pack schema revision this file was written for. */
  schema: z.literal(1).default(1),
  source: z.object({
    github: z.string().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/).optional(),
    homepage: z.url().optional(),
    release: z.object({
      /** Glob(s) for the release asset to install, tried in order; `{version}` is the tag without a leading `v`. */
      asset: z.union([z.string(), z.array(z.string()).min(1)]).optional(),
      channel: z.enum(['stable', 'prerelease']).default('stable'),
    }).optional(),
    /**
     * The project's resource on Mirror酱 (mirrorchyan.com): with the user's
     * CDK, updates download from there (incremental when possible) instead of GitHub.
     */
    mirrorchyan: z.object({
      rid: z.string().min(1).max(100),
      /** Uploaded per system and architecture (asked with os=windows, arch=x64). */
      platform: z.boolean().default(true),
    }).optional(),
  }).default({}),
  install: z.object({
    requires: z.array(Requirement).default([]),
    /** Path inside the extracted archive to treat as the install root, when the archive nests it. */
    root: z.string().optional(),
  }).default({ requires: [] }),
  config: z.object({ files: z.array(ConfigFile).default([]) }).default({ files: [] }),
  /** How an existing directory is recognized as this script (local import). */
  detect: z.object({
    /** Every listed path must exist, relative to the directory. */
    files: z.array(z.string().min(1)).min(1),
  }).optional(),
  launch: Launch.optional(),
  tasks: z.array(Task).default([]),
  logs: Logs.default({ sources: [{ stdout: true, encoding: 'auto' }], rules: [] }),
  recovery: z.array(Recovery).default([]),
  game: Game.optional(),
  intervention: open.optional(),
  update: open.optional(),
}).superRefine((manifest, issues) => {
  const ids = new Set<string>()
  manifest.tasks.forEach((task, index) => {
    if (ids.has(task.id)) issues.addIssue({ code: 'custom', path: ['tasks', index, 'id'], message: `duplicate task id ${task.id}` })
    ids.add(task.id)
    if (manifest.launch === undefined) issues.addIssue({ code: 'custom', path: ['launch'], message: 'tasks need a launch section' })
  })
  const tags = new Set(['stalled', 'failed', ...manifest.logs.rules.map(r => r.tag ?? r.level)])
  manifest.recovery.forEach((entry, index) => {
    if (!tags.has(entry.on)) issues.addIssue({ code: 'custom', path: ['recovery', index, 'on'], message: `no log rule has tag ${entry.on} (use a rule tag, stalled or failed)` })
  })
})
export type ScriptManifest = z.infer<typeof ScriptManifest>
export type ScriptManifestInput = z.input<typeof ScriptManifest>
