/**
 * Updates from the project's GitHub Releases (.github/workflows/release.yml
 * publishes the installers there). The installed app looks for a newer release
 * when it starts and every few hours: a stable version is offered stable
 * releases only, a pre-release (1.0.0-rc.3) newer pre-releases too. The
 * installer for this architecture is downloaded and checked against the
 * SHA-256 GitHub computed when it was uploaded (the asset's digest);
 * 「退出并安装」 then runs it quietly over the install (it finds the folder the
 * user chose, the data stays) and it starts the new version.
 */
import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { Readable, Transform } from 'node:stream'
import { pipeline } from 'node:stream/promises'

export const REPOSITORY = 'haaahhhis/MultiGameAssistant'
/** The first look after starting waits a little, so it does not slow the start down. */
const FIRST_CHECK_MS = 30_000
const CHECK_EVERY_MS = 6 * 60 * 60_000

/** Compare two versions by semantic versioning: a pre-release sorts before its release. @returns -1, 0 or 1. */
export function compareVersions(a, b) {
  const parse = v => {
    const [main = '', pre] = String(v).replace(/^v/, '').split('+')[0].split(/-(.*)/s)
    return { main: main.split('.').map(n => Number.parseInt(n, 10) || 0), pre: pre === undefined || pre === '' ? [] : pre.split('.') }
  }
  const x = parse(a)
  const y = parse(b)
  for (let i = 0; i < Math.max(x.main.length, y.main.length, 3); i++) {
    const d = (x.main[i] ?? 0) - (y.main[i] ?? 0)
    if (d !== 0) return Math.sign(d)
  }
  if (x.pre.length === 0 || y.pre.length === 0) return Math.sign(y.pre.length - x.pre.length)
  for (let i = 0; i < Math.max(x.pre.length, y.pre.length); i++) {
    const p = x.pre[i]
    const q = y.pre[i]
    if (p === undefined || q === undefined) return p === undefined ? -1 : 1
    const pn = /^\d+$/.test(p)
    const qn = /^\d+$/.test(q)
    if (pn && qn && Number(p) !== Number(q)) return Math.sign(Number(p) - Number(q))
    if (pn !== qn) return pn ? -1 : 1
    if (!pn && p !== q) return p < q ? -1 : 1
  }
  return 0
}

/** The installer of `release` for `arch` (x64: no suffix; arm64: `-arm64`), as the release workflow names it. */
export function installerAsset(release, arch) {
  const version = String(release.tag_name).replace(/^v/, '')
  const name = `MultiGameAssistant-Setup-${version}${arch === 'x64' ? '' : `-${arch}`}.exe`
  return release.assets?.find(a => a.name === name)
}

/** The installer's SHA-256 as GitHub gives it (`digest: "sha256:…"`), lowercase; undefined without one. */
export function assetSha256(asset) {
  const m = /^sha256:([0-9a-f]{64})$/i.exec(String(asset?.digest ?? ''))
  return m === null ? undefined : m[1].toLowerCase()
}

/**
 * The newest release to offer over `current`, from GitHub's list: with an
 * installer for `arch` that has its SHA-256; pre-releases only to a pre-release.
 */
export function pickRelease(releases, current, arch) {
  const pre = /-/.test(current)
  return releases
    .filter(r => r.draft !== true && (pre || r.prerelease !== true))
    .map(r => ({ release: r, version: String(r.tag_name).replace(/^v/, '') }))
    .filter(c => compareVersions(c.version, current) > 0 && assetSha256(installerAsset(c.release, arch)) !== undefined)
    .sort((a, b) => compareVersions(b.version, a.version))[0]
}

async function sha256(file) {
  const hash = createHash('sha256')
  await pipeline(createReadStream(file), hash)
  return hash.digest('hex')
}

/**
 * @param {object} options
 * @param {string} options.current - this app's version (installed.json).
 * @param {string} options.arch - x64 or arm64.
 * @param {string} options.dir - where installers are downloaded (and the settings file kept).
 * @param {(state: object) => void} options.onChange - every change of the state, for the window.
 * @param {(version: string) => void} [options.onFound] - an automatic check found a version not skipped (once per version).
 * @param {string} [options.api] - the releases list (tests point it at a fake).
 * @param {typeof fetch} [options.fetch]
 * @param {{ info(m: string): void; warn(m: string): void }} [options.log]
 */
