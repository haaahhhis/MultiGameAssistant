/**
 * The built-in browser: web pages the agent operates and the user watches
 * or takes over in the app's browser panel.
 *
 * As in Codex's in-app browser, it is a sandbox of its own: one in-memory
 * session (`adg-browser`, nothing kept after the app quits: no logins, no
 * cookies), no permissions, no downloads, no popup windows (they open as
 * tabs), never the app's own pages. The agent drives only these pages,
 * through each page's own DevTools protocol connection
 * (`webContents.debugger`): no debugging port is opened, so neither the agent
 * nor any other program can reach the app's own window this way.
 *
 * Each tab renders offscreen (a hidden window with `offscreen: true`): pages
 * live in the main process and keep laying out, drawing and answering input
 * while the app's window is in the tray, minimized or showing another page —
 * a page in a hidden window stops drawing, and then scrolling, screenshots
 * and the accessibility tree all stall. The panel shows the tab's frames
 * (`frame` events) and sends the user's mouse, keys and typed text back
 * (`input`, `insertText`).
 */
import { EventEmitter } from 'node:events'
import { BrowserWindow, session as electronSession } from 'electron'
import { checkUrl, formatAxTree, parseKey } from './browser-snapshot.mjs'

const PARTITION = 'adg-browser'
/** The page size until the panel says how big it is. */
const DEFAULT_SIZE = { width: 1280, height: 800 }
const LOAD_TIMEOUT_MS = 20_000
const ACTION_SNAPSHOT_CHARS = 8_000
const MAX_TABS = 12
/** Frames a second: while the panel shows the tab, and otherwise (enough for the page to keep up). */
const SHOWN_FPS = 20
const HIDDEN_FPS = 4
/** At most this often a frame goes to the panel. */
const FRAME_EVERY_MS = 66

/**
 * @typedef {{ id: string, win: BrowserWindow, contents: Electron.WebContents, owner?: string, refs: Map<string, number>, enabled?: Promise<void>, lastFrame: number, pendingFrame?: ReturnType<typeof setTimeout> }} Tab
 */

export class AgentBrowser extends EventEmitter {
  /** @type {Map<string, Tab>} */
  #tabs = new Map()
  /** session id → the tab the agent of that session works in. */
  #current = new Map()
  /** The tab the panel shows. */
  #shown = /** @type {string | undefined} */ (undefined)
  /** The panel's size while it is on screen. */
  #panel = /** @type {{ width: number, height: number } | undefined} */ (undefined)
  #seq = 0
  /** When an agent last acted, so the panel can come up. */
  #agentAt = 0
  #session

  /**
   * @param {object} deps
   * @param {() => readonly string[]} deps.blocked - origins the browser never opens (the app's own pages).
   * @param {(message: string) => void} [deps.log]
   */
  constructor(deps) {
    super()
    this.deps = deps
    this.#session = electronSession.fromPartition(PARTITION)
    this.#session.setPermissionRequestHandler((_contents, _permission, callback) => callback(false))
    this.#session.setPermissionCheckHandler(() => false)
    this.#session.on('will-download', event => event.preventDefault())
  }

  // ── what the UI and the bridge read ──

