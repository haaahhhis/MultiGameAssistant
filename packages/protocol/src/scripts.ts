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

/** A resource id on Mirror酱, e.g. `MAA`, `BGI`. */
export const MirrorRid = z.string().trim().regex(/^[A-Za-z0-9_.-]{1,100}$/, 'use the resource id, e.g. MAA or BGI')

export const ScriptSource = z.discriminatedUnion('kind', [
  /** Installed by MultiGameAssistant into the tools directory. */
  z.object({ kind: z.literal('github'), repo: z.string() }),
  /** Installed into the tools directory from Mirror酱 (`platform`: asked with os and arch; `os` / `arch` each on its own). */
  z.object({ kind: z.literal('mirrorchyan'), rid: z.string(), platform: z.boolean(), os: z.boolean().optional(), arch: z.boolean().optional() }),
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

/** Where an update channel came from: how it was installed, its pack, MultiGameAssistant's list of known projects, or the user. */
export const ChannelFrom = z.enum(['install', 'pack', 'known', 'user'])
export type ChannelFrom = z.infer<typeof ChannelFrom>

/**
 * Where a script's updates can come from, each on its own: with a Mirror酱
 * CDK Mirror酱 is used first, else GitHub; a script only on Mirror酱 can be
 * checked without a CDK but needs one to download.
 */
export const UpdateChannels = z.object({
  github: z.object({ repo: z.string(), from: ChannelFrom }).optional(),
  mirrorchyan: z.object({ rid: z.string(), from: ChannelFrom }).optional(),
})
export type UpdateChannels = z.infer<typeof UpdateChannels>

/** Which version an imported directory holds, and where that was read (`interface.json`, `MAA.exe 的文件属性`, `更新`…). */
export const LocalVersion = z.object({ version: z.string(), from: z.string() })
export type LocalVersion = z.infer<typeof LocalVersion>

/** What the agent wrote about a script (what it is, which game, what it does), on the user's request. */
export const ScriptSummary = z.object({
  state: z.enum(['running', 'done', 'failed']),
  at: z.number(),
  /** The summary; on failure, why. */
  text: z.string().optional(),
  /** The agent session that wrote it. */
  sessionId: z.string().optional(),
})
export type ScriptSummary = z.infer<typeof ScriptSummary>

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
  /** Where its updates come from. */
  channels: UpdateChannels,
  /** The entry of the known-project list it was recognized as (no pack describes it). */
  known: z.string().optional(),
  /** The version found in a local import's directory; absent when it could not be read. */
  localVersion: LocalVersion.optional(),
  /** The last in-place update of a local import, which can be undone. */
  undo: z.object({ from: z.string().optional(), to: z.string(), at: z.number() }).optional(),
  /** Job currently working on this script. */
  jobId: z.string().optional(),
  addedAt: z.number(),
  summary: ScriptSummary.optional(),
})
export type ScriptInfo = z.infer<typeof ScriptInfo>

/** A Script Pack that can be installed or is already in use. */
export const PackSummary = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string().optional(),
  repo: z.string().optional(),
  /** Its resource id on Mirror酱, when it is published there. */
  mirrorchyan: z.string().optional(),
  family: ScriptFamily.optional(),
  /** Shipped with MultiGameAssistant (false: in the user's pack directory). */
  builtin: z.boolean(),
  /** A script with this pack is in the library. */
  installed: z.boolean(),
  /** Problems loading the pack, if any; the pack is skipped. */
  error: z.string().optional(),
})
export type PackSummary = z.infer<typeof PackSummary>

/** What Mirror酱 says about a resource (no CDK needed). */
export const MirrorLookup = z.object({
  rid: z.string(),
  version: z.string(),
  platform: z.boolean(),
  os: z.boolean().optional(),
  arch: z.boolean().optional(),
  name: z.string().optional(),
  description: z.string().optional(),
  repo: z.string().optional(),
})
export type MirrorLookup = z.infer<typeof MirrorLookup>

export const MirrorSearchItem = z.object({
  rid: z.string(),
  name: z.string(),
  description: z.string(),
  repo: z.string().optional(),
  url: z.string().optional(),
  /** A script with this resource is in the library. */
  installed: z.boolean(),
  /** A pack or MultiGameAssistant's list knows it (curated). */
  known: z.boolean(),
})
export type MirrorSearchItem = z.infer<typeof MirrorSearchItem>

/** A project MultiGameAssistant knows where to update from without a pack. */
export const KnownProjectSummary = z.object({
  id: z.string(),
  name: z.string(),
  repo: z.string().optional(),
  mirrorchyan: z.string().optional(),
  /** A script with this project is in the library. */
  installed: z.boolean(),
})
export type KnownProjectSummary = z.infer<typeof KnownProjectSummary>

export const ReleaseAsset = z.object({ name: z.string(), size: z.number(), downloadUrl: z.string(), digest: z.string().optional() })
export type ReleaseAsset = z.infer<typeof ReleaseAsset>

