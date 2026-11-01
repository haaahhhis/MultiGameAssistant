/**
 * The GitHub links people paste (to the agent, or into 「从 GitHub 安装」), read
 * into what to install: the repository and the release, file or branch.
 * Pure, for the host and the UI alike.
 */

/** What a pasted link points at. */
export interface GitHubLink {
  /** `owner/repo`. */
  readonly repo: string
  /** A release (`/releases/tag/v1.2`, a download link's tag). */
  readonly tag?: string
  /** A release file (`/releases/download/v1.2/Tool.zip`). */
  readonly asset?: string
  /** A branch (`/tree/dev`, a raw file's branch): install that branch's source. */
  readonly branch?: string
}

/** Paths under a repository that are pages, not a branch name or a release. */
const REPO_PAGES = new Set(['issues', 'pulls', 'wiki', 'actions', 'discussions', 'blob', 'commits', 'commit', 'compare', 'security', 'pulse', 'graphs', 'network', 'settings', 'projects', 'stargazers', 'forks', 'watchers', 'tags', 'branches'])

/**
 * Read the GitHub link someone pasted, in any of its usual forms: the
 * repository (with or without `.git`, `www.`, a query or a fragment), a
 * release page, a release file's download link, a branch, a source archive,
 * a raw file, the API, `git@github.com:owner/repo.git`, a download-mirror
 * prefix in front of any of these (`https://ghproxy.net/https://github.com/…`),
 * or just `owner/repo`.
 * @returns undefined when it is not a GitHub repository.
 */
export function parseGitHubLink(text: string): GitHubLink | undefined {
  const value = text.trim().replace(/^<|>$/g, '')
  const plain = /^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(value)
  if (plain !== null && !value.includes(':')) return { repo: `${plain[1]}/${plain[2]}` }
  const ssh = /git@github\.com:([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/i.exec(value)
  if (ssh !== null) return { repo: `${ssh[1]}/${ssh[2]}` }
  const decode = (s: string) => { try { return decodeURIComponent(s) } catch { return s } }
  // The last GitHub address in it: a download mirror puts its own in front.
  const raw = /raw\.githubusercontent\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)\/([^/?#]+)/i.exec(value)
  if (raw !== null) return { repo: `${raw[1]}/${raw[2]}`, branch: decode(raw[3]!) }
  const apiRepo = /api\.github\.com\/repos\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+)/i.exec(value)
  if (apiRepo !== null) return { repo: `${apiRepo[1]}/${apiRepo[2]}` }
  const at = value.toLowerCase().lastIndexOf('github.com/')
  if (at === -1) return undefined
  const path = value.slice(at + 'github.com/'.length).split(/[?#]/)[0]!.replace(/\/+$/, '')
  const parts = path.split('/')
  if (parts.length < 2 || !/^[A-Za-z0-9_.-]+$/.test(parts[0]!)) return undefined
  const name = parts[1]!.replace(/\.git$/i, '')
  if (!/^[A-Za-z0-9_.-]+$/.test(name)) return undefined
  const repo = `${parts[0]}/${name}`
  const [section, ...rest] = parts.slice(2)
  if (section === 'releases') {
    if (rest[0] === 'tag' && rest[1] !== undefined) return { repo, tag: decode(rest.slice(1).join('/')) }
    if (rest[0] === 'download' && rest.length >= 3) return { repo, tag: decode(rest.slice(1, -1).join('/')), asset: decode(rest.at(-1)!) }
    return { repo }
  }
  // /tree/main/src is a folder on main: the first part is the branch (branch names with a slash are rarer than folder links).
  if (section === 'tree' && rest.length > 0) return { repo, branch: decode(rest[0]!) }
  if (section === 'archive') {
    // /archive/refs/tags/v1.2.zip, /archive/refs/heads/main.zip, /archive/v1.2.zip
    const ref = rest.join('/').replace(/\.(zip|tar\.gz)$/i, '')
    const tag = /^refs\/tags\/(.+)$/.exec(ref)?.[1]
    if (tag !== undefined) return { repo, tag: decode(tag) }
    const head = /^refs\/heads\/(.+)$/.exec(ref)?.[1]
    return head !== undefined ? { repo, branch: decode(head) } : { repo, tag: decode(ref) }
  }
  if (section === undefined || REPO_PAGES.has(section)) return { repo }
  return { repo }
}
