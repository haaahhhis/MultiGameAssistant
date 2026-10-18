/**
 * UI plugin registry — the "assembly" seam on the UI side.
 *
 * A plugin declares the gateway capabilities it requires and the views it
 * contributes. The shell shows a view only when every required capability is
 * present in the current connection, so removing a host plugin hides its UI.
 */
import type { ComponentType } from 'react'
import type { SessionHandle, SessionState, AdgClient } from '@adg/client-core'
import type { IconName } from './components/Icons.tsx'

export interface SessionViewProps {
  readonly client: AdgClient
  readonly session: SessionHandle
  readonly state: SessionState
}

export interface SessionViewContribution {
  readonly id: string
  readonly title: string
  /** Lower comes first in the tab strip. */
  readonly order: number
  readonly component: ComponentType<SessionViewProps>
  /** Show the tab only for sessions this returns true for; always shown when absent. */
  readonly available?: (state: SessionState) => boolean
}

/** The views a session shows, given its state. */
export function viewsFor(views: readonly SessionViewContribution[], state: SessionState): SessionViewContribution[] {
  return views.filter(v => v.available?.(state) ?? true)
}

export interface SettingsPageContribution {
  readonly id: string
  readonly title: string
  readonly order: number
  readonly component: ComponentType<{ readonly client: AdgClient }>
}

export interface PageProps {
  readonly client: AdgClient
  readonly openSession: (sessionId: string) => void
  readonly openSettings: () => void
  /** Open another top-level page. */
  readonly openPage: (pageId: string) => void
}

/** A top-level page with its own entry in the navigation rail. */
export interface PageContribution {
  readonly id: string
  readonly title: string
  readonly icon: IconName
  readonly order: number
  readonly component: ComponentType<PageProps>
}

export interface UiPlugin {
  readonly id: string
  /** Shown on the plugin status page. */
  readonly title: string
  /** Plan milestone that delivers the host side, e.g. `M1`; shown while its capabilities are missing. */
  readonly milestone?: string
  /** Capability ids that must all be present (e.g. `sessions`, `chat`). */
  readonly requires: readonly string[]
  readonly sessionViews?: readonly SessionViewContribution[]
  readonly settingsPages?: readonly SettingsPageContribution[]
  readonly pages?: readonly PageContribution[]
}

const plugins = new Map<string, UiPlugin>()
const listeners = new Set<() => void>()

/** Register a plugin. @returns a disposer that unregisters it. */
export function registerPlugin(plugin: UiPlugin): () => void {
  if (plugins.has(plugin.id)) throw new Error(`UI plugin "${plugin.id}" is already registered`)
  plugins.set(plugin.id, plugin)
  for (const listener of listeners) listener()
  return () => {
    if (plugins.get(plugin.id) !== plugin) return
    plugins.delete(plugin.id)
    for (const listener of listeners) listener()
  }
}

export function subscribePlugins(listener: () => void): () => void {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** Views enabled for the given capability set, in tab order. */
export function enabledSessionViews(capabilities: ReadonlySet<string>): SessionViewContribution[] {
  return [...plugins.values()]
    .filter(p => p.requires.every(c => capabilities.has(c)))
    .flatMap(p => p.sessionViews ?? [])
    .sort((a, b) => a.order - b.order)
}

/** Settings pages enabled for the given capability set, in menu order. */
export function enabledSettingsPages(capabilities: ReadonlySet<string>): SettingsPageContribution[] {
  return [...plugins.values()]
    .filter(p => p.requires.every(c => capabilities.has(c)))
    .flatMap(p => p.settingsPages ?? [])
    .sort((a, b) => a.order - b.order)
}

/** Top-level pages enabled for the given capability set, in sidebar order. */
export function enabledPages(capabilities: ReadonlySet<string>): PageContribution[] {
  return [...plugins.values()]
    .filter(p => p.requires.every(c => capabilities.has(c)))
    .flatMap(p => p.pages ?? [])
    .sort((a, b) => a.order - b.order)
}

/** Every registered plugin with the capabilities it still misses, for the status page. */
export function pluginStatus(capabilities: ReadonlySet<string>): { plugin: UiPlugin; missing: string[] }[] {
  return [...plugins.values()].map(plugin => ({ plugin, missing: plugin.requires.filter(c => !capabilities.has(c)) }))
}
