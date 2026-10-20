/**
 * AutoDailyGamePlay desktop shell.
 *
 * Boots dsh (profile "adg") with Electron's own Node runtime, waits for the
 * gateway's `adg gateway: <url>` line, and opens a sandboxed window on that
 * URL; the gateway serves the UI and the protocol on the same loopback origin.
 * The shell owns no product logic: replace it and the UI still works in any
 * browser pointed at the gateway.
 *
 * Unattended use (docs/PLAN.zh.md §5.9): closing the window keeps the app in
 * the tray so schedules keep running; `--auto-start` (the logon task the
 * scheduler registers) starts hidden in the tray; dsh is restarted when it
 * dies, and the scheduler picks up where it left off.
 */
import { app, BrowserWindow, clipboard, dialog, ipcMain, Menu, nativeImage, nativeTheme, shell, Tray } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync, readFileSync, statSync, writeFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { prepareAdgProfile } from '../../scripts/profile.mjs'
import { trayIconPng } from './icon.mjs'

const here = dirname(fileURLToPath(import.meta.url))
const root = resolve(here, '..', '..') // the repository root
const paths = {
  dshBin: join(root, 'node_modules', '@deepseek-ai', 'dsh', 'lib', 'bin.js'),
  bundleDir: join(root, 'packages', 'bundle'),
  uiDir: join(root, 'apps', 'web', 'dist'),
  // Development shares sessions with `pnpm dev:host`; DSH_HOME overrides.
  home: process.env.DSH_HOME ?? join(root, '.dev-home'),
}
/** Files opened directly from a link; the rest are only shown in Explorer. */
const VIEWABLE = /\.(txt|log|md|json|jsonl|ya?ml|toml|ini|cfg|conf|csv|xml|html?|png|jpe?g|gif|webp|bmp|pdf)$/i
const READY_TIMEOUT_MS = 180_000
/** The page's --bg, so the window never flashes another colour while pages change. */
const BACKGROUND = { light: '#f2f2f0', dark: '#0b0b0c' }
const THEMES = ['system', 'light', 'dark']
const LOG_TAIL_LINES = 40
/** Restarts allowed within RESTART_WINDOW_MS before asking the user. */
const MAX_RESTARTS = 5
const RESTART_WINDOW_MS = 10 * 60_000
const autoStarted = process.argv.includes('--auto-start')
/** How the logon task starts this app again: the packaged exe, or Electron with this app's folder. */
const launchCommand = app.isPackaged ? [process.execPath, '--auto-start'] : [process.execPath, here, '--auto-start']

/** @type {import('node:child_process').ChildProcess | null} */
let host = null
/** @type {BrowserWindow | null} */
let win = null
let quitting = false
/** @type {Tray | null} */
let tray = null
let toldAboutTray = false
/** The splash is showing (not the UI): its buttons are answered, its state can be pushed. */
let onSplash = false
/** dsh has come up once: later starts are restarts (the scheduler does not run on-start pipelines again). */
let everReady = false
/** What the failure screen's 「复制错误信息」 copies. */
let failure = ''
const restarts = []
const logTail = []

if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  app.on('second-instance', () => showWindow())
  app.whenReady().then(start)
}

// Closing the window hides it (see start); quitting is the tray's "退出".
app.on('window-all-closed', () => {})
app.on('before-quit', () => {
  quitting = true
  stopHost()
})

