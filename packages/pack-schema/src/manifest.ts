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
  launch: open.optional(),
  tasks: z.array(open).optional(),
  logs: open.optional(),
  intervention: open.optional(),
  update: open.optional(),
})
export type ScriptManifest = z.infer<typeof ScriptManifest>
export type ScriptManifestInput = z.input<typeof ScriptManifest>
