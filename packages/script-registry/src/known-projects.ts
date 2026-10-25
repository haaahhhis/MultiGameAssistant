/**
 * Projects MultiGameAssistant knows where to update from without a Script
 * Pack: their GitHub repository and their resource on Mirror酱
 * (mirrorchyan.com), how an imported folder is recognized as one, and where
 * its version is written. A pack says the same for itself
 * (`source.github`, `source.mirrorchyan`, `detect`, `install.version`) and
 * wins over this list.
 *
 * Mirror酱 resources were checked against its API (a resource uploaded for
 * every platform is asked without os and arch).
 */
import { matchesDetect, type MirrorResource, type VersionSpec } from '@adg/installer'
import type { ScriptFamily } from '@adg/protocol'
import type { LoadedPack } from './packs.ts'

export interface KnownProject {
  /** Also the script id it gets when installed or imported. */
  readonly id: string
  readonly name: string
  readonly repo?: string
  readonly mirrorchyan?: MirrorResource
  /** Every listed path must exist in an imported folder. */
  readonly detect?: readonly string[]
  readonly version?: VersionSpec
  readonly family?: ScriptFamily
}

export const KNOWN_PROJECTS: readonly KnownProject[] = [
  { id: 'maa', name: 'MAA（明日方舟）', repo: 'MaaAssistantArknights/MaaAssistantArknights', mirrorchyan: { rid: 'MAA', platform: true } },
  { id: 'maaend', name: 'MaaEnd（终末地）', repo: 'MaaEnd/MaaEnd', mirrorchyan: { rid: 'MaaEnd', platform: true } },
  { id: 'march7th', name: '三月七小助手（星穹铁道）', repo: 'moesnow/March7thAssistant', mirrorchyan: { rid: 'March7thAssistant', platform: false } },
  { id: 'm9a', name: 'M9A（重返未来：1999）', repo: 'MAA1999/M9A', mirrorchyan: { rid: 'M9A', platform: true } },
  {
    id: 'bettergi',
    name: 'BetterGI（原神）',
    repo: 'babalae/better-genshin-impact',
    mirrorchyan: { rid: 'BGI', platform: false },
    detect: ['BetterGI.exe'],
    version: { exe: 'BetterGI.exe' },
    family: 'gui-config',
  },
]

export function knownById(id: string | undefined): KnownProject | undefined {
  return id === undefined ? undefined : KNOWN_PROJECTS.find(p => p.id === id)
}

export function knownByRepo(repo: string | undefined): KnownProject | undefined {
  const lower = repo?.toLowerCase()
  return lower === undefined ? undefined : KNOWN_PROJECTS.find(p => p.repo?.toLowerCase() === lower)
}

export function knownByMirror(rid: string): KnownProject | undefined {
  const lower = rid.toLowerCase()
  return KNOWN_PROJECTS.find(p => p.mirrorchyan?.rid.toLowerCase() === lower)
}

/** The known project an imported folder holds, by its files. */
export async function knownByDir(dir: string): Promise<KnownProject | undefined> {
  for (const project of KNOWN_PROJECTS) {
    if (project.detect !== undefined && await matchesDetect(dir, project.detect)) return project
  }
  return undefined
}

/** Its Mirror酱 resource: what its pack says, else the known project with this repository. */
export function mirrorResourceFor(pack: LoadedPack | undefined, repo: string | undefined): MirrorResource | undefined {
  return pack?.manifest.source.mirrorchyan ?? knownByRepo(repo)?.mirrorchyan
}
