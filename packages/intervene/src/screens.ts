/**
 * Screens the agent can look at and act on, behind one interface:
 *
 *   emulator   ADB on the emulator (`screencap`, `input`); does not take the mouse
 *   desktop    the whole Windows desktop (the helper)
 *   window     one window, found by title (captured even when covered)
 *
 * Every screenshot comes with a frame: where its pixel (0, 0) is on the
 * device and how much it was shrunk. Actions take coordinates in the latest
 * screenshot of that target and are mapped back here, so the model never
 * deals with DPI, window offsets or scaling.
 */
import { ownedBy, runWindows, toRaise, unseen, type RunOwner, type RunWindow } from './hidden.ts'
import { fitPng } from './png.ts'
import type { WinHelper, WinWindow } from './winhelper.ts'

export type TargetKind = 'emulator' | 'desktop' | 'window'

export interface Frame {
  readonly target: TargetKind
  readonly label: string
  /** The lock an action needs: `desktop` or `adb:<address>`. */
  readonly lockKey: string
  readonly originX: number
  readonly originY: number
  /** Screenshot pixels per device pixel (≤ 1). */
  readonly scale: number
  readonly width: number
  readonly height: number
  readonly address?: string
  readonly hwnd?: number
}

export interface Shot {
  readonly png: Buffer
  readonly frame: Frame
}

/** Device coordinates for a point in the screenshot. @throws Error when it lies outside the image. */
export function toDevice(frame: Frame, x: number, y: number): { x: number; y: number } {
  if (!Number.isFinite(x) || !Number.isFinite(y) || x < 0 || y < 0 || x > frame.width || y > frame.height) {
    throw new Error(`坐标 (${x}, ${y}) 不在截图里（截图大小 ${frame.width}×${frame.height}）`)
  }
  return { x: Math.round(frame.originX + x / frame.scale), y: Math.round(frame.originY + y / frame.scale) }
}

/** What the screens need from the emulator plugin. */
export interface AdbPort {
  screencap?(address: string, signal: AbortSignal): Promise<Buffer>
  shell?(address: string, args: readonly string[], timeoutMs?: number): Promise<string>
  expectedAddress?(): Promise<string | undefined>
}

const ANDROID_KEYS: Readonly<Record<string, number>> = {
  back: 4, home: 3, enter: 66, return: 66, esc: 111, escape: 111, tab: 61, backspace: 67, del: 67, delete: 112,
  up: 19, down: 20, left: 21, right: 22, menu: 82, space: 62, recent: 187, app_switch: 187, power: 26, volume_up: 24, volume_down: 25,
}

export class Screens {
  readonly #adb: () => AdbPort | undefined
  readonly #win: WinHelper
  readonly #maxEdge: () => number

  constructor(options: { adb: () => AdbPort | undefined; win: WinHelper; maxEdge: () => number }) {
    this.#adb = options.adb
    this.#win = options.win
    this.#maxEdge = options.maxEdge
  }

