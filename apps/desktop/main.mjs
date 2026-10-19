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
import { app, BrowserWindow, dialog, ipcMain, Menu, nativeImage, shell, Tray } from 'electron'
import { execFile, spawn } from 'node:child_process'
import { randomBytes } from 'node:crypto'
import { createWriteStream, existsSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
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
const READY_TIMEOUT_MS = 180_000
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
  win = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 760,
    minHeight: 480,
    title: 'AutoDailyGamePlay',
    backgroundColor: '#f4f5f9',
    show: !autoStarted,
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
  await win.loadURL(statusPage('正在启动 dsh…', '首次启动可能需要几十秒。'))

  if (!existsSync(join(paths.uiDir, 'index.html'))) {
    await fail('界面尚未构建', '请先运行 pnpm build（或 pnpm desktop:dev）。')
    return
  }
  try {
    prepareAdgProfile({
      home: paths.home,
      bundleDir: paths.bundleDir,
      dshBin: paths.dshBin,
      node: process.execPath,
      env: { ELECTRON_RUN_AS_NODE: '1' },
    })
  } catch (error) {
    await fail('无法准备 dsh profile', String(error))
    return
  }
  launchHost()
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
  const logDir = join(app.getPath('userData'), 'logs')
  mkdirSync(logDir, { recursive: true })
  const logFile = createWriteStream(join(logDir, 'dsh.log'), { flags: 'a' })
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
      ADG_AUTOSTARTED: autoStarted ? '1' : '0',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  })
  host = child

  let ready = false
  const timer = setTimeout(() => {
    if (!ready) void fail('dsh 启动超时', tail())
  }, READY_TIMEOUT_MS)

  const onLine = line => {
    logFile.write(`${line}\n`)
    logTail.push(line)
    if (logTail.length > LOG_TAIL_LINES) logTail.shift()
    const match = /adg gateway: (http:\/\/127\.0\.0\.1:\d+\/\?token=\S+)/.exec(line)
    if (match !== null && !ready) {
      ready = true
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
      void win?.loadURL(statusPage('dsh 意外退出，正在重新启动…', '定时任务会在重新启动后继续。')).catch(() => {})
      setTimeout(() => { if (!quitting) launchHost() }, 3000)
      return
    }
    void fail(ready ? 'dsh 反复意外退出' : 'dsh 启动失败', tail(), true)
  })
}