async function start() {
  createTray()
  // The theme the user picked in the UI, so the splash before it matches.
  nativeTheme.themeSource = savedTheme()
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'AutoDailyGamePlay',
    backgroundColor: background(),
    show: false,
    icon: nativeImage.createFromBuffer(trayIconPng(64)),
    webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false, preload: join(here, 'preload.cjs') },
  })
  // The one thing the page cannot do itself: let the user pick a file and learn its path.
  ipcMain.handle('adg:pick-file', async (event, options) => {
    if (win === null || event.sender !== win.webContents) return null
    const o = typeof options === 'object' && options !== null ? options : {}
    const extensions = Array.isArray(o.extensions) ? o.extensions.filter(e => typeof e === 'string' && /^\w+$/.test(e)) : []
    const result = await dialog.showOpenDialog(win, {
      title: typeof o.title === 'string' ? o.title : '选择文件',
      ...(typeof o.defaultPath === 'string' && o.defaultPath !== '' ? { defaultPath: o.defaultPath } : {}),
      filters: extensions.length > 0 ? [{ name: typeof o.filterName === 'string' ? o.filterName : '文件', extensions }, { name: '所有文件', extensions: ['*'] }] : [],
      properties: ['openFile'],
    })
    return result.canceled ? null : result.filePaths[0] ?? null
  })
  // A file or folder the agent linked to. Folders and files to look at open; anything else
  // (programs, scripts, shortcuts) is only shown selected in Explorer, never run.
  ipcMain.handle('adg:open-path', async (event, target) => {
    if (win === null || event.sender !== win.webContents || typeof target !== 'string' || !isAbsolute(target)) return 'missing'
    let stat
    try { stat = statSync(target) } catch { return 'missing' }
    if (stat.isDirectory() || VIEWABLE.test(target)) {
      const failed = await shell.openPath(target)
      if (failed === '') return 'opened'
    }
    shell.showItemInFolder(target)
    return 'revealed'
  })
  ipcMain.handle('adg:theme', (_event, theme) => {
    if (!THEMES.includes(theme)) return
    nativeTheme.themeSource = theme
    try { writeFileSync(themeFile(), JSON.stringify({ theme })) } catch { /* a preference, not worth failing over */ }
    for (const w of BrowserWindow.getAllWindows()) w.setBackgroundColor(background())
  })
  // The splash's buttons when starting failed.
  ipcMain.handle('adg:splash', async (event, action) => {
    if (win === null || event.sender !== win.webContents || !onSplash) return false
    if (action === 'restart') {
      restarts.length = 0
      stopHost()
      await showSplash({ step: 'service', title: '正在重新启动 agent 服务', slowHint: SLOW_HINT })
      launchHost()
    } else if (action === 'logs') {
      await shell.openPath(logDir())
    } else if (action === 'copy') {
      clipboard.writeText(failure)
      return true
    } else if (action === 'quit') {
      quitting = true
      app.quit()
    }
    return false
  })
  ipcMain.handle('adg:copy-image', (event, dataUrl) => {
    if (win === null || event.sender !== win.webContents || typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) return
    clipboard.writeImage(nativeImage.createFromDataURL(dataUrl))
  })
  win.on('close', event => {
    if (quitting) return
    // Keep running for schedules; the tray brings the window back.
    event.preventDefault()
    win?.hide()
    if (!toldAboutTray && tray !== null && process.platform === 'win32') {
      toldAboutTray = true
      tray.displayBalloon({ title: 'AutoDailyGamePlay 仍在运行', content: '定时任务会照常执行。点托盘图标打开，右键「退出」关闭。', iconType: 'info' })
    }
  })
  win.on('closed', () => { win = null })
  win.once('ready-to-show', () => { if (!autoStarted) win?.show() })
  await showSplash({ step: 'env', title: '正在准备运行环境' })

  if (!existsSync(join(paths.uiDir, 'index.html'))) {
    await fail('界面还没有构建', '请先在项目目录运行 pnpm build（或用 pnpm desktop:dev 启动）。')
    return
  }
  // Let the splash paint before the synchronous profile work below.
  await new Promise(resolve => setTimeout(resolve, 60))
  try {
    prepareAdgProfile({
      home: paths.home,
      bundleDir: paths.bundleDir,
      dshBin: paths.dshBin,
      node: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  } catch (error) {
    await fail('无法准备运行环境', String(error))
    return
  }
  await showSplash({ step: 'service', title: '正在启动 agent 服务', slowHint: SLOW_HINT })
  launchHost()
}

const SLOW_HINT = '第一次启动或更新之后要安装插件，可能需要一两分钟。'

/** The splash: loaded once, then updated in place so its animation does not restart. */
async function showSplash(state) {
  if (win === null) return
  if (onSplash) {
    const pushed = await win.webContents.executeJavaScript(`window.adgSplash ? (window.adgSplash.set(${JSON.stringify(state)}), true) : false`).catch(() => false)
    if (pushed) return
  }
  onSplash = true
  await win.loadFile(join(here, 'splash.html'), { query: { s: JSON.stringify(state) } }).catch(() => {})
}

function themeFile() {
  return join(app.getPath('userData'), 'theme.json')
}

function savedTheme() {
  try {
    const { theme } = JSON.parse(readFileSync(themeFile(), 'utf8'))
    return THEMES.includes(theme) ? theme : 'system'
  } catch {
    return 'system'
  }
}

function background() {
  return nativeTheme.shouldUseDarkColors ? BACKGROUND.dark : BACKGROUND.light
}

function logDir() {
  return join(app.getPath('userData'), 'logs')
}

function createTray() {
  tray = new Tray(nativeImage.createFromBuffer(trayIconPng(32)))
  tray.setToolTip(autoStarted ? 'AutoDailyGamePlay（开机自动启动）' : 'AutoDailyGamePlay')
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: '打开 AutoDailyGamePlay', click: () => showWindow() },
    { type: 'separator' },
    { label: '退出', click: () => { quitting = true; app.quit() } },
  ]))
  tray.on('click', () => showWindow())
}

