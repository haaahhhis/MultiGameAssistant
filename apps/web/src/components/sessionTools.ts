import { createContext } from 'react'

/**
 * The conversation's right sidebar (SidePanels.tsx), where its sub-tasks,
 * commands and browser open; null where there is none, and the chat lists
 * its sub-tasks above itself and opens one beside itself.
 */
export const SideBar = createContext<{ openTask(task: { id: string; label: string }): void } | null>(null)
