/** What the desktop shell (apps/desktop/preload.cjs) adds; absent in a plain browser. */
export interface DesktopBridge {
  /** A native file dialog. @returns the chosen file's path, or null when cancelled. */
  pickFile(options: { title?: string; defaultPath?: string | undefined; filterName?: string; extensions?: string[] }): Promise<string | null>
}

export function desktop(): DesktopBridge | undefined {
  return (window as unknown as { adgDesktop?: DesktopBridge }).adgDesktop
}