async function openUi(url) {
  if (win === null) return
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
          backgroundColor: '#f4f5f9',
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

async function fail(title, detail, offerRestart = false) {
  if (win !== null) await win.loadURL(statusPage(title, detail, true)).catch(() => {})
  if (!offerRestart || win === null) return
  showWindow()
  const { response } = await dialog.showMessageBox(win, {
    type: 'error',
    title: 'AutoDailyGamePlay',
    message: title,
    detail: `${detail}\n\n完整日志：${join(app.getPath('userData'), 'logs', 'dsh.log')}`,
    buttons: ['重新启动 dsh', '退出'],
    defaultId: 0,
  })
  if (response === 0) {
    restarts.length = 0
    await win?.loadURL(statusPage('正在重新启动 dsh…', ''))
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

function statusPage(title, detail, error = false) {
  const escape = s => String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c])
  const html = `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>AutoDailyGamePlay</title>
<style>
:root{color-scheme:light;--bg:#f4f5f9;--panel:#fff;--surface:#f9fafd;--text:#242938;--muted:#657085;--border:#e5e8f0;--accent:#5264dc;--accent-text:#fff;--soft:#eef0fe;--error:#ca4b55;--shadow:0 4px 12px #1e294006,0 24px 64px #1e294008}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;display:flex;flex-direction:column;align-items:center;justify-content:center;padding:32px;font:14px/1.7 system-ui,"Segoe UI","Microsoft YaHei UI","PingFang SC",sans-serif;background:var(--bg);color:var(--text);-webkit-font-smoothing:antialiased}
.box{width:440px;max-width:100%;padding:40px;text-align:center;border:1px solid var(--border);border-radius:24px;background:var(--panel);box-shadow:var(--shadow)}
.brand{display:flex;justify-content:center;align-items:center;gap:8px;font-size:13px;font-weight:600;letter-spacing:.1px;color:var(--muted);margin-bottom:34px}
.brand-dot{width:6px;height:6px;border-radius:50%;background:var(--accent)}
.symbol{position:relative;width:88px;height:88px;display:flex;align-items:center;justify-content:center;margin:0 auto 30px;border:1px solid var(--border);border-radius:27px;background:var(--surface);transform:rotate(-8deg)}
.symbol::before{content:'';position:absolute;inset:9px;border:1px dashed var(--border);border-radius:21px}
.mark{position:relative;width:50px;height:50px;display:flex;align-items:center;justify-content:center;border-radius:15px;background:var(--accent);color:var(--accent-text);transform:rotate(8deg);box-shadow:0 5px 12px color-mix(in srgb,var(--accent) 18%,transparent)}
.mark svg{width:29px;height:29px}
.eyebrow{margin:0 0 10px;font-size:11px;letter-spacing:2px;color:var(--muted)}
h1{font-size:23px;line-height:1.5;letter-spacing:-.5px;font-weight:650;margin:0 0 12px;overflow-wrap:anywhere}
.detail{margin:0;font-size:13px;color:var(--muted);overflow-wrap:anywhere}
.progress{position:relative;overflow:hidden;height:3px;margin:30px 28px 18px;border-radius:3px;background:var(--soft)}
.progress::after{content:'';display:block;width:35%;height:100%;border-radius:3px;background:var(--accent);animation:loading 1.8s ease-in-out infinite}
.status{display:flex;align-items:center;justify-content:center;gap:7px;font-size:11px;color:var(--muted);margin:0}
.spin{width:11px;height:11px;border:1.5px solid var(--border);border-top-color:var(--accent);border-radius:50%;animation:spin .9s linear infinite}
.footer{margin:24px 0 0;font-size:11px;color:var(--muted);letter-spacing:.5px}
.error.box{width:600px}
.error .mark{background:color-mix(in srgb,var(--error) 10%,var(--panel));color:var(--error);box-shadow:none}
.error h1{color:var(--error)}
.error .symbol{margin-bottom:24px}
.error .brand{margin-bottom:28px}
.error .status{margin-top:20px}
pre{margin:20px 0 0;text-align:left;white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.8 ui-monospace,"Cascadia Code",Consolas,monospace;color:var(--muted);background:var(--surface);border:1px solid var(--border);padding:16px;border-radius:10px;max-height:34vh;overflow:auto;tab-size:2}
pre:focus-visible{outline:2px solid var(--accent);outline-offset:3px}
@keyframes loading{0%{transform:translateX(-110%)}100%{transform:translateX(390%)}}
@keyframes spin{to{transform:rotate(360deg)}}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;--bg:#16181f;--panel:#1e212a;--surface:#1a1d25;--text:#e7eaf3;--muted:#9ba4b8;--border:#303541;--accent:#9ba8ff;--accent-text:#1a214b;--soft:#2b314d;--error:#f28c95;--shadow:0 8px 32px #00000018}}
@media(max-height:620px){body{padding:20px}.box{padding:24px 32px}.brand{margin-bottom:20px}.symbol{width:68px;height:68px;margin-bottom:20px;border-radius:22px}.mark{width:42px;height:42px;border-radius:13px}h1{font-size:21px}.progress{margin-top:22px}.footer{margin-top:16px}.error .symbol{display:none}}
@media(max-width:480px){body{padding:20px}.box{padding:28px 24px}h1{font-size:21px}}
@media(prefers-reduced-motion:reduce){.spin,.progress::after{animation:none}.progress::after{width:100%;opacity:.45}}
</style></head><body>
<main class="box${error ? ' error' : ''}" role="${error ? 'alert' : 'status'}">
  <div class="brand"><span class="brand-dot" aria-hidden="true"></span>AutoDailyGamePlay</div>
  <div class="symbol" aria-hidden="true"><div class="mark"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">${error
    ? '<path d="M12 7v6m0 4h.01"/><circle cx="12" cy="12" r="9"/>'
    : '<path d="m12 3 9 5-9 5-9-5 9-5Zm-9 9 9 5 9-5M3 16l9 5 9-5"/>'}</svg></div></div>
  <p class="eyebrow">${error ? '工作空间暂时不可用' : '正在准备你的工作空间'}</p>
  <h1>${escape(title)}</h1>
  ${detail ? (error ? `<pre tabindex="0" aria-label="错误详情">${escape(detail)}</pre>` : `<p class="detail">${escape(detail)}</p>`) : ''}
  ${error ? '<p class="status">请根据上方提示检查，或查看完整日志了解详情。</p>' : '<div class="progress" aria-hidden="true"></div><p class="status"><span class="spin" aria-hidden="true"></span>准备就绪后将自动进入</p>'}
</main><p class="footer">思考 · 创造 · 解决</p>
</body></html>`
  return `data:text/html;charset=utf-8,${encodeURIComponent(html)}`
}
