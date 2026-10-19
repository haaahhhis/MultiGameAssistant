/**
 * What the desktop shell adds to the page: a native file dialog (a browser
 * cannot give a page a file's path). The page works without it.
 */
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('adgDesktop', {
  /** @returns the chosen file's path, or null when cancelled. */
  pickFile: options => ipcRenderer.invoke('adg:pick-file', options ?? {}),
})
