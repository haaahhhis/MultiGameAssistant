import { createContext } from 'react'

/**
 * The rail's list under 游戏 and 助手, while a page of the top row is open:
 * the page puts its own list there (the games page, its games); null where
 * there is none, and the page keeps the list on itself.
 */
export const RailSlot = createContext<HTMLElement | null>(null)

/** Whether the rail is wide: a page's list there shows whole names. */
export const RailWide = createContext(false)
