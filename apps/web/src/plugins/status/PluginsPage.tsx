import { useEffect, useMemo, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { useStore } from '../../hooks.ts'
import { pluginStatus, subscribePlugins } from '../../plugins.ts'

/**
 * Which UI plugins are on, and for those that are off, the host capabilities
 * they still wait for. This is the capability seam made visible: a host plugin
 * that is missing or disabled in the profile shows up here, not as a broken page.
 */
export function PluginsPage({ client }: { client: AdgClient }) {
  const capabilities = useStore(client.capabilities)
  const server = useStore(client.connection.server)
  const [revision, setRevision] = useState(0)
  useEffect(() => subscribePlugins(() => setRevision(r => r + 1)), [])
  const rows = useMemo(() => pluginStatus(capabilities), [capabilities, revision])
  const enabled = rows.filter(r => r.missing.length === 0)
  const waiting = rows.filter(r => r.missing.length > 0)

  return (
    <div className="settings-page">
      <h2>插件状态</h2>
      <p>界面插件只在后端提供了它需要的能力时启用。后端少装一个插件，对应的界面就自动隐藏。</p>

      <section className="card">
        <h3>后端能力</h3>
        <p className="muted small">{server === null ? '尚未连接' : `${server.server.name} ${server.server.version}${server.server.dsh === undefined ? '' : ` · dsh ${server.server.dsh}`}`}</p>
        <div className="chip-row">
          {[...capabilities].sort().map(id => <span key={id} className="chip">{id}</span>)}
          {capabilities.size === 0 && <span className="muted small">无</span>}
        </div>
      </section>

      <section className="card">
        <h3>已启用（{enabled.length}）</h3>
        <ul className="plugin-list">
          {enabled.map(({ plugin }) => (
            <li key={plugin.id}>
              <span className="plugin-name">{plugin.title}</span>
              <span className="muted small">{plugin.requires.length === 0 ? '无需后端能力' : plugin.requires.join(' · ')}</span>
            </li>
          ))}
        </ul>
      </section>

      {waiting.length > 0 && (
        <section className="card">
          <h3>等待后端能力（{waiting.length}）</h3>
          <ul className="plugin-list">
            {waiting.map(({ plugin, missing }) => (
              <li key={plugin.id}>
                <span className="plugin-name">{plugin.title}{plugin.milestone !== undefined && <span className="chip subtle">{plugin.milestone}</span>}</span>
                <span className="muted small">缺少：{missing.join(' · ')}</span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  )
}
