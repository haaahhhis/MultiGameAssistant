import { createContext } from 'react'

/**
 * The place in a conversation's header, beside its 对话 / 轨迹 tabs, where the
 * view on screen puts its own controls (the chat's sub-task list); null where
 * there is no header (a sub-agent's conversation beside its parent's).
 */
export const SessionTools = createContext<HTMLElement | null>(null)
