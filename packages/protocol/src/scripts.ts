/**
 * `scripts@1`: the script library — packs, installs from GitHub releases,
 * local imports, side-by-side versions, environment checks.
 * Served by `@adg/script-registry`, not by the gateway itself.
 */
import { z } from 'zod'

export const SCRIPTS_CAPABILITY = 'scripts'

/** How a script is driven (docs/PLAN.zh.md §3.0). */
export const ScriptFamily = z.enum(['maafw-pi', 'cli', 'gui-config', 'generic-process', 'visual'])
export type ScriptFamily = z.infer<typeof ScriptFamily>

/** Script and pack ids: also directory names under the tools directory. */
export const ScriptId = z.string().regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, 'use lowercase letters, digits, dot, dash or underscore (max 64)')

/** `owner/repo` on GitHub. */
export const GitHubRepo = z.string().trim().regex(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/, 'use owner/repo')

export const ScriptSource = z.discriminatedUnion('kind', [
  /** Installed by AutoDailyGamePlay into the tools directory. */
  z.object({ kind: z.literal('github'), repo: z.string() }),
  /** A directory the user already had; used in place, never moved or deleted. */
  z.object({ kind: z.literal('local'), path: z.string() }),
])
export type ScriptSource = z.infer<typeof ScriptSource>

export const ScriptVersion = z.object({
  version: z.string(),
  dir: z.string(),
  installedAt: z.number(),
  asset: z.object({ name: z.string(), size: z.number() }).optional(),
  current: z.boolean(),
})
export type ScriptVersion = z.infer<typeof ScriptVersion>

export const EnvStatus = z.enum(['ok', 'missing', 'outdated', 'unknown', 'unsupported'])
export type EnvStatus = z.infer<typeof EnvStatus>

/** One runtime requirement of a script and what was found on this machine. */
export const EnvItem = z.object({
  /** Requirement kind, e.g. `dotnet-desktop-runtime`, `vcredist`, `adb`, `python`. */
  kind: z.string(),
  label: z.string(),
  /** Version range asked for, e.g. `>=8`. */
  required: z.string().optional(),
  status: EnvStatus,
  /** What was found (version or path). */
  found: z.string().optional(),
  detail: z.string().optional(),
  /** How it can be fixed, when it is not `ok`. */
  fix: z.object({
    /** `auto`: downloaded and set up without prompts; `installer`: runs an official installer (UAC); `manual`: instructions only. */
    kind: z.enum(['auto', 'installer', 'manual']),
    description: z.string(),
    needsAdmin: z.boolean(),
  }).optional(),
})
export type EnvItem = z.infer<typeof EnvItem>

export const EnvReport = z.object({
  checkedAt: z.number(),
  /** True when every item is `ok` (unsupported items do not count against it). */
  ok: z.boolean(),
  items: z.array(EnvItem),
})
export type EnvReport = z.infer<typeof EnvReport>

/** What a quick look at a directory found; the analyzer (M2) goes deeper. */
export const ProjectProbe = z.object({
  /** Executables and launch scripts near the top of the tree, relative paths. */
  executables: z.array(z.string()),
  /** Marker files found, e.g. `interface.json`, `pyproject.toml`, `README.md`. */
  markers: z.array(z.string()),
  /** Best guess at the adapter family from the markers alone. */
  family: ScriptFamily.optional(),
})
export type ProjectProbe = z.infer<typeof ProjectProbe>

export const ScriptInfo = z.object({
  id: z.string(),
  name: z.string(),
  source: ScriptSource,
  /** Script Pack describing it, when one matches. */
  packId: z.string().optional(),
  family: ScriptFamily.optional(),
  /** Current version and its directory; local imports use `local`. */
  current: z.string().optional(),
  dir: z.string().optional(),
  versions: z.array(ScriptVersion),
  env: EnvReport.optional(),
  probe: ProjectProbe.optional(),
  update: z.object({ latest: z.string(), available: z.boolean(), checkedAt: z.number() }).optional(),
  /** Job currently working on this script. */
  jobId: z.string().optional(),
  addedAt: z.number(),
})
export type ScriptInfo = z.infer<typeof ScriptInfo>

/** A Script Pack that can be installed or is already in use. */
export const PackSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  repo: z.string().optional(),
  family: ScriptFamily.optional(),
  /** Shipped with AutoDailyGamePlay (false: in the user's pack directory). */
  builtin: z.boolean(),
  /** A script with this pack is in the library. */
  installed: z.boolean(),
  /** Problems loading the pack, if any; the pack is skipped. */
  error: z.string().optional(),
})
export type PackSummary = z.infer<typeof PackSummary>

export const ReleaseAsset = z.object({ name: z.string(), size: z.number(), downloadUrl: z.string(), digest: z.string().optional() })
export type ReleaseAsset = z.infer<typeof ReleaseAsset>

export const ReleaseInfo = z.object({
  tag: z.string(),
  name: z.string(),
  prerelease: z.boolean(),
  publishedAt: z.string().optional(),
  url: z.string().optional(),
  assets: z.array(ReleaseAsset),
  /** Asset AutoDailyGamePlay would pick for this machine. */
  suggestedAsset: z.string().optional(),
})
export type ReleaseInfo = z.infer<typeof ReleaseInfo>

export const ScriptJobPhase = z.enum(['queued', 'resolving', 'downloading', 'verifying', 'extracting', 'checking', 'running', 'done', 'failed', 'cancelled'])
export type ScriptJobPhase = z.infer<typeof ScriptJobPhase>