export function createUpdater({ current, arch, dir, onChange, onFound = () => {}, api = `https://api.github.com/repos/${REPOSITORY}/releases?per_page=30`, fetch = globalThis.fetch, log = { info() {}, warn() {} } }) {
  const settingsFile = join(dir, 'update.json')
  const settings = (() => {
    try { return { auto: true, ...JSON.parse(readFileSync(settingsFile, 'utf8')) } } catch { return { auto: true } }
  })()
  const saveSettings = () => {
    try {
      mkdirSync(dir, { recursive: true })
      writeFileSync(settingsFile, JSON.stringify({ auto: settings.auto, ...(settings.skipped === undefined ? {} : { skipped: settings.skipped }) }))
    } catch (error) { log.warn(`update settings not saved: ${error instanceof Error ? error.message : String(error)}`) }
  }
  /** @type {{ release: any, version: string } | undefined} */
  let found
  const state = { current, arch, auto: settings.auto !== false, skipped: settings.skipped, checking: false }
  const announced = new Set()
  const changed = () => onChange(snapshot())
  const snapshot = () => ({ ...state, ...(state.download === undefined ? {} : { download: { ...state.download } }) })

  async function check({ automatic = false } = {}) {
    if (state.checking) return snapshot()
    state.checking = true
    changed()
    try {
      const response = await fetch(api, { headers: { accept: 'application/vnd.github+json', 'user-agent': 'MultiGameAssistant' }, signal: AbortSignal.timeout(20_000) })
      if (response.status === 404) throw new Error('找不到发布：仓库可能还是私有的')
      if (response.status === 403 || response.status === 429) throw new Error('GitHub 暂时不让查了（查得太频繁），过一会儿再试')
      if (!response.ok) throw new Error(`GitHub 返回 ${response.status}`)
      const pick = pickRelease(await response.json(), current, arch)
      if (pick?.version !== found?.version) delete state.download
      found = pick
      state.latest = pick === undefined ? undefined : {
        version: pick.version,
        prerelease: pick.release.prerelease === true,
        notesUrl: pick.release.html_url,
        publishedAt: pick.release.published_at,
        size: installerAsset(pick.release, arch).size,
      }
      delete state.error
      if (pick !== undefined && automatic && pick.version !== settings.skipped && !announced.has(pick.version)) {
        announced.add(pick.version)
        onFound(pick.version)
      }
    } catch (error) {
      state.error = error instanceof Error && error.name !== 'TimeoutError' && error.name !== 'TypeError' ? error.message : `连不上 GitHub：${error instanceof Error ? error.message : String(error)}`
      log.warn(`update check: ${state.error}`)
    } finally {
      state.checking = false
      state.checkedAt = Date.now()
      changed()
    }
    return snapshot()
  }

  /** Download the found version's installer and check it against its SHA-256. */
  async function download() {
    if (found === undefined) throw new Error('没有可以更新的版本')
    if (state.download?.state === 'downloading' || state.download?.state === 'ready') return snapshot()
    const { release, version } = found
    const asset = installerAsset(release, arch)
    const file = join(dir, asset.name)
    state.download = { version, state: 'downloading', received: 0, total: asset.size }
    changed()
    try {
      mkdirSync(dir, { recursive: true })
      // Installers of other versions are not needed any more.
      for (const name of readdirSync(dir)) if (name.endsWith('.exe') || name.endsWith('.part')) if (name !== asset.name) rmSync(join(dir, name), { force: true })
      const expected = assetSha256(asset)
      if (!(existsSync(file) && await sha256(file) === expected)) {
        const response = await fetch(asset.browser_download_url, { headers: { 'user-agent': 'MultiGameAssistant' } })
        if (!response.ok || response.body === null) throw new Error(`下载安装包失败（${response.status}）`)
        let last = 0
        const count = new Transform({
          transform(chunk, _encoding, done) {
            state.download.received += chunk.length
            if (Date.now() - last > 300) { last = Date.now(); changed() }
            done(null, chunk)
          },
        })
        await pipeline(Readable.fromWeb(response.body), count, createWriteStream(`${file}.part`))
        if (await sha256(`${file}.part`) !== expected) {
          rmSync(`${file}.part`, { force: true })
          throw new Error('下载的安装包和发布的 SHA-256 不一致，已删除；请重试')
        }
        renameSync(`${file}.part`, file)
      }
      state.download = { version, state: 'ready', received: asset.size, total: asset.size, file }
      log.info(`update ${version} downloaded and verified: ${file}`)
    } catch (error) {
      state.download = { ...state.download, state: 'failed', error: error instanceof Error ? error.message : String(error) }
      log.warn(`update download: ${state.download.error}`)
    }
    changed()
    return snapshot()
  }

  /** The verified installer and how to run it over the install, quietly, starting the new version after. */
  function installCommand() {
    if (state.download?.state !== 'ready' || !existsSync(state.download.file)) throw new Error('安装包还没有下载好')
    return { file: state.download.file, args: ['/S', '--updated', '--force-run'] }
  }

  return {
    state: snapshot,
    check,
    download,
    installCommand,
    skip(version) {
      settings.skipped = version
      state.skipped = version
      saveSettings()
      changed()
      return snapshot()
    },
    setAuto(auto) {
      settings.auto = auto
      state.auto = auto
      saveSettings()
      changed()
      return snapshot()
    },
    /** Check on a timer while automatic checks are on. @returns the disposer. */
    start() {
      const tick = () => { if (state.auto) void check({ automatic: true }) }
      const first = setTimeout(tick, FIRST_CHECK_MS)
      const every = setInterval(tick, CHECK_EVERY_MS)
      return () => { clearTimeout(first); clearInterval(every) }
    },
  }
}