export const ReleaseInfo = z.object({
  tag: z.string(),
  name: z.string(),
  prerelease: z.boolean(),
  publishedAt: z.string().optional(),
  url: z.string().optional(),
  assets: z.array(ReleaseAsset),
  /** Asset MultiGameAssistant would pick for this machine. */
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
  /** Credential holding the user's Mirror酱 CDK: scripts published there update from it (incremental when possible). */
  cdkRef: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
})
export type InstallSettings = z.infer<typeof InstallSettings>

const Empty = z.object({})
const ById = z.object({ id: ScriptId })

export const ScriptRequests = {
  /** Library, plus the packs that could be installed. */
  'scripts/list': {
    capability: SCRIPTS_CAPABILITY,
    params: Empty,
    result: z.object({ scripts: z.array(ScriptInfo), packs: z.array(PackSummary), known: z.array(KnownProjectSummary), toolsDir: z.string() }),
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
  /**
   * Start installing a release from GitHub (`repo`) or Mirror酱
   * (`mirrorchyan`, needs a CDK); progress arrives as `scripts/job`.
   */
  'scripts/install': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({
      repo: GitHubRepo.optional(),
      /** A Mirror酱 resource id, instead of `repo`; tag and asset do not apply. */
      mirrorchyan: MirrorRid.optional(),
      /** Release tag; omitted takes the latest stable (or pre-release, if allowed and none is stable). */
      tag: z.string().min(1).max(200).optional(),
      /** Asset name; omitted takes the suggested one. */
      asset: z.string().min(1).max(300).optional(),
      /** Script id; omitted uses the matching pack's id, else the repo name. */
      id: ScriptId.optional(),
    }).refine(p => (p.repo === undefined) !== (p.mirrorchyan === undefined), 'give either repo or mirrorchyan'),
    result: z.object({ jobId: z.string(), scriptId: z.string() }),
  },
  /**
   * Compare the current version with the latest release (Mirror酱 with a CDK,
   * else GitHub). A local import is compared by the version found in its
   * directory, against its update source.
   */
  'scripts/checkUpdate': {
    capability: SCRIPTS_CAPABILITY,
    params: ById,
    result: z.object({ current: z.string().optional(), latest: z.string(), available: z.boolean() }),
  },
  /**
   * Install the latest release next to the current one, carrying the pack's
   * config files over. A local import is updated in its own directory: the
   * files it replaces or removes are backed up first (`scripts/restore`
   * puts them back) and the pack's existing config files are left alone.
   */
  'scripts/update': {
    capability: SCRIPTS_CAPABILITY,
    params: ById,
    result: z.object({ jobId: z.string().optional(), upToDate: z.boolean() }),
  },
  /**
   * Set a script's update channels: a value sets it, `null` turns it off,
   * omitted leaves it, `reset` goes back to the automatic one (its pack's,
   * or the known project's). A script installed from GitHub keeps its
   * repository; one installed from Mirror酱 keeps its resource.
   */
  'scripts/source/set': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({
      id: ScriptId,
      repo: GitHubRepo.nullable().optional(),
      mirrorchyan: MirrorRid.nullable().optional(),
      reset: z.array(z.enum(['repo', 'mirrorchyan'])).optional(),
    }),
    result: ScriptInfo,
  },
  /**
   * Whether a library script is on Mirror酱 (no CDK needed): the projects
   * whose GitHub repository is its repository, else whose name matches.
   */
  'scripts/mirrorchyan/match': {
    capability: SCRIPTS_CAPABILITY,
    params: ById,
    result: z.object({ items: z.array(MirrorSearchItem.extend({ by: z.enum(['repo', 'name']) })), from: z.enum(['mirrorchyan', 'builtin']) }),
  },
  /** Whether Mirror酱 has a resource, and its latest version (no CDK needed). */
  'scripts/mirrorchyan/lookup': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({ rid: MirrorRid }),
    result: MirrorLookup,
  },
  /**
   * Search Mirror酱's projects by name, game or id (its project list, read
   * at most once a day; MultiGameAssistant's own list when it cannot be read).
   * Only tools with a Windows build Mirror酱 hands out.
   */
  'scripts/mirrorchyan/search': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({ query: z.string().trim().max(100) }),
    result: z.object({
      items: z.array(MirrorSearchItem),
      /** `mirrorchyan`: its list, fresh or from today's cache; `builtin`: it could not be read. */
      from: z.enum(['mirrorchyan', 'builtin']),
      fetchedAt: z.number().optional(),
    }),
  },
  /** Undo a local import's last in-place update: the old files back, the new ones removed. */
  'scripts/restore': {
    capability: SCRIPTS_CAPABILITY,
    params: ById,
    result: ScriptInfo,
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
  /** Have the agent sum up what the script is (its README, files, pack); the summary lands in `summary`. */
  'scripts/summarize': {
    capability: SCRIPTS_CAPABILITY,
    params: z.object({ id: ScriptId }),
    result: z.object({ sessionId: z.string() }),
  },
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
    result: InstallSettings.extend({ tokenConfigured: z.boolean(), cdkConfigured: z.boolean() }),
  },
  /** Try the Mirror酱 CDK: whether it works, and until when. */
  'scripts/mirrorchyan/check': {
    capability: SCRIPTS_CAPABILITY,
    params: Empty,
    result: z.object({ ok: z.boolean(), message: z.string(), expiresAt: z.number().optional() }),
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