export const ScriptJob = z.object({
  id: z.string(),
  kind: z.enum(['install', 'update', 'env-fix']),
  scriptId: z.string(),
  phase: ScriptJobPhase,
  message: z.string().optional(),
  received: z.number().optional(),
  total: z.number().optional(),
  version: z.string().optional(),
  error: z.string().optional(),
  startedAt: z.number(),
  endedAt: z.number().optional(),
})
export type ScriptJob = z.infer<typeof ScriptJob>

export const InstallSettings = z.object({
  /** GitHub REST API base. */
  apiBase: z.url({ protocol: /^https?$/ }),
  /**
   * Prefix put before release download URLs (ghproxy style, e.g.
   * `https://ghfast.top/`); empty downloads directly.
   */
  downloadMirror: z.string().trim().max(300),
  /** Retry directly when the mirror fails. */
  mirrorFallback: z.boolean(),
  /** Credential holding an optional GitHub token (raises the API rate limit). */
  tokenRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
  /** Installed versions kept per script for rollback, including the current one. */
  keepVersions: z.number().int().min(1).max(10),
  /** Offer pre-releases when no stable release exists. */
  includePrereleases: z.boolean(),
})
export type InstallSettings = z.infer<typeof InstallSettings>

const Empty = z.object({})
const ById = z.object({ id: ScriptId })

export const ScriptRequests = {
  /** Library, plus the packs that could be installed. */
  'scripts/list': {
    capability: SCRIPTS_CAPABILITY,
    params: Empty,
    result: z.object({ scripts: z.array(ScriptInfo), packs: z.array(PackSummary), toolsDir: z.string() }),
  },
  'scripts/get': {
    capability: SCRIPTS_CAPABILITY,
    params: ById,
    result: ScriptInfo,
  },
  /** Search GitHub repositories; packs whose repo matches are marked. */
  'scripts/search': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({ query: z.string().trim().min(1).max(200) }),
    result: z.object({ items: z.array(z.object({ repo: z.string(), description: z.string().optional(), stars: z.number(), packId: z.string().optional() })) }),
  },
  /** Recent releases of a repository, newest first, with the suggested asset. */
  'scripts/releases': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({ repo: GitHubRepo, limit: z.number().int().min(1).max(30).optional() }),
    result: z.object({ repo: z.string(), packId: z.string().optional(), releases: z.array(ReleaseInfo) }),
  },
  /** Start installing a release; progress arrives as `scripts/job`. */
  'scripts/install': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({
      repo: GitHubRepo,
      /** Release tag; omitted takes the latest stable (or pre-release, if allowed and none is stable). */
      tag: z.string().min(1).max(200).optional(),
      /** Asset name; omitted takes the suggested one. */
      asset: z.string().min(1).max(300).optional(),
      /** Script id; omitted uses the matching pack's id, else the repo name. */
      id: ScriptId.optional(),
    }),
    result: z.object({ jobId: z.string(), scriptId: z.string() }),
  },
  /** Compare the current version with the latest release. */
  'scripts/checkUpdate': {
    capability: SCRIPTS_CAPABILITY,
    params: ById,
    result: z.object({ current: z.string().optional(), latest: z.string(), available: z.boolean() }),
  },
  /** Install the latest release next to the current one, carrying the pack's config files over. */
  'scripts/update': {
    capability: SCRIPTS_CAPABILITY,
    params: ById,
    result: z.object({ jobId: z.string().optional(), upToDate: z.boolean() }),
  },
  /** Make another installed version current; default: the one before the current. */
  'scripts/rollback': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({ id: ScriptId, version: z.string().optional() }),
    result: ScriptInfo,
  },
  /** Register an existing directory in place. */
  'scripts/import': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({
      path: z.string().trim().min(1).max(1000),
      id: ScriptId.optional(),
      name: z.string().trim().min(1).max(100).optional(),
      /** Pack to describe it with; omitted matches by directory contents. */
      packId: ScriptId.optional(),
    }),
    result: ScriptInfo,
  },
  /**
   * Remove from the library. Installed versions are deleted only with
   * `deleteFiles`; an imported directory is never deleted.
   */
  'scripts/remove': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({ id: ScriptId, deleteFiles: z.boolean().optional() }),
    result: Empty,
  },
  /** Check the script's runtime requirements on this machine. */
  'scripts/envCheck': {
    capability: SCRIPTS_CAPABILITY,
    params: ById,
    result: EnvReport,
  },
  /** Fix one requirement; an `installer` fix shows the system UAC prompt. */
  'scripts/envFix': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({ id: ScriptId, kind: z.string().min(1).max(64) }),
    result: z.object({ jobId: z.string() }),
  },
  'scripts/jobs': {
    capability: SCRIPTS_CAPABILITY,
    params: Empty,
    result: z.object({ items: z.array(ScriptJob) }),
  },
  'scripts/jobs/cancel': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({ jobId: z.string() }),
    result: Empty,
  },
  'scripts/settings': {
    capability: SCRIPTS_CAPABILITY,
    params: Empty,
    result: InstallSettings.extend({ tokenConfigured: z.boolean() }),
  },
  'scripts/settings/set': {
    capability: SCRIPTS_CAPABILITY,
    params: InstallSettings.partial(),
    result: InstallSettings,
  },
} as const

export const ScriptNotifications = {
  /** The library or a script changed; re-read `scripts/list` (or `scripts/get` for `id`). */
  'scripts/changed': z.object({ id: z.string().optional() }),
  /** A job's progress or outcome. */
  'scripts/job': ScriptJob,
} as const
