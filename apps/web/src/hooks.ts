import { useEffect, useMemo, useState, useSyncExternalStore } from 'react'
import type { SessionHandle, Store, AdgClient } from '@adg/client-core'
import type { CredentialInfo, ModelCatalog } from '@adg/protocol'
import { enabledPages, enabledSessionViews, enabledSettingsPages, subscribePlugins } from './plugins.ts'

/** Read a client-core store and re-render on change. */
export function useStore<T>(store: Store<T>): T {
  return useSyncExternalStore(store.subscribe, store.get, store.get)
}

/**
 * Hold a ref-counted session handle while mounted. Acquisition happens in the
 * effect so every acquire is paired with exactly one release.
 * @returns null until the first effect has run.
 */
export function useSessionHandle(client: AdgClient, sessionId: string): SessionHandle | null {
  const [handle, setHandle] = useState<SessionHandle | null>(null)
  useEffect(() => {
    const acquired = client.openSession(sessionId)
    setHandle(acquired)
    return () => client.release(acquired)
  }, [client, sessionId])
  return handle !== null && handle.id === sessionId ? handle : null
}

/** Session tabs contributed by plugins whose capabilities are present. */
export function useSessionViews(client: AdgClient) {
  const capabilities = useStore(client.capabilities)
  const revision = usePluginRevision()
  return useMemo(() => enabledSessionViews(capabilities), [capabilities, revision])
}

/** Settings pages contributed by plugins whose capabilities are present. */
export function useSettingsPages(client: AdgClient) {
  const capabilities = useStore(client.capabilities)
  const revision = usePluginRevision()
  return useMemo(() => enabledSettingsPages(capabilities), [capabilities, revision])
}

/** Top-level pages contributed by plugins whose capabilities are present. */
export function usePages(client: AdgClient) {
  const capabilities = useStore(client.capabilities)
  const revision = usePluginRevision()
  return useMemo(() => enabledPages(capabilities), [capabilities, revision])
}

function usePluginRevision(): number {
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribePlugins(() => setRevision(r => r + 1)), [])
  return revision
}

/**
 * Describe credentials and keep the answer fresh across saves, external edits
 * and reconnects. `null` until the first answer; `error` when unavailable.
 */
export function useCredentials(client: AdgClient, refs: readonly string[]) {
  const revision = useStore(client.credentialRevision)
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const key = refs.join('\n')
  const [state, setState] = useState<{ items: Readonly<Record<string, CredentialInfo>> | null; error: string | null }>({ items: null, error: null })
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('credentials') || key === '') return
    let live = true
    client.describeCredentials(key.split('\n'))
      .then(items => { if (live) setState({ items, error: null }) })
      .catch(error => { if (live) setState(s => ({ ...s, error: error instanceof Error ? error.message : String(error) })) })
    return () => { live = false }
  }, [client, key, revision, status.state, capabilities])
  return state
}

/**
 * The host's model catalog, re-read after reconnects and whenever a key or a
 * provider route changes (either can add or remove models).
 */
export function useModelCatalog(client: AdgClient) {
  const credentials = useStore(client.credentialRevision)
  const providers = useStore(client.providersRevision)
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const [state, setState] = useState<{ catalog: ModelCatalog | null; error: string | null }>({ catalog: null, error: null })
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('models')) return
    let live = true
    client.modelCatalog()
      .then(catalog => { if (live) setState({ catalog, error: null }) })
      .catch(error => { if (live) setState(s => ({ ...s, error: error instanceof Error ? error.message : String(error) })) })
    return () => { live = false }
  }, [client, credentials, providers, status.state, capabilities])
  return state
}

/** Re-render every `ms` (relative timestamps, running timers). */
export function useNow(ms: number): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms)
    return () => clearInterval(timer)
  }, [ms])
  return now
}

/** The permission mode (设置 → 权限), kept current; undefined when the host does not serve it. */
export function usePermissionMode(client: AdgClient): 'ask' | 'full' | undefined {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const [mode, setMode] = useState<'ask' | 'full' | undefined>(undefined)
  useEffect(() => client.connection.on('permissions/changed', state => setMode(state.mode)), [client])
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('permissions')) return
    let live = true
    client.connection.call('permissions/get', {}).then(state => { if (live) setMode(state.mode) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, capabilities])
  return mode
}