function showWindow() {
  if (win === null) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
}

function launchHost() {
  const token = randomBytes(24).toString('base64url')
  mkdirSync(logDir(), { recursive: true })
  const logFile = createWriteStream(join(logDir(), 'dsh.log'), { flags: 'a' })
  logFile.write(`\n=== ${new Date().toISOString()} starting dsh (home ${paths.home}) ===\n`)

  const child = spawn(process.execPath, [paths.dshBin, '--profile', 'adg', '--no-open', '--port', '0'], {
    env: {
      ...process.env,
      ELECTRON_RUN_AS_NODE: '1',
      DSH_HOME: paths.home,
      ADG_GATEWAY_TOKEN: token,
      ADG_GATEWAY_PORT: '0',
      ADG_UI_DIR: paths.uiDir,
      ADG_LAUNCH_COMMAND: JSON.stringify(launchCommand),
      ADG_AUTOSTARTED: autoStarted && !everReady ? '1' : '0',
      ADG_APP_START: everReady ? '0' : '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  host = child

  let ready = false
  const timer = setTimeout(() => {
    if (!ready) {
      stopHost()
      void fail('agent 服务启动超时', tail(), true)
    }
  }, READY_TIMEOUT_MS)

  const onLine = line => {
    logFile.write(`${line}\n`)
    logTail.push(line)
    if (logTail.length > LOG_TAIL_LINES) logTail.shift()
    const match = /adg gateway: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(line)
    if (match !== null && !ready) {
      ready = true
      everReady = true
      clearTimeout(timer)
      void openUi(match[1])
    }
  }
  for (const stream of [child.stdout, child.stderr]) {
    let buffer = ''
    stream.setEncoding('utf8')
    stream.on('data', chunk => {
      buffer += chunk
      let newline
      while ((newline = buffer.indexOf('\n')) !== -1) {
        onLine(buffer.slice(0, newline).replace(/\r$/, ''))
        buffer = buffer.slice(newline + 1)
      }
    })
  }

  child.on('exit', (code, signal) => {
    clearTimeout(timer)
    logFile.end(`=== dsh exited (code ${code}, signal ${signal}) ===\n`)
    if (host === child) host = null
    if (quitting) return
    // Unattended: bring dsh back by itself a few times before asking.
    const now = Date.now()
    while (restarts.length > 0 && now - restarts[0] > RESTART_WINDOW_MS) restarts.shift()
    if (ready && restarts.length < MAX_RESTARTS) {
      restarts.push(now)
      logTail.push(`[desktop] dsh exited (code ${code}); restarting (${restarts.length}/${MAX_RESTARTS})`)
      void showSplash({ step: 'service', title: 'agent 服务意外退出，正在重新启动', hint: '定时任务会在重新启动后继续。' })
      setTimeout(() => { if (!quitting) launchHost() }, 3000)
      return
    }
    void fail(ready ? 'agent 服务反复意外退出' : 'agent 服务没能启动', tail(), true)
  })
}

async function openUi(url) {
  if (win === null) return
  await showSplash({ step: 'ui', title: '正在载入界面' })
  onSplash = false
  guardContents(win.webContents, new URL(url).origin)
  win.webContents.on('render-process-gone', (_event, details) => {
    if (!quitting) void fail('界面进程崩溃', details.reason, false)
  })
  await win.loadURL(url)
}

/**
 * Keep a window on the UI origin: same-origin `window.open` (a popped-out
 * session view) becomes another sandboxed app window under the same rules;
 * any other link or navigation goes to the system browser.
 * @param {Electron.WebContents} contents
 * @param {string} origin
 */
function guardContents(contents, origin) {
  const sameOrigin = target => {
    try { return new URL(target).origin === origin } catch { return false }
  }
  contents.setWindowOpenHandler(({ url: target }) => {
    if (sameOrigin(target)) {
      return {
        action: 'allow',
        overrideBrowserWindowOptions: {
          width: 1100,
          height: 780,
          minWidth: 480,
          minHeight: 360,
          backgroundColor: background(),
          autoHideMenuBar: true,
          webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false },
        },
      }
    }
    openExternal(target)
    return { action: 'deny' }
  })
  contents.on('did-create-window', child => guardContents(child.webContents, origin))
  contents.on('will-navigate', (event, target) => {
    if (!sameOrigin(target)) {
      event.preventDefault()
      openExternal(target)
    }
  })
}

function openExternal(target) {
  try {
    const { protocol } = new URL(target)
    if (protocol === 'http:' || protocol === 'https:') void shell.openExternal(target)
  } catch {
    // not a URL: ignore
  }
}

/**
 * Starting failed: the splash turns into the error with its details and
 * buttons. Without the preload bridge (it should always be there) the
 * buttons fall back to a native dialog.
 */
async function fail(title, detail, offerRestart = false) {
  if (win === null) return
  failure = `${title}\n\n${detail}\n\n完整日志：${join(logDir(), 'dsh.log')}`
  const actions = [
    ...(offerRestart ? [{ id: 'restart', label: '重新启动', primary: true }] : []),
    { id: 'copy', label: '复制错误信息' },
    { id: 'logs', label: '打开日志文件夹' },
    { id: 'quit', label: '退出' },
  ]
  await showSplash({ step: 'service', title, error: { title, detail, actions } })
  showWindow()
  const bridged = await win.webContents.executeJavaScript('typeof window.adgDesktop?.splash === "function"').catch(() => false)
  if (bridged || !offerRestart) return
  const { response } = await dialog.showMessageBox(win, {
    type: 'error',
    title: 'AutoDailyGamePlay',
    message: title,
    detail: failure,
    buttons: ['重新启动', '退出'],
    defaultId: 0,
  })
  if (response === 0) {
    restarts.length = 0
    stopHost()
    await showSplash({ step: 'service', title: '正在重新启动 agent 服务', slowHint: SLOW_HINT })
    launchHost()
  } else {
    quitting = true
    app.quit()
  }
}

function stopHost() {
  const child = host
  host = null
  if (child === null || child.exitCode !== null || child.pid === undefined) return
  if (process.platform === 'win32') {
    // Kill the whole tree: dsh spawns shells and language servers.
    execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
  } else {
    child.kill('SIGTERM')
  }
}

function tail() {
  return logTail.slice(-15).join('\n') || '（没有输出）'
}
