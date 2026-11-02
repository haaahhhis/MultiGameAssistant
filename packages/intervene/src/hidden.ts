/**
 * A run's windows that a desktop screenshot misses: an error box behind the
 * app's own window or a browser, or minimized. Whose windows they are: the
 * script's process tree, its game's executable, and Windows' own "stopped
 * working" boxes (WerFault, not a child of anything the run started).
 *
 * Windows come topmost first (z-order), as the helper lists them.
 */
import type { WinWindow } from './winhelper.ts'

export interface RunWindow {
  readonly window: WinWindow
  /** At least a quarter of it is under windows above it. */
  readonly covered: boolean
  /** The same, counting only windows that are not the run's. */
  readonly coveredByOthers: boolean
}

/** Whose windows count as the run's. */
export interface RunOwner {
  readonly pids: ReadonlySet<number>
  /** Executable names (`StarRail.exe`), any case. */
  readonly processes: readonly string[]
}

const COVERED = 0.25
const GRID = 10

/** Share of `target` (0–1) under the windows in `above`, sampled on a grid. */
export function coveredShare(target: WinWindow, above: readonly WinWindow[]): number {
  if (target.width <= 0 || target.height <= 0) return 0
  const blockers = above.filter(w => !w.minimized && w.transparent !== true && w.width > 0 && w.height > 0)
  if (blockers.length === 0) return 0
  let hidden = 0
  for (let i = 0; i < GRID; i++) {
    for (let j = 0; j < GRID; j++) {
      const x = target.x + ((i + 0.5) * target.width) / GRID
      const y = target.y + ((j + 0.5) * target.height) / GRID
      if (blockers.some(b => x >= b.x && x < b.x + b.width && y >= b.y && y < b.y + b.height)) hidden++
    }
  }
  return hidden / (GRID * GRID)
}

export function ownedBy(owner: RunOwner): (window: WinWindow) => boolean {
  const games = new Set(owner.processes.map(p => p.toLowerCase()))
  return window => {
    const exe = `${(window.process ?? '').toLowerCase()}.exe`
    return owner.pids.has(window.pid) || games.has(exe) || (window.dialog === true && exe === 'werfault.exe')
  }
}

/** The run's windows, topmost first, and whether each is covered. */
export function runWindows(windows: readonly WinWindow[], owns: (window: WinWindow) => boolean): RunWindow[] {
  return windows.flatMap((window, i) => {
    if (!owns(window)) return []
    const above = windows.slice(0, i)
    return [{
      window,
      covered: !window.minimized && coveredShare(window, above) >= COVERED,
      coveredByOthers: !window.minimized && coveredShare(window, above.filter(w => !owns(w))) >= COVERED,
    }]
  })
}

/**
 * Out of sight in a way that matters: a dialog under any window (even its own
 * app's main window), another window under someone else's, or a minimized
 * dialog (an error box nobody restores is never seen).
 */
export function unseen(state: RunWindow): boolean {
  if (state.window.minimized) return state.window.dialog === true
  return state.window.dialog === true ? state.covered : state.coveredByOthers
}

/**
 * What to bring forward, topmost first: when any of the run's windows is out
 * of sight, all of them that are on the screen (and its minimized dialogs),
 * in their order among themselves (a game raised alone would cover its
 * script's window), with the dialogs out of sight on top.
 */
export function toRaise(states: readonly RunWindow[]): WinWindow[] {
  if (!states.some(unseen)) return []
  const shown = states.filter(s => !s.window.minimized || s.window.dialog === true)
  const dialogs = shown.filter(s => s.window.dialog === true && unseen(s))
  return [...dialogs, ...shown.filter(s => !dialogs.includes(s))].map(s => s.window)
}
