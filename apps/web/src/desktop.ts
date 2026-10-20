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
}

export function desktop(): DesktopBridge | undefined {
  return (window as unknown as { adgDesktop?: DesktopBridge }).adgDesktop
}
