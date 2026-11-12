/**
 * A newer release on GitHub: the installed desktop app's (apps/desktop/updates.mjs,
 * which also installs it) or the dsh plugin package's (about/checkUpdate, which
 * says how to update it in dsh). Both carry each newer release's notes, its
 * GitHub Release text. They show as:
 *
 * - 「更新」 in the rail, above 定时, while there is a version to update to;
 *   it opens the notes dialog (`UpdateNotesHost`), with what to do;
 * - the card in the floating dock (desktop), with the highlights;
 * - 「设置 → 关于」, which shares the actions and the notes.
 *
 * The desktop app checks by itself after starting and every few hours; the
 * plugin package is checked from here on the same schedule. In a browser on a
 * desktop app's agent service, or run from the repository, nothing.
 */
import { useEffect, useState, useSyncExternalStore, type ReactNode } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ReleaseNote, RequestResult } from '@adg/protocol'
import { desktop, type UpdateState, type UpdatesBridge } from '../desktop.ts'
import { useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'
import { Markdown } from './Markdown.tsx'

/** 「稍后」 hides the card until the app starts again. */
const LATER_KEY = 'adg.update.later'
/** The plugin package is checked as often as the desktop app checks itself. */
const PLUGIN_CHECK_EVERY_MS = 6 * 60 * 60_000
const RELEASES = 'https://github.com/haaahhhis/MultiGameAssistant/releases'
export const PLUGIN_NAME = 'dsh-multigameassistant'

/** @returns undefined while loading, null when this build does not update itself. */
export function useUpdates(): { bridge: UpdatesBridge | undefined; state: UpdateState | null | undefined } {
  const bridge = desktop()?.updates
  const [state, setState] = useState<UpdateState | null | undefined>(bridge === undefined ? null : undefined)
  useEffect(() => {
    if (bridge === undefined) return
    let live = true
    bridge.state().then(s => { if (live) setState(s) }, () => { if (live) setState(null) })
    const off = bridge.onChange(s => { if (live) setState(s) })
    return () => { live = false; off() }
  }, [bridge])
  return { bridge, state }
}

// ---------------------------------------------------------------- the plugin package

export type PluginCheck = { checking: boolean; result?: RequestResult<'about/checkUpdate'>; error?: string }

interface PluginUpdates {
  get(): PluginCheck
  subscribe(listener: () => void): () => void
  check(): void
  /** Check now and every few hours while something wants it. @returns how to stop wanting it. */
  watch(): () => void
}

const pluginStores = new WeakMap<AdgClient, PluginUpdates>()

/** One check state per connection, shared by the rail, the dialog and 「设置 → 关于」. */
function pluginUpdates(client: AdgClient): PluginUpdates {
  let store = pluginStores.get(client)
  if (store !== undefined) return store
  let state: PluginCheck = { checking: false }
  const listeners = new Set<() => void>()
  const set = (next: PluginCheck) => { state = next; for (const l of listeners) l() }
  let watchers = 0
  let timer: ReturnType<typeof setInterval> | undefined
  const check = () => {
    if (state.checking) return
    set({ ...state, checking: true })
    client.connection.call('about/checkUpdate', {}).then(
      result => set({ checking: false, result }),
      e => set({ checking: false, ...(state.result === undefined ? {} : { result: state.result }), error: e instanceof Error ? e.message : String(e) }),
    )
  }
  store = {
    get: () => state,
    subscribe(listener) { listeners.add(listener); return () => { listeners.delete(listener) } },
    check,
    watch() {
      if (watchers++ === 0) {
        if (state.result === undefined && !state.checking) check()
        timer = setInterval(check, PLUGIN_CHECK_EVERY_MS)
      }
      return () => { if (--watchers === 0 && timer !== undefined) { clearInterval(timer); timer = undefined } }
    },
  }
  pluginStores.set(client, store)
  return store
}

/** Is this the dsh plugin package (about/info)? undefined while asking; false for anything else. */
export function usePluginEdition(client: AdgClient): { version: string } | false | undefined {
  const capabilities = useStore(client.capabilities)
  const status = useStore(client.connection.status)
  const has = capabilities.has('about')
  const [about, setAbout] = useState<RequestResult<'about/info'> | null | undefined>(undefined)
  useEffect(() => {
    if (status.state !== 'open') return
    if (!has) { setAbout(null); return }
    let live = true
    client.connection.call('about/info', {}).then(a => { if (live) setAbout(a) }, () => { if (live) setAbout(null) })
    return () => { live = false }
  }, [client, has, status.state])
  if (about === undefined) return undefined
  return about?.edition === 'plugin' && about.version !== undefined ? { version: about.version } : false
}

/** The plugin package's check: started (and repeated) while mounted with `enabled`. */
export function usePluginUpdates(client: AdgClient, enabled: boolean): PluginCheck & { check: () => void } {
  const store = pluginUpdates(client)
  const state = useSyncExternalStore(store.subscribe, store.get)
  useEffect(() => (enabled ? store.watch() : undefined), [store, enabled])
  return { ...state, check: store.check }
}

// ---------------------------------------------------------------- either one

/** A version to update to, from whichever this build is. */
export type AppUpdate =
  | { kind: 'desktop'; current: string; version: string; prerelease: boolean; notesUrl: string; notes: readonly ReleaseNote[]; bridge: UpdatesBridge; state: UpdateState }
  | { kind: 'plugin'; current: string; version: string; prerelease: boolean; notesUrl: string; notes: readonly ReleaseNote[]; onNpm?: boolean }

/** The version to update to; null when there is none (or it was skipped). */
export function useAppUpdate(client: AdgClient): AppUpdate | null {
  const { bridge, state } = useUpdates()
  const edition = usePluginEdition(client)
  const plugin = usePluginUpdates(client, bridge === undefined && edition !== false && edition !== undefined)
  if (bridge !== undefined) {
    const latest = state?.latest
    if (state == null || latest === undefined || latest.version === state.skipped) return null
    return { kind: 'desktop', current: state.current, version: latest.version, prerelease: latest.prerelease, notesUrl: latest.notesUrl, notes: latest.notes ?? [], bridge, state }
  }
  const latest = plugin.result?.latest
  if (edition === false || edition === undefined || latest === undefined || plugin.result === undefined) return null
  return { kind: 'plugin', current: plugin.result.current, version: latest.version, prerelease: latest.prerelease, notesUrl: latest.notesUrl || RELEASES, notes: latest.notes ?? [], ...(latest.onNpm === undefined ? {} : { onNpm: latest.onNpm }) }
}

// ---------------------------------------------------------------- the notes

/**
 * The first few points of the newest notes, as plain text: each list item's
 * bold lead (「**复制、粘贴、撤销**：…」 → 复制、粘贴、撤销), or its words.
 */
export function highlights(notes: readonly ReleaseNote[], count = 3): string[] {
  const body = notes[0]?.body ?? ''
  const out: string[] = []
  for (const raw of body.split('\n')) {
    const item = /^\s*[-*]\s+(.+)$/.exec(raw)?.[1]
    if (item === undefined) continue
    const lead = /^\*\*(.+?)\*\*/.exec(item)?.[1]
    const text = (lead ?? item).replace(/\*\*|`|\[([^\]]*)\]\([^)]*\)/g, (_m, label: string | undefined) => label ?? '').replace(/[：:。]\s*$/, '').trim()
    if (text !== '' && !out.includes(text)) out.push(text.length > 40 ? `${text.slice(0, 40)}…` : text)
    if (out.length >= count) break
  }
  return out
}

function noteDate(iso: string | undefined): string {
  if (iso === undefined) return ''
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

/** Each release's notes, newest first. */
export function ReleaseNotes({ notes, notesUrl }: { notes: readonly ReleaseNote[]; notesUrl: string }) {
  if (notes.length === 0) {
    return <p className="muted small">发布页没有写这次的更新说明。<a href={notesUrl} target="_blank" rel="noreferrer">在 GitHub 上看</a></p>
  }
  return (
    <div className="release-notes">
      {notes.map(note => (
        <section key={note.version} className="release-note">
          <div className="release-note-head">
            <strong>{note.title !== undefined && note.title !== `v${note.version}` ? note.title : `版本 ${note.version}`}</strong>
            <span className="muted small">{noteDate(note.publishedAt)}</span>
            {note.url !== '' && <a className="small" href={note.url} target="_blank" rel="noreferrer">发布页</a>}
          </div>
          {note.body === '' ? <p className="muted small">这个版本没有写更新说明。</p> : <Markdown className="release-note-body" text={note.body} />}
        </section>
      ))}
    </div>
  )
}

let notesOpen = false
const notesListeners = new Set<() => void>()
const setNotesOpen = (open: boolean) => { notesOpen = open; for (const l of notesListeners) l() }
const subscribeNotes = (l: () => void) => { notesListeners.add(l); return () => { notesListeners.delete(l) } }

/** Show the update's notes (and what to do), from anywhere. */
export function openUpdateNotes(): void {
  setNotesOpen(true)
}

/** The notes dialog; mount once where the client is known (the rail). */
export function UpdateNotesHost({ client }: { client: AdgClient }) {
  const open = useSyncExternalStore(subscribeNotes, () => notesOpen)
  const update = useAppUpdate(client)
  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setNotesOpen(false) } }
    document.addEventListener('keydown', onKey, true)
    return () => document.removeEventListener('keydown', onKey, true)
  }, [open])
  if (!open || update === null) return null
  const close = () => setNotesOpen(false)
  return (
    <div className="dialog-backdrop" onPointerDown={e => { if (e.target === e.currentTarget) close() }}>
      <div className="dialog update-notes-dialog" role="dialog" aria-modal="true" aria-labelledby="update-notes-title">
        <div className="update-notes-head">
          <h3 id="update-notes-title"><Icon name="download" />MultiGameAssistant {update.version} 可以更新了</h3>
          <button className="ghost icon-button" aria-label="关闭" title="关闭" onClick={close}><Icon name="close" /></button>
        </div>
        <p className="muted small">当前版本 {update.current}{update.prerelease ? ' · 新版本是预发布版' : ''}{update.notes.length > 1 ? ` · 更新后会带上下面 ${update.notes.length} 个版本的改动` : ''}</p>
        <div className="update-notes-body">
          <ReleaseNotes notes={update.notes} notesUrl={update.notesUrl} />
        </div>
        {update.kind === 'desktop'
          ? <UpdateActions bridge={update.bridge} state={update.state} extra={<button className="ghost small-button" onClick={() => { void update.bridge.skip(update.version); close() }}>跳过这个版本</button>} />
          : <PluginUpdateSteps version={update.version} onNpm={update.onNpm} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------- what to do

export function formatSize(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${Math.round(bytes / 1024 / 1024)} MB` : `${Math.max(1, Math.round(bytes / 1024))} KB`
}

/** Download, then 「退出并安装」; the progress and errors in between. */
export function UpdateActions({ bridge, state, extra }: { bridge: UpdatesBridge; state: UpdateState; extra?: ReactNode }) {
  const [error, setError] = useState<string | null>(null)
  const [installing, setInstalling] = useState(false)
  const latest = state.latest
  if (latest === undefined) return null
  const download = state.download?.version === latest.version ? state.download : undefined
  const run = (action: () => Promise<unknown>) => {
    setError(null)
    action().catch(e => setError(e instanceof Error ? e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '') : String(e)))
  }
  return (
    <div className="update-actions">
      {download?.state === 'downloading' && (
        <div className="update-progress">
          <div className="progress" role="progressbar" aria-label="下载进度" aria-valuemin={0} aria-valuemax={download.total} aria-valuenow={download.received}>
            <span style={{ width: `${download.total > 0 ? Math.min(100, (download.received / download.total) * 100) : 0}%` }} />
          </div>
          <small className="muted">正在下载 {formatSize(download.received)} / {formatSize(download.total)}</small>
        </div>
      )}
      {download?.state === 'ready' && <p className="muted small">安装时程序会退出，正在跑的脚本会被中断；装好后自动重新打开，数据和定时任务都在。</p>}
      {download?.state === 'failed' && <p className="error small">{download.error}</p>}
      {error !== null && <p className="error small">{error}</p>}
      <div className="update-buttons">
        {extra}
        {download?.state === 'ready'
          ? <button className="primary small-button" disabled={installing} onClick={() => { setInstalling(true); run(() => bridge.install().finally(() => setInstalling(false))) }}>{installing ? '正在启动安装…' : '退出并安装'}</button>
          : <button className="primary small-button" disabled={download?.state === 'downloading'} onClick={() => run(() => bridge.download())}>
              {download?.state === 'failed' ? '重新下载' : download?.state === 'downloading' ? '正在下载…' : `下载更新（${formatSize(latest.size)}）`}
            </button>}
      </div>
    </div>
  )
}

/**
 * How to update the plugin package: in dsh, by adding it again; by name when
 * npm already serves the version (a release goes live there once approved),
 * else by the release's own package link.
 */
export function PluginUpdateSteps({ version, onNpm }: { version: string; onNpm: boolean | undefined }) {
  const link = `${RELEASES}/download/v${version}/${PLUGIN_NAME}.tgz`
  return (
    <div className="plugin-update">
      {onNpm !== false && (
        <p>在 dsh 的「Plugins」→「Add plugin」里再填一次 <CopyCode text={PLUGIN_NAME} /> 安装（命令行的 dsh：<CopyCode text={`dsh plugin add ${PLUGIN_NAME}`} />）。{onNpm === undefined && '没连上 npm，不知道那边有没有这个版本；装完版本没变的话，用下面的链接。'}</p>
      )}
      {onNpm !== true && (
        <p>{onNpm === false && 'npm 上还没有这个版本（要等发布者批准）。'}在「Add plugin」里填这个链接安装：<CopyCode text={link} /></p>
      )}
      <p className="muted small">装好后刷新这个页面。你的数据、脚本和定时任务都在 dsh 的数据目录里，重新安装不会丢。</p>
    </div>
  )
}

/** Text to paste somewhere else, with a button that copies it. */
export function CopyCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})
  }
  return (
    <span className="copy-code">
      <code>{text}</code>
      <button type="button" className="link-button" onClick={copy} title="复制">{copied ? <Icon name="check" /> : <Icon name="copy" />}</button>
    </span>
  )
}

