/**
 * @adg/installer — installing scripts, without any Cordis or UI coupling.
 *
 * The script registry plugin owns state and policy (which repo, where, when
 * to ask the user); this library does the mechanics: talk to GitHub, fetch
 * and verify files, unpack them safely, check and fix runtime requirements,
 * and take a first look at a directory.
 */
export { GitHubClient, GitHubError, type GitHubOptions } from './github.ts'
export { download, DownloadError, hashFile, mirrored, type DownloadOptions, type DownloadResult } from './download.ts'
export { archiveKind, extract, type ArchiveKind, type ExtractResult } from './extract.ts'
export { checkEnvironment, compareVersions, satisfies, systemHost, type EnvContext, type EnvHost, type ExecResult, type FixPlan } from './env.ts'
export { applyFix, ManualFixError, runElevated, type FixDeps } from './fix.ts'
export { matchesDetect, probeProject } from './probe.ts'