  async capture(target: TargetKind, options: { address?: string | undefined; window?: string | undefined; signal: AbortSignal }): Promise<Shot> {
    if (target === 'emulator') {
      const adb = this.#adb()
      const address = options.address ?? await adb?.expectedAddress?.()
      if (adb?.screencap === undefined || address === undefined) throw new Error('没有可用的模拟器（模拟器插件没有加载，或还没有设置模拟器）')
      const fitted = fitPng(await adb.screencap(address, options.signal), this.#maxEdge())
      return { png: fitted.png, frame: { target, label: `模拟器 ${address}`, lockKey: `adb:${address}`, originX: 0, originY: 0, scale: fitted.scale, width: fitted.width, height: fitted.height, address } }
    }
    let hwnd = 0
    let label = '桌面'
    if (target === 'window') {
      const found = await this.findWindow(options.window ?? '')
      hwnd = found.hwnd
      label = `窗口「${found.title}」`
    }
    const raw = await this.#win.capture(hwnd)
    const fitted = fitPng(raw.png, this.#maxEdge())
    return { png: fitted.png, frame: { target, label, lockKey: 'desktop', originX: raw.x, originY: raw.y, scale: fitted.scale, width: fitted.width, height: fitted.height, ...(hwnd === 0 ? {} : { hwnd }) } }
  }

  /** @throws Error when no visible window's title contains `title`, listing what there is. */
  async findWindow(title: string): Promise<WinWindow> {
    const windows = await this.#win.windows()
    const wanted = title.trim().toLowerCase()
    const found = windows.find(w => w.title.toLowerCase() === wanted) ?? windows.find(w => wanted !== '' && w.title.toLowerCase().includes(wanted))
    if (found === undefined) throw new Error(`没有标题包含「${title}」的窗口。现有窗口：${windows.slice(0, 15).map(w => w.title).join('、') || '（没有）'}`)
    return found
  }

  windows(): Promise<WinWindow[]> {
    return this.#win.windows()
  }

  /** A run's windows (its processes' and its game's), topmost first, and which are covered. */
  async runWindows(owner: { pid: number | undefined; processes: readonly string[] }): Promise<RunWindow[]> {
    const pids = new Set(owner.pid === undefined ? [] : await this.#win.tree(owner.pid).catch(() => [owner.pid!]))
    const own: RunOwner = { pids, processes: owner.processes }
    return runWindows(await this.#win.windows(), ownedBy(own))
  }

  /**
   * Bring a run's windows in front of the others when one of them is out of
   * sight: an error box behind another window is then on the screen, and taps
   * at its place land on it. Needs the run not paused (a paused window moves
   * only once it runs again).
   * @returns the run's windows now; `raised`: titles brought into sight; `hidden`: still out of sight (behind an always-on-top window, or one run as administrator).
   */
  async reveal(owner: { pid: number | undefined; processes: readonly string[] }): Promise<{ windows: RunWindow[]; raised: string[]; hidden: string[] }> {
    const before = await this.runWindows(owner)
    const raise = toRaise(before)
    let after = before
    if (raise.length > 0) {
      await this.#win.raise(raise.map(w => w.hwnd))
      after = await this.runWindows(owner)
    }
    const out = new Set(after.filter(unseen).map(s => s.window.hwnd))
    return {
      windows: after,
      raised: before.filter(s => unseen(s) && !out.has(s.window.hwnd)).map(s => s.window.title),
      hidden: after.filter(s => out.has(s.window.hwnd)).map(s => s.window.title),
    }
  }

  /** The whole desktop (raw PNG) after `reveal`. */
  async captureFor(owner: { pid: number | undefined; processes: readonly string[] }): Promise<{ png: Buffer; raised: string[]; hidden: string[] }> {
    const { raised, hidden } = await this.reveal(owner)
    return { png: (await this.#win.capture(0)).png, raised, hidden }
  }

  async focus(title: string): Promise<WinWindow> {
    const found = await this.findWindow(title)
    await this.#win.focus(found.hwnd)
    return found
  }

  /** @throws Error when the window would not take the keyboard (keys would go elsewhere). */
  async #focusFor(frame: Frame, keyboard: boolean): Promise<void> {
    if (frame.hwnd === undefined) return
    const focused = await this.#win.focus(frame.hwnd)
    if (keyboard && !focused) throw new Error(`没能把${frame.label}切到最前（按键会落到别的窗口上）；先点一下这个窗口再试`)
  }

  async tap(frame: Frame, x: number, y: number, options: { button?: 'left' | 'right'; double?: boolean } = {}): Promise<void> {
    const at = toDevice(frame, x, y)
    if (frame.target === 'emulator') {
      await this.#shell(frame, ['input', 'tap', String(at.x), String(at.y)])
      if (options.double === true) await this.#shell(frame, ['input', 'tap', String(at.x), String(at.y)])
      return
    }
    await this.#focusFor(frame, false)
    await this.#win.call('click', { x: at.x, y: at.y, button: options.button ?? 'left', double: options.double === true })
  }

  async swipe(frame: Frame, x1: number, y1: number, x2: number, y2: number, ms: number): Promise<void> {
    const a = toDevice(frame, x1, y1)
    const b = toDevice(frame, x2, y2)
    const duration = Math.max(50, Math.min(5000, Math.round(ms)))
    if (frame.target === 'emulator') return void await this.#shell(frame, ['input', 'swipe', String(a.x), String(a.y), String(b.x), String(b.y), String(duration)])
    await this.#focusFor(frame, false)
    await this.#win.call('drag', { x1: a.x, y1: a.y, x2: b.x, y2: b.y, ms: duration }, duration + 10_000)
  }

  async scroll(frame: Frame, x: number, y: number, notches: number): Promise<void> {
    const at = toDevice(frame, x, y)
    if (frame.target === 'emulator') {
      // A scroll is a short swipe on a phone: down the page = finger moving up.
      const dy = Math.round(-notches * 120 / frame.scale)
      return void await this.#shell(frame, ['input', 'swipe', String(at.x), String(at.y), String(at.x), String(Math.max(0, at.y + dy)), '300'])
    }
    await this.#win.call('scroll', { x: at.x, y: at.y, notches: Math.round(notches) })
  }

  async key(frame: Frame, key: string): Promise<void> {
    if (frame.target === 'emulator') {
      const code = ANDROID_KEYS[key.trim().toLowerCase()]
      if (code === undefined) throw new Error(`模拟器上能按的键：${Object.keys(ANDROID_KEYS).join('、')}`)
      return void await this.#shell(frame, ['input', 'keyevent', String(code)])
    }
    await this.#focusFor(frame, true)
    await this.#win.call('keys', { keys: key })
  }

  async type(frame: Frame, text: string): Promise<void> {
    if (frame.target === 'emulator') {
      if (!/^[\x20-\x7e]*$/.test(text)) throw new Error('模拟器里只能直接输入英文、数字和符号；中文请让用户输入，或点选候选项')
      // `input text` takes %s for spaces; quote everything else for the device shell.
      return void await this.#shell(frame, ['input', 'text', `'${text.replace(/ /g, '%s').replace(/'/g, `'\\''`)}'`])
    }
    await this.#focusFor(frame, true)
    await this.#win.call('type', { text })
  }

  async #shell(frame: Frame, args: string[]): Promise<void> {
    const adb = this.#adb()
    if (adb?.shell === undefined || frame.address === undefined) throw new Error('模拟器插件没有加载')
    await adb.shell(frame.address, args)
  }
}