// ---------------------------------------------------------------- the dock card

/** The dock's card: shown for a newer version not skipped, until 「稍后」. */
export function UpdateCard() {
  const { bridge, state } = useUpdates()
  const [later, setLater] = useState(() => { try { return sessionStorage.getItem(LATER_KEY) } catch { return null } })
  const latest = state?.latest
  if (bridge === undefined || state == null || latest === undefined) return null
  const active = state.download?.version === latest.version && state.download.state !== 'failed'
  if (!active && (latest.version === state.skipped || latest.version === later)) return null
  const postpone = () => {
    try { sessionStorage.setItem(LATER_KEY, latest.version) } catch { /* only for this window then */ }
    setLater(latest.version)
  }
  const points = highlights(latest.notes ?? [])
  return (
    <div className="approval-card update-card" role="status">
      <div className="approval-head">
        <Icon name="download" />
        <div className="approval-text">
          <span className="approval-title">MultiGameAssistant {latest.version} 可以更新了</span>
          <span className="approval-tool">当前 {state.current}{latest.prerelease ? ' · 预发布版' : ''}</span>
        </div>
        {!active && <button className="ghost icon-button update-close" aria-label="稍后提醒" title="稍后（下次启动再提醒）" onClick={postpone}><Icon name="close" /></button>}
      </div>
      {points.length > 0 && <ul className="update-highlights">{points.map(p => <li key={p}>{p}</li>)}</ul>}
      <UpdateActions bridge={bridge} state={state} extra={<>
        <button className="ghost small-button" onClick={openUpdateNotes}>更新介绍</button>
        {!active && <button className="ghost small-button" onClick={() => void bridge.skip(latest.version)}>跳过这个版本</button>}
      </>} />
    </div>
  )
}
