/**
 * What the desktop shell adds to the page: a native file dialog (a browser
 * cannot give a page a file's path), copying a picture to the clipboard, and
 * opening a file or folder the agent linked to, keeping the window's colours
 * on the theme picked in the UI, and the startup screen's buttons.
 * The page works without it.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('adgDesktop', {
  /** @returns the chosen file's path, or null when cancelled. */
  pickFile: options => ipcRenderer.invoke('adg:pick-file', options ?? {}),
  copyImage: dataUrl => ipcRenderer.invoke('adg:copy-image', dataUrl),
  openPath: path => ipcRenderer.invoke('adg:open-path', path),
  setTheme: theme => ipcRenderer.invoke('adg:theme', theme),
  /** Which build this is: `{ fromSource, arch, version?, commit? }`. */
  appInfo: () => ipcRenderer.invoke('adg:app-info'),
  /** Only answered while the startup screen is showing. */
  splash: action => ipcRenderer.invoke('adg:splash', action),
  /** Updates from GitHub Releases (apps/desktop/updates.mjs); each call answers the state, null when run from the repository. */
  updates: {
    state: () => ipcRenderer.invoke('adg:update', 'state'),
    check: () => ipcRenderer.invoke('adg:update', 'check'),
    download: () => ipcRenderer.invoke('adg:update', 'download'),
    /** Quits the app and runs the downloaded installer. */
    install: () => ipcRenderer.invoke('adg:update', 'install'),
    skip: version => ipcRenderer.invoke('adg:update', 'skip', version),
    setAuto: auto => ipcRenderer.invoke('adg:update', 'auto', auto),
    /** @returns the unsubscriber. */
    onChange: listener => {
      const handler = (_event, state) => listener(state)
      ipcRenderer.on('adg:update-state', handler)
      return () => ipcRenderer.removeListener('adg:update-state', handler)
    },
  },
})
