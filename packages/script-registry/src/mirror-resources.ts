/**
 * Which scripts are published on Mirror酱 (mirrorchyan.com), by resource id:
 * a Script Pack says so itself (`source.mirrorchyan`); these are known
 * projects installed straight from their repository without a pack.
 * Checked against Mirror酱's API (a resource uploaded for every platform is
 * asked without os and arch).
 */
import type { MirrorResource } from '@adg/installer'
import type { LoadedPack } from './packs.ts'

const KNOWN: Readonly<Record<string, MirrorResource>> = {
  'maaassistantarknights/maaassistantarknights': { rid: 'MAA', platform: true },
  'maaend/maaend': { rid: 'MaaEnd', platform: true },
  'moesnow/march7thassistant': { rid: 'March7thAssistant', platform: false },
  'maa1999/m9a': { rid: 'M9A', platform: true },
  'babalae/better-genshin-impact': { rid: 'BGI', platform: false },
}

export function mirrorResourceFor(pack: LoadedPack | undefined, repo: string): MirrorResource | undefined {
  return pack?.manifest.source.mirrorchyan ?? KNOWN[repo.toLowerCase()]
}
