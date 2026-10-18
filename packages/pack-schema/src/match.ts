/**
 * Name matching shared by the installer and the UI: release asset globs,
 * template expansion, and the asset heuristic used when a pack names none.
 */

/** `*` matches any run of characters, `?` one character; case-insensitive, whole name. */
export function globToRegExp(glob: string): RegExp {
  const body = [...glob].map(c => (c === '*' ? '.*' : c === '?' ? '.' : c.replace(/[.+^${}()|[\]\\]/g, '\\$&'))).join('')
  return new RegExp(`^${body}$`, 'i')
}

/**
 * Replace `{name}` placeholders.
 * @throws Error naming an unknown placeholder, so a typo fails loudly.
 */
export function expand(template: string, vars: Readonly<Record<string, string>>): string {
  return template.replace(/\{([A-Za-z][A-Za-z0-9.]*)\}/g, (_, name: string) => {
    const value = vars[name]
    if (value === undefined) throw new Error(`unknown placeholder {${name}} in "${template}"`)
    return value
  })
}

/** Tag → version: `v6.19.0` → `6.19.0`; other tags unchanged. */
export function versionOfTag(tag: string): string {
  return /^v\d/.test(tag) ? tag.slice(1) : tag
}

export interface AssetChoice<A extends { readonly name: string }> {
  /** The asset to install, or undefined when nothing fits. */
  readonly asset: A | undefined
  /** Why it was chosen (or why none was), for the UI and the agent. */
  readonly reason: string
}

/**
 * Pick the release asset for this machine (Windows x64 unless told otherwise).
 *
 * With pack globs, the first glob that matches wins. Without, assets are
 * scored: archives and executables for the platform and architecture rank
 * up; source archives, checksums, symbols, other platforms and other
 * architectures are excluded.
 */
export function chooseAsset<A extends { readonly name: string; readonly size?: number }>(
  assets: readonly A[],
  options: { readonly globs?: readonly string[]; readonly tag?: string; readonly platform?: 'win' | 'linux' | 'mac'; readonly arch?: 'x64' | 'arm64' } = {},
): AssetChoice<A> {
  if (assets.length === 0) return { asset: undefined, reason: '这个发布没有可下载的文件' }
  if (options.globs !== undefined && options.globs.length > 0) {
    const vars = { version: versionOfTag(options.tag ?? ''), tag: options.tag ?? '' }
    for (const glob of options.globs) {
      const pattern = globToRegExp(expand(glob, vars))
      const hit = assets.find(a => pattern.test(a.name))
      if (hit !== undefined) return { asset: hit, reason: `匹配脚本包规则 ${glob}` }
    }
    return { asset: undefined, reason: `没有文件匹配脚本包规则：${options.globs.join('、')}` }
  }

  const platform = options.platform ?? 'win'
  const arch = options.arch ?? 'x64'
  const scored = assets
    .map(asset => ({ asset, score: scoreAsset(asset.name, platform, arch) }))
    .filter(entry => entry.score > Number.NEGATIVE_INFINITY)
    .sort((a, b) => b.score - a.score || (b.asset.size ?? 0) - (a.asset.size ?? 0))
  const best = scored[0]
  if (best === undefined || best.score <= 0) return { asset: undefined, reason: '没有适合本机（Windows x64）的文件，请手动选择' }
  return { asset: best.asset, reason: `按文件名判断适合 ${platform}-${arch}` }
}

const OTHER_PLATFORM: Record<string, RegExp> = {
  win: /(linux|ubuntu|debian|macos|darwin|osx|\.dmg$|\.pkg$|\.appimage$|\.deb$|\.rpm$|android|\.apk$|ios)/i,
  linux: /(win(dows)?(?![a-z])|win32|win64|\.exe$|\.msi$|macos|darwin|osx|\.dmg$)/i,
  mac: /(win(dows)?(?![a-z])|win32|win64|\.exe$|\.msi$|linux|\.appimage$|\.deb$)/i,
}
const PLATFORM: Record<string, RegExp> = { win: /(win(dows)?(?![a-z])|win32|win64|\.exe$|\.msi$)/i, linux: /linux/i, mac: /(mac|darwin|osx)/i }
const OTHER_ARCH: Record<string, RegExp> = { x64: /(arm64|aarch64|(?<![a-z0-9])arm(?![a-z])|x86(?!_64)|i[3-6]86|win32(?![a-z]))/i, arm64: /(x64|x86_64|amd64|x86|i[3-6]86)/i }
const ARCH: Record<string, RegExp> = { x64: /(x64|x86_64|amd64|win64)/i, arm64: /(arm64|aarch64)/i }

function scoreAsset(name: string, platform: string, arch: string): number {
  const lower = name.toLowerCase()
  if (/(\.sha\d+|\.md5|\.sig|\.asc|\.sum|checksums?|\.txt$|\.json$|\.pdb|symbols?|debug|\.blockmap$)/.test(lower)) return Number.NEGATIVE_INFINITY
  if (/(^source|src\.|-src|_src|sources?\.(zip|tar))/.test(lower)) return Number.NEGATIVE_INFINITY
  if (OTHER_PLATFORM[platform]!.test(lower)) return Number.NEGATIVE_INFINITY
  let score = 0
  if (/\.(zip|7z)$/.test(lower)) score += 3
  else if (/\.(tar\.gz|tgz|tar\.xz|tar\.zst)$/.test(lower)) score += platform === 'win' ? 1 : 3
  else if (/\.(exe|msi)$/.test(lower)) score += 2
  else return Number.NEGATIVE_INFINITY
  if (PLATFORM[platform]!.test(lower)) score += 3
  if (ARCH[arch]!.test(lower)) score += 2
  else if (OTHER_ARCH[arch]!.test(lower)) return Number.NEGATIVE_INFINITY
  // Updater-only packages and installers that need a network bootstrap rank down.
  if (/(update|patch|delta|ota|lite)/.test(lower)) score -= 2
  if (/(full|portable|standalone)/.test(lower)) score += 1
  return score
}
