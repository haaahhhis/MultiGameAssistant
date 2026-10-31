/** What the desktop shell (apps/desktop/preload.cjs) adds; absent in a plain browser. */
export interface DesktopBridge {
  /** A native file dialog. @returns the chosen file's path, or null when cancelled. */
  pickFile(options: { title?: string; defaultPath?: string | undefined; filterName?: string; extensions?: string[] }): Promise<string | null>
  /** Put a PNG (a data: URL) on the system clipboard, when the page's own clipboard is refused. */
  copyImage?(dataUrl: string): Promise<void>
  /** Open a folder or a viewable file; anything else is shown selected in Explorer. */
  openPath?(path: string): Promise<'opened' | 'revealed' | 'missing'>
  /** Follow the theme picked here, so the startup screen and window background match it. */
  setTheme?(theme: 'system' | 'light' | 'dark'): Promise<void>
  /** Which build this is: installed (its version) or run from the repository. */
  appInfo?(): Promise<{ fromSource: boolean; arch: string; version?: string; commit?: string }>
  /** Stop and start the agent service again (settings read at its start); the window shows the startup screen meanwhile. */
  restartService?(): Promise<void>
  /** Updates from GitHub Releases; every call answers the state, null when run from the repository. */
  updates?: UpdatesBridge
  /** The window shows this UI or dsh's own stock one, a separate dsh with its own conversations. */
  uiMode?: UiModeBridge
}

export interface UiMode {
  mode: 'adg' | 'official'
  /** The official dsh is starting (the first switch takes a while). */
  starting: boolean
  /** The last switch failed, or the official dsh exited: why. */
  error?: string
}

export interface UiModeBridge {
  state(): Promise<UiMode | null>
  /** 'adg' also clears the last error. */
  set(mode: UiMode['mode']): Promise<UiMode | null>
  /** @returns the unsubscriber. */
  onChange(listener: (state: UiMode) => void): () => void
}

export interface UpdateState {
  current: string
  arch: string
  /** Check by itself (after starting, then every few hours). */
  auto: boolean
  /** The version 「跳过这个版本」 was clicked for: not announced again. */
  skipped?: string
  checking: boolean
  checkedAt?: number
  /** The last check failed: why. */
  error?: string
  /** A newer release (none when this is the newest). */
  latest?: { version: string; prerelease: boolean; notesUrl: string; publishedAt?: string; size: number }
  download?: { version: string; state: 'downloading' | 'ready' | 'failed'; received: number; total: number; error?: string }
}

export interface UpdatesBridge {
  state(): Promise<UpdateState | null>
  check(): Promise<UpdateState | null>
  download(): Promise<UpdateState | null>
  /** Quits the app and runs the downloaded installer, which starts the new version. */
  install(): Promise<UpdateState | null>
  skip(version: string): Promise<UpdateState | null>
  setAuto(auto: boolean): Promise<UpdateState | null>
  /** @returns the unsubscriber. */
  onChange(listener: (state: UpdateState) => void): () => void
}

export function desktop(): DesktopBridge | undefined {
  return (window as unknown as { adgDesktop?: DesktopBridge }).adgDesktop
}
