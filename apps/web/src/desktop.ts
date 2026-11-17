import type { ReleaseNote } from '@adg/protocol'

/** What the desktop shell (apps/desktop/preload.cjs) adds; absent in a plain browser. */
export interface DesktopBridge {
  /** A native file dialog. @returns the chosen file's path, or null when cancelled. */
  pickFile(options: { title?: string; defaultPath?: string | undefined; filterName?: string; extensions?: string[]; folder?: boolean }): Promise<string | null>
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
  /** The built-in browser the agent operates (apps/desktop/browser.mjs). */
  browser?: BrowserBridge
}

export interface BrowserTab {
  id: string
  title: string
  url: string
  loading: boolean
  canGoBack: boolean
  canGoForward: boolean
  /** The session whose agent opened it. */
  owner?: string
}

export interface BrowserState {
  tabs: BrowserTab[]
  /** The tab the panel shows. */
  shown: string | null
  /** When an agent last acted in the browser (ms since 1970); 0 never. */
  agentAt: number
}

/** A frame of the shown tab: a JPEG at the page's size. */
export interface BrowserFrame {
  tab: string
  width: number
  height: number
  data: Uint8Array
}

/** Electron's sendInputEvent shapes, in page coordinates. */
export type BrowserInput =
  | { type: 'mouseDown' | 'mouseUp' | 'mouseMove' | 'mouseEnter' | 'mouseLeave'; x: number; y: number; button?: 'left' | 'middle' | 'right'; clickCount?: number; modifiers?: string[] }
  | { type: 'mouseWheel'; x: number; y: number; deltaX: number; deltaY: number; canScroll?: boolean; modifiers?: string[] }
  | { type: 'keyDown' | 'keyUp' | 'char'; keyCode: string; modifiers?: string[] }

export interface BrowserBridge {
  state(): Promise<BrowserState | null>
  /** The panel is on screen at this size (CSS pixels), or not (null): frames come only while it is. */
  show(size: { width: number; height: number } | null): Promise<BrowserState | null>
  input(event: BrowserInput): void
  /** Typed text (an input method's result included) into the page's focused field. */
  text(text: string): Promise<void>
  /** The user's toolbar, on the tab the panel shows (newTab: a new one). */
  navigate(target: { url?: string; action?: 'back' | 'forward' | 'reload'; newTab?: boolean }): Promise<BrowserState | null>
  select(tab: string): Promise<BrowserState | null>
  close(tab: string): Promise<BrowserState | null>
  /** @returns the unsubscriber. */
  onChange(listener: (state: BrowserState) => void): () => void
  /** @returns the unsubscriber. */
  onFrame(listener: (frame: BrowserFrame) => void): () => void
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
  latest?: { version: string; prerelease: boolean; notesUrl: string; publishedAt?: string; size: number; /** What each release up to it brings, newest first. */ notes?: ReleaseNote[] }
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