  /** Is this one of the browser's own (offscreen) windows? */
  owns(window) {
    for (const tab of this.#tabs.values()) if (tab.win === window) return true
    return false
  }

  state() {
    return {
      tabs: [...this.#tabs.values()].map(tab => ({
        id: tab.id,
        title: tab.contents.getTitle(),
        url: tab.contents.getURL(),
        loading: tab.contents.isLoading(),
        canGoBack: tab.contents.navigationHistory.canGoBack(),
        canGoForward: tab.contents.navigationHistory.canGoForward(),
        ...(tab.owner === undefined ? {} : { owner: tab.owner }),
      })),
      shown: this.#shown ?? null,
      agentAt: this.#agentAt,
    }
  }

  #changed() {
    this.emit('state', this.state())
  }

  // ── tabs ──

  /** @returns {Tab} */
  #open(owner) {
    if (this.#tabs.size >= MAX_TABS) throw new Error(`内置浏览器最多开 ${MAX_TABS} 个标签页，先用 browser_tabs 关掉不用的`)
    const id = `t${++this.#seq}`
    const size = this.#panel ?? DEFAULT_SIZE
    const win = new BrowserWindow({
      show: false,
      width: size.width,
      height: size.height,
      useContentSize: true,
      frame: false,
      skipTaskbar: true,
      backgroundColor: '#ffffff',
      webPreferences: {
        offscreen: true,
        session: this.#session,
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webSecurity: true,
        backgroundThrottling: false,
        spellcheck: false,
      },
    })
    const contents = win.webContents
    contents.setFrameRate(HIDDEN_FPS)
    /** @type {Tab} */
    const tab = { id, win, contents, refs: new Map(), lastFrame: 0, ...(owner === undefined ? {} : { owner }) }
    contents.debugger.attach('1.3')
    contents.on('paint', (_event, _dirty, image) => this.#frame(tab, image))
    // A page opening a window: a tab here, when the address may be opened.
    contents.setWindowOpenHandler(({ url }) => {
      try {
        const target = checkUrl(url, this.deps.blocked())
        queueMicrotask(() => { void this.navigate({ ...(owner === undefined ? {} : { session: owner }), url: target, newTab: true }).catch(() => {}) })
      } catch { /* not a web page: nothing */ }
      return { action: 'deny' }
    })
    const keepOut = (event, url) => {
      try { checkUrl(url, this.deps.blocked()) } catch { event.preventDefault() }
    }
    contents.on('will-navigate', keepOut)
    contents.on('will-redirect', keepOut)
    for (const name of ['page-title-updated', 'did-navigate', 'did-navigate-in-page', 'did-start-loading', 'did-stop-loading', 'render-process-gone']) contents.on(name, () => this.#changed())
    this.#tabs.set(id, tab)
    if (owner !== undefined) this.#current.set(owner, id)
    this.#shown = id
    this.#fit()
    this.#changed()
    return tab
  }

  /**
   * A DevTools command to the tab's page. The domains are turned on at the
   * first one: a command sent before the tab has loaded anything never answers.
   */
  async #cdp(tab, method, params = {}) {
    const commands = tab.contents.debugger
    if (tab.enabled === undefined) {
      tab.enabled = (async () => {
        await commands.sendCommand('DOM.enable')
        await commands.sendCommand('Accessibility.enable')
      })()
      tab.enabled.catch(() => { tab.enabled = undefined })
    }
    await tab.enabled
    return commands.sendCommand(method, params)
  }

  /** The tab a session's agent works in (or the one on screen). @throws Error when there is none. */
  #tabFor(session, tabId) {
    const id = tabId ?? (session === undefined ? this.#shown : this.#current.get(session) ?? this.#shown)
    const tab = id === undefined ? undefined : this.#tabs.get(id)
    if (tab === undefined) throw new Error(tabId === undefined ? '内置浏览器还没有打开网页：先用 browser_navigate 打开一个' : `没有这个标签页：${tabId}（browser_tabs 可查）`)
    return tab
  }

  close(tabId) {
    const tab = this.#tabs.get(tabId)
    if (tab === undefined) return
    this.#tabs.delete(tabId)
    for (const [owner, id] of this.#current) if (id === tabId) this.#current.delete(owner)
    clearTimeout(tab.pendingFrame)
    try { tab.contents.debugger.detach() } catch { /* not attached */ }
    tab.win.destroy()
    if (this.#shown === tabId) this.#shown = [...this.#tabs.keys()].at(-1)
    this.#fit()
    this.#changed()
  }

  closeAll() {
    for (const id of [...this.#tabs.keys()]) this.close(id)
  }

  // ── the panel ──

  /** The panel is on screen at this size (CSS pixels), or it is not (undefined). */
  show(size) {
    this.#panel = size === undefined || size === null || size.width < 50 || size.height < 50
      ? undefined
      : { width: Math.round(size.width), height: Math.round(size.height) }
    this.#fit()
  }

  select(tabId) {
    if (!this.#tabs.has(tabId)) throw new Error(`没有这个标签页：${tabId}`)
    this.#shown = tabId
    this.#fit()
    this.#changed()
  }

  /** The shown tab at the panel's size and drawing fast; the others slow. */
  #fit() {
    for (const tab of this.#tabs.values()) {
      const onScreen = tab.id === this.#shown && this.#panel !== undefined
      if (onScreen) {
        const [width, height] = tab.win.getContentSize()
        if (width !== this.#panel.width || height !== this.#panel.height) tab.win.setContentSize(this.#panel.width, this.#panel.height)
      }
      tab.contents.setFrameRate(onScreen ? SHOWN_FPS : HIDDEN_FPS)
      if (onScreen) tab.contents.invalidate()
    }
  }

  /** A frame of the tab on screen goes to the panel, at most every FRAME_EVERY_MS. */
  #frame(tab, image) {
    if (tab.id !== this.#shown || this.#panel === undefined || this.listenerCount('frame') === 0) return
    const send = () => {
      tab.pendingFrame = undefined
      tab.lastFrame = Date.now()
      const latest = image
      const size = latest.getSize()
      this.emit('frame', { tab: tab.id, width: size.width, height: size.height, data: latest.toJPEG(80) })
    }
    const wait = tab.lastFrame + FRAME_EVERY_MS - Date.now()
    if (wait <= 0) return send()
    // A newer frame replaces the one waiting.
    clearTimeout(tab.pendingFrame)
    tab.pendingFrame = setTimeout(send, wait)
  }

  /**
   * The user's mouse and keys in the panel, in page coordinates
   * (Electron's sendInputEvent shapes: mouseDown, mouseUp, mouseMove,
   * mouseWheel, keyDown, keyUp, char).
   */
  input(event) {
    const tab = this.#shown === undefined ? undefined : this.#tabs.get(this.#shown)
    if (tab === undefined || typeof event !== 'object' || event === null) return
    const allowed = ['mouseDown', 'mouseUp', 'mouseMove', 'mouseWheel', 'mouseEnter', 'mouseLeave', 'keyDown', 'keyUp', 'char']
    if (!allowed.includes(event.type)) return
    tab.contents.sendInputEvent(event)
  }

  /** Text the user typed (an input method's result included) into the page's focused field. */
  async insertText(text) {
    const tab = this.#shown === undefined ? undefined : this.#tabs.get(this.#shown)
    if (tab === undefined || typeof text !== 'string' || text === '') return
    await this.#cdp(tab, 'Input.insertText', { text })
  }

  // ── what the agent (or the user's toolbar) does ──

  #acted(session) {
    if (session === undefined) return
    this.#agentAt = Date.now()
    const id = this.#current.get(session)
    if (id !== undefined) this.#shown = id
    this.#fit()
    this.#changed()
  }

  /** Wait for the page to finish loading (or the time to run out), then a moment for scripts to draw. */
  async #settle(tab, timeoutMs = LOAD_TIMEOUT_MS) {
    const contents = tab.contents
    if (contents.isLoading()) {
      await new Promise(resolve => {
        const timer = setTimeout(done, timeoutMs)
        function done() { clearTimeout(timer); contents.off('did-stop-loading', done); resolve(undefined) }
        contents.on('did-stop-loading', done)
      })
    }
    await new Promise(resolve => setTimeout(resolve, 300))
  }

  /** What every action answers: where the page is now and what it shows. */
  async #page(tab, maxChars = ACTION_SNAPSHOT_CHARS) {
    const snapshot = await this.#snapshotOf(tab, maxChars)
    return { tab: tab.id, url: tab.contents.getURL(), title: tab.contents.getTitle(), loading: tab.contents.isLoading(), snapshot: snapshot.text }
  }

  async #snapshotOf(tab, maxChars) {
    const { nodes } = await this.#cdp(tab, 'Accessibility.getFullAXTree')
    const formatted = formatAxTree(nodes, { maxChars })
    tab.refs = formatted.refs
    return formatted
  }

  /**
   * Open an address (in the session's tab, or a new one), or go back, forward, reload.
   * @param {{ session?: string, url?: string, action?: 'back' | 'forward' | 'reload', newTab?: boolean, tab?: string }} p
   */
  async navigate(p) {
    let tab
    if (p.url !== undefined) {
      const url = checkUrl(p.url, this.deps.blocked())
      const own = p.tab !== undefined ? this.#tabFor(p.session, p.tab)
        : p.session === undefined ? (p.newTab === true ? undefined : this.#tabs.get(this.#shown ?? ''))
        : this.#tabs.get(this.#current.get(p.session) ?? '')
      tab = p.newTab === true || own === undefined ? this.#open(p.session) : own
      if (p.session !== undefined) this.#current.set(p.session, tab.id)
      this.#acted(p.session)
      try {
        await tab.contents.loadURL(url)
      } catch (error) {
        // A page that redirects or is replaced while loading rejects with ERR_ABORTED; the page that came instead is the answer.
        const code = /** @type {{ code?: string }} */ (error).code
        if (code !== 'ERR_ABORTED') throw new Error(`打不开 ${url}：${error instanceof Error ? error.message : String(error)}`)
      }
    } else {
      tab = this.#tabFor(p.session, p.tab)
      const history = tab.contents.navigationHistory
      if (p.action === 'back') { if (!history.canGoBack()) throw new Error('没有上一页'); history.goBack() }
      else if (p.action === 'forward') { if (!history.canGoForward()) throw new Error('没有下一页'); history.goForward() }
      else if (p.action === 'reload') tab.contents.reload()
      else throw new Error('要给 url，或 action（back / forward / reload）')
      this.#acted(p.session)
    }
    await this.#settle(tab)
    return this.#page(tab)
  }

  /** The page as text, with refs. */
  async snapshot(p) {
    const tab = this.#tabFor(p.session, p.tab)
    return this.#page(tab, Math.min(Math.max(p.maxChars ?? 20_000, 2_000), 60_000))
  }

  /** The middle of an element (scrolled into view), in the page's viewport. */
  async #pointOf(tab, ref) {
    const backendNodeId = tab.refs.get(ref)
    if (backendNodeId === undefined) throw new Error(`没有 ${ref}：refs 只在最近一次的页面内容里有效，先用 browser_snapshot 看现在的页面`)
    try {
      await this.#cdp(tab, 'DOM.scrollIntoViewIfNeeded', { backendNodeId })
      const { quads } = await this.#cdp(tab, 'DOM.getContentQuads', { backendNodeId })
      const quad = quads?.[0]
      if (quad === undefined) throw new Error('hidden')
      const xs = [quad[0], quad[2], quad[4], quad[6]]
      const ys = [quad[1], quad[3], quad[5], quad[7]]
      return { backendNodeId, x: xs.reduce((a, b) => a + b) / 4, y: ys.reduce((a, b) => a + b) / 4 }
    } catch {
      throw new Error(`${ref} 现在看不见（被隐藏或已经不在页面上）：先用 browser_snapshot 看现在的页面`)
    }
  }

  async #mouse(tab, x, y, clickCount = 1) {
    const at = { x, y, button: 'left', clickCount }
    await this.#cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseMoved', x, y })
    await this.#cdp(tab, 'Input.dispatchMouseEvent', { type: 'mousePressed', ...at })
    await this.#cdp(tab, 'Input.dispatchMouseEvent', { type: 'mouseReleased', ...at })
  }

  /** @param {{ session?: string, tab?: string, ref?: string, x?: number, y?: number, double?: boolean }} p */
  async click(p) {
    const tab = this.#tabFor(p.session, p.tab)
    this.#acted(p.session)
    const point = p.ref !== undefined ? await this.#pointOf(tab, p.ref) : p.x !== undefined && p.y !== undefined ? { x: p.x, y: p.y } : undefined
    if (point === undefined) throw new Error('要给 ref（页面内容里的 [ref=…]），或截图上的 x、y')
    await this.#mouse(tab, point.x, point.y, p.double === true ? 2 : 1)
    await this.#settle(tab, 8_000)
    return this.#page(tab)
  }

  /** @param {{ session?: string, tab?: string, ref: string, text: string, clear?: boolean, submit?: boolean }} p */
  async type(p) {
    const tab = this.#tabFor(p.session, p.tab)
    this.#acted(p.session)
    const { backendNodeId, x, y } = await this.#pointOf(tab, p.ref)
    await this.#mouse(tab, x, y)
    await this.#cdp(tab, 'DOM.focus', { backendNodeId }).catch(() => {})
    if (p.clear !== false) {
      const { object } = await this.#cdp(tab, 'DOM.resolveNode', { backendNodeId })
      await this.#cdp(tab, 'Runtime.callFunctionOn', {
        objectId: object.objectId,
        functionDeclaration: 'function () { if ("value" in this) { this.value = ""; this.dispatchEvent(new Event("input", { bubbles: true })) } else if (this.isContentEditable) { this.textContent = "" } }',
      })
    }
    await this.#cdp(tab, 'Input.insertText', { text: p.text })
    if (p.submit === true) await this.#key(tab, 'Enter')
    await this.#settle(tab, p.submit === true ? LOAD_TIMEOUT_MS : 2_000)
    return this.#page(tab)
  }

  async #key(tab, combo) {
    const k = parseKey(combo)
    const base = { modifiers: k.modifiers, key: k.key, code: k.code, windowsVirtualKeyCode: k.keyCode, nativeVirtualKeyCode: k.keyCode }
    await this.#cdp(tab, 'Input.dispatchKeyEvent', { type: k.text === undefined ? 'rawKeyDown' : 'keyDown', ...base, ...(k.text === undefined ? {} : { text: k.text, unmodifiedText: k.text }) })
    await this.#cdp(tab, 'Input.dispatchKeyEvent', { type: 'keyUp', ...base })
  }

  /** @param {{ session?: string, tab?: string, key: string }} p */
  async press(p) {
    const tab = this.#tabFor(p.session, p.tab)
    this.#acted(p.session)
    await this.#key(tab, p.key)
    await this.#settle(tab, 8_000)
    return this.#page(tab)
  }

  /** @param {{ session?: string, tab?: string, direction?: 'up' | 'down' | 'left' | 'right', amount?: number, ref?: string }} p */
  async scroll(p) {
    const tab = this.#tabFor(p.session, p.tab)
    this.#acted(p.session)
    if (p.ref !== undefined && p.direction === undefined) {
      await this.#pointOf(tab, p.ref)
    } else {
      const [width, height] = tab.win.getContentSize()
      const at = p.ref !== undefined ? await this.#pointOf(tab, p.ref) : { x: width / 2, y: height / 2 }
      const step = Math.min(Math.max(p.amount ?? 600, 50), 5000)
      const dir = p.direction ?? 'down'
      await this.#cdp(tab, 'Input.dispatchMouseEvent', {
        type: 'mouseWheel', x: at.x, y: at.y,
        deltaX: dir === 'left' ? -step : dir === 'right' ? step : 0,
        deltaY: dir === 'up' ? -step : dir === 'down' ? step : 0,
      })
    }
    // Smooth scrolling takes a moment.
    await new Promise(resolve => setTimeout(resolve, 500))
    return this.#page(tab)
  }

  /** @returns {Promise<{ tab: string, url: string, title: string, width: number, height: number, png: Buffer }>} */
  async screenshot(p) {
    const tab = this.#tabFor(p.session, p.tab)
    const image = await tab.contents.capturePage()
    const size = image.getSize()
    return { tab: tab.id, url: tab.contents.getURL(), title: tab.contents.getTitle(), width: size.width, height: size.height, png: image.toPNG() }
  }

  /** The page's text, for reading an article without its markup. */
  async text(p) {
    const tab = this.#tabFor(p.session, p.tab)
    const { result } = await this.#cdp(tab, 'Runtime.evaluate', { expression: `(() => {
      const urls = new Set()
      const add = raw => {
        if (!raw || urls.size >= 8) return
        try {
          const u = new URL(raw, document.baseURI)
          if (u.protocol === 'https:' && !u.username && !u.password && u.href.length <= 2048) urls.add(u.href)
        } catch {}
      }
      for (const meta of document.querySelectorAll('meta[property="og:image"], meta[name="twitter:image"]')) add(meta.content)
      for (const img of document.querySelectorAll('article img, main img')) {
        if (img.naturalWidth >= 200 && img.naturalHeight >= 100) add(img.currentSrc || img.src)
        if (urls.size >= 8) break
      }
      return { text: document.body?.innerText ?? '', images: [...urls] }
    })()`, returnByValue: true })
    const all = String(result?.value?.text ?? '')
    const max = Math.min(Math.max(p.maxChars ?? 20_000, 1_000), 100_000)
    return { tab: tab.id, url: tab.contents.getURL(), title: tab.contents.getTitle(), text: all.slice(0, max), images: result?.value?.images ?? [], ...(all.length > max ? { truncated: all.length - max } : {}) }
  }

  /** @param {{ session?: string, action: 'list' | 'select' | 'close', tab?: string }} p */
  async tabs(p) {
    if (p.action === 'select') {
      const tab = this.#tabFor(p.session, p.tab)
      if (p.session !== undefined) this.#current.set(p.session, tab.id)
      this.select(tab.id)
      return this.#page(tab)
    }
    if (p.action === 'close') this.close(this.#tabFor(p.session, p.tab).id)
    const mine = p.session === undefined ? undefined : this.#current.get(p.session)
    return { tabs: this.state().tabs.map(t => ({ id: t.id, title: t.title, url: t.url, ...(t.id === mine ? { yours: true } : {}) })) }
  }

}
