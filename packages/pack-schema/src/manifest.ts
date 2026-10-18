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
export const TaskParam = z.object({
  type: z.enum(['string', 'integer', 'number', 'boolean']),
  default: z.union([z.string(), z.number(), z.boolean()]).optional(),
  /** Allowed values (for `string` / `integer`). */
  enum: z.array(z.union([z.string(), z.number()])).min(1).optional(),
  description: z.string().optional(),
})
export type TaskParam = z.infer<typeof TaskParam>

/**
 * One config edit made for a run: set `value` at `path` (an array, so keys
 * containing dots stay intact). String values are templates.
 */
export const ConfigPatch = z.object({
  file: RelativePath,
  /** A missing file is skipped with a warning unless required. */
  required: z.boolean().default(false),
  set: z.array(z.object({
    path: z.array(z.union([z.string().min(1), z.number().int().min(0)])).min(1),
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
   * (the run fails unless a later `done` overrides it); `progress` / `info`
   * are shown and kept for the monitor (M3).
   */
  level: z.enum(['info', 'progress', 'done', 'error']),
  tag: z.string().optional(),
})
export type LogRule = z.infer<typeof LogRule>

export const Logs = z.object({
  sources: z.array(LogSource).min(1).default([{ stdout: true, encoding: 'auto' }]),
  rules: z.array(LogRule).default([]),
})
export type Logs = z.infer<typeof Logs>

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
  intervention: open.optional(),
  update: open.optional(),
}).superRefine((manifest, issues) => {
  const ids = new Set<string>()
  manifest.tasks.forEach((task, index) => {
    if (ids.has(task.id)) issues.addIssue({ code: 'custom', path: ['tasks', index, 'id'], message: `duplicate task id ${task.id}` })
    ids.add(task.id)
    if (manifest.launch === undefined) issues.addIssue({ code: 'custom', path: ['launch'], message: 'tasks need a launch section' })
  })
})
export type ScriptManifest = z.infer<typeof ScriptManifest>
export type ScriptManifestInput = z.input<typeof ScriptManifest>
