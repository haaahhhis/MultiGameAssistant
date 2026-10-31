/**
 * 「官方界面」: dsh's own web UI, stock (profile "web", none of
 * MultiGameAssistant's plugins), in the same window. It is a second dsh with
 * a home of its own — its own conversations, settings and model keys — so the
 * chats on either side never mix. It starts the first time it is asked for and
 * runs until the app quits; the agent service keeps running beside it, so
 * schedules carry on.
 *
 * Shown as a view over the page below the title bar, where the page's switch
 * stays to come back (apps/web UiSwitch.tsx); neither side reloads.
 *
 * dsh starts its sessions in its working folder, and its Windows sandbox labels
 * that folder low-integrity for good: it runs in `<home>/workspace`, never in
 * the app's folder.
 */
import { spawn, execFile } from 'node:child_process'
import { createWriteStream, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { WebContentsView } from 'electron'

const READY_TIMEOUT_MS = 180_000
const READY_LINE = /^dsh web: (http:\/\/127\.0\.0\.1:\d+\/\S*)/

/**
 * @typedef {{ mode: 'adg' | 'official', starting: boolean, error?: string }} UiMode
 * @param {object} options
 * @param {import('electron').BrowserWindow} options.window
 * @param {string} options.dshBin - `@deepseek-ai/dsh/lib/bin.js`.
 * @param {string} options.home - this dsh's own DSH_HOME.
 * @param {number} options.top - the title bar's height: the view starts below it.
 * @param {string} options.logFile - where dsh's output goes.
 * @param {() => string} options.background - the window's background colour.
 * @param {(contents: import('electron').WebContents, origin: string) => void} options.prepare - link and shortcut rules for the page.
 * @param {(file: string) => Promise<void>} options.endLeftover - end the dsh a crashed start left running.
 * @param {(state: UiMode) => void} options.onChange
 */
export function createOfficialUi({ window, dshBin, home, top, logFile, background, prepare, endLeftover, onChange }) {
  /** @type {UiMode} */
  let state = { mode: 'adg', starting: false }
  /** @type {import('node:child_process').ChildProcess | null} */
  let host = null
  /** @type {Promise<string> | null} The running dsh's address once it printed it. */
  let ready = null
  /** @type {WebContentsView | null} */
  let view = null
  /** The address `view` shows. */
  let loaded = ''
  let stopping = false
  const hostFile = join(home, 'desktop-host.json')

  const set = next => { state = next; onChange(state) }
  const layout = () => {
    if (view === null) return
    const [width, height] = window.getContentSize()
    view.setBounds({ x: 0, y: top, width, height: Math.max(0, height - top) })
  }
  window.on('resize', layout)

  const start = () => new Promise((resolve, reject) => {
    const workspace = join(home, 'workspace')
    mkdirSync(workspace, { recursive: true })
    const log = createWriteStream(logFile, { flags: 'a' })
    log.write(`\n=== ${new Date().toISOString()} starting dsh web (home ${home}) ===\n`)
    const child = spawn(process.execPath, [dshBin, '--profile', 'web', '--no-open', '--port', '0'], {
      cwd: workspace,
      env: { ...process.env, ELECTRON_RUN_AS_NODE: '1', DSH_HOME: home },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    host = child
    try { writeFileSync(hostFile, JSON.stringify({ pid: child.pid, startedAt: Date.now() })) } catch { /* only used to clean up after a crash */ }
    const last = []
    let found = false
    const timer = setTimeout(() => { if (!found) { stopHost(); reject(new Error(`${READY_TIMEOUT_MS / 1000} 秒内没有启动完成`)) } }, READY_TIMEOUT_MS)
    for (const stream of [child.stdout, child.stderr]) {
      let buffer = ''
      stream.setEncoding('utf8')
      stream.on('data', chunk => {
        buffer += chunk
        let newline
        while ((newline = buffer.indexOf('\n')) !== -1) {
          const line = buffer.slice(0, newline).replace(/\r$/, '')
          buffer = buffer.slice(newline + 1)
          log.write(`${line}\n`)
          last.push(line)
          if (last.length > 8) last.shift()
          const match = READY_LINE.exec(line)
          if (match !== null && !found) { found = true; clearTimeout(timer); resolve(match[1]) }
        }
      })
    }
    child.on('error', error => { clearTimeout(timer); reject(error) })
    child.on('exit', code => {
      clearTimeout(timer)
      log.end(`=== dsh web exited (code ${code}) ===\n`)
      if (host === child) { host = null; ready = null }
      try { if (JSON.parse(readFileSync(hostFile, 'utf8')).pid === child.pid) rmSync(hostFile, { force: true }) } catch { /* not there */ }
      if (!found) reject(new Error(last.filter(l => l.trim() !== '').slice(-5).join('\n') || `退出了（代码 ${code}）`))
      else if (!stopping && state.mode === 'official') {
        hide()
        set({ ...state, error: '官方界面的 dsh 退出了，再点一次会重新启动。' })
      }
    })
  })

  const stopHost = () => {
    const child = host
    host = null
    ready = null
    if (child === null || child.exitCode !== null || child.pid === undefined) return
    if (process.platform === 'win32') execFile('taskkill', ['/pid', String(child.pid), '/T', '/F'], () => {})
    else child.kill('SIGTERM')
  }

  async function show() {
    if (state.mode === 'official' || state.starting) return state
    set({ mode: 'adg', starting: true })
    try {
      if (ready === null) {
        mkdirSync(home, { recursive: true })
        await endLeftover(hostFile)
        ready = start()
        ready.catch(() => { ready = null })
      }
      const url = await ready
      // A restarted dsh has another port: its page is a new origin, in a new view.
      if (view !== null && loaded !== url) {
        view.webContents.close()
        view = null
      }
      if (view === null) {
        view = new WebContentsView({ webPreferences: { contextIsolation: true, sandbox: true, nodeIntegration: false } })
        view.setBackgroundColor(background())
        prepare(view.webContents, new URL(url).origin)
        await view.webContents.loadURL(url)
        loaded = url
      }
      window.contentView.addChildView(view)
      layout()
      view.webContents.focus()
      set({ mode: 'official', starting: false })
    } catch (error) {
      set({ mode: 'adg', starting: false, error: `官方界面没能启动：${error instanceof Error ? error.message : String(error)}` })
    }
    return state
  }

  /** Back to MultiGameAssistant's own page; the official dsh keeps running for the next switch. */
  function hide() {
    if (view !== null) window.contentView.removeChildView(view)
    window.webContents.focus()
    if (state.mode !== 'adg' || state.error !== undefined) set({ mode: 'adg', starting: state.starting })
    return state
  }

  return {
    state: () => state,
    show,
    hide,
    /** The app quits. */
    stop() { stopping = true; stopHost() },
  }
}
