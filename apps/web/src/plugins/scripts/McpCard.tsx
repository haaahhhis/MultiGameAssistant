import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { RequestResult, ScriptInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { errorText } from './data.ts'

type Offer = RequestResult<'scripts/mcp'>
type Probe = RequestResult<'scripts/mcp/probe'>

const TRANSPORT: Record<string, string> = { stdio: '本地程序', http: 'HTTP', sse: 'SSE' }

/**
 * MCP 与技能: what the script offers agents beyond its tasks — its MCP servers
 * (read from its own MCP config files and its pack), through which the agent
 * drives it directly, and the skills it ships, which can go into the skills library.
 * Shown only when it has either.
 */
export function McpCard({ client, script }: { client: AdgClient; script: ScriptInfo }) {
  const [offer, setOffer] = useState<Offer | null>(null)
  const [revision, setRevision] = useState(0)
  const [probes, setProbes] = useState<Record<string, Probe | 'busy'>>({})
  const [busy, setBusy] = useState<string | null>(null)
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null)

  useEffect(() => client.connection.on('skills/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => client.connection.on('packs/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    let live = true
    client.connection.call('scripts/mcp', { id: script.id })
      .then(data => { if (live) setOffer(data) })
      .catch(() => { if (live) setOffer(null) })
    return () => { live = false }
  }, [client, script.id, script.current, script.packId, revision])

  if (offer === null || (offer.servers.length === 0 && offer.skills.length === 0)) return null

  const probe = async (server: string) => {
    setProbes(p => ({ ...p, [server]: 'busy' }))
    try {
      const result = await client.connection.call('scripts/mcp/probe', { id: script.id, server })
      setProbes(p => ({ ...p, [server]: result }))
      setRevision(r => r + 1)
    } catch (e) {
      setProbes(p => ({ ...p, [server]: { ok: false, error: errorText(e) } }))
    }
  }

  const take = async (names?: string[]) => {
    setBusy(names?.[0] ?? '*')
    setMessage(null)
    try {
      const { imported, skipped } = await client.connection.call('scripts/skills/import', { id: script.id, ...(names === undefined ? {} : { names }) })
      const parts = [
        ...(imported.length === 0 ? [] : [`已放进技能库：${imported.map(i => i.name).join('、')}`]),
        ...skipped.map(s => `${s.skill} 没有导入：${s.reason}`),
      ]
      setMessage({ text: parts.join('；') || '没有可以导入的技能', error: imported.length === 0 })
      setRevision(r => r + 1)
    } catch (e) {
      setMessage({ text: errorText(e), error: true })
    } finally {
      setBusy(null)
    }
  }

  const waiting = offer.skills.filter(s => s.problem === undefined && (s.imported === undefined || (!s.imported.current && !s.imported.changed)))

  return (
    <section className="card script-mcp">
      <div className="card-head">
        <div>
          <h3>MCP 与技能</h3>
          <p className="muted small">
            {offer.servers.length > 0 ? '这个脚本自带 MCP 服务：agent 可以直接调用它的工具来操控脚本（查状态、只跑某一项、改设置），不只是运行整个任务。' : ''}
            {offer.skills.length > 0 ? '它还自带给 agent 的技能，放进技能库后，处理这个脚本时 agent 就会用上。' : ''}
          </p>
        </div>
        {waiting.length > 1 && (
          <div className="key-actions">
            <button className="small-button" disabled={busy !== null} onClick={() => void take()}><Icon name="download" />全部放进技能库</button>
          </div>
        )}
      </div>

      {offer.servers.length > 0 && (
        <>
          <h4 className="muted small">MCP 服务</h4>
          <ul className="version-list">
            {offer.servers.map(server => {
              const result = probes[server.name]
              return (
                <li key={server.name} className="mcp-server">
                  <div className="mcp-server-main">
                    <span className="version-name">{server.name}</span>
                    <span className="badge">{TRANSPORT[server.transport] ?? server.transport}</span>
                    <span className={`badge ${server.source === 'pack' ? 'ok' : ''}`} title={server.file === undefined ? undefined : `来自脚本的 ${server.file}`}>{server.source === 'pack' ? '脚本包已写明用法' : '从脚本配置读到'}</span>
                    {server.connected && <span className="badge ok">已连接</span>}
                    <span className="spacer" />
                    <button className="ghost small-button" disabled={result === 'busy' || server.problem !== undefined} title={server.trusted ? undefined : '会启动或连接这个服务；之后 agent 用它时不再询问'} onClick={() => void probe(server.name)}>
                      {result === 'busy' ? '连接中…' : '测试连接'}
                    </button>
                  </div>
                  <code className="muted small mcp-target">{server.target}</code>
                  {server.description !== undefined && <p className="muted small">{server.description}</p>}
                  {server.needsRunning && <p className="muted small">要先打开脚本（并在它的设置里开启 MCP 服务）才能连上。</p>}
                  {server.problem !== undefined && <div className="notice warn-note left small"><Icon name="alert" /><span>{server.problem}</span></div>}
                  {result !== undefined && result !== 'busy' && (result.ok
                    ? <p className="small">{result.server === undefined ? '' : `${result.server.name} ${result.server.version} · `}{result.tools?.length ?? 0} 个工具{(result.tools?.length ?? 0) > 0 ? `：${result.tools!.map(t => t.title ?? t.name).join('、')}` : ''}</p>
                    : <div className="notice error left small"><Icon name="alert" /><span>{result.error}</span></div>)}
                </li>
              )
            })}
          </ul>
          {offer.note !== undefined && offer.servers.length === 0 && <p className="muted small">{offer.note}</p>}
        </>
      )}

      {offer.skills.length > 0 && (
        <>
          <h4 className="muted small">自带的技能</h4>
          <ul className="version-list">
            {offer.skills.map(skill => (
              <li key={skill.path} className="mcp-skill">
                <div className="mcp-server-main">
                  <span className="version-name">{skill.name}</span>
                  {skill.imported !== undefined && <span className="badge ok">已在技能库{skill.imported.name === skill.name ? '' : `（${skill.imported.name}）`}</span>}
                  {skill.imported !== undefined && !skill.imported.current && <span className="badge warn" title={skill.imported.changed ? '技能库里的这份在这里改过，不会自动替换' : undefined}>脚本里有新版</span>}
                  <span className="spacer" />
                  {skill.problem === undefined && (skill.imported === undefined || !skill.imported.current) && (
                    <button className="small-button" disabled={busy !== null} onClick={() => void take([skill.path])}>
                      {busy === skill.path ? '导入中…' : skill.imported === undefined ? '放进技能库' : '更新'}
                    </button>
                  )}
                </div>
                {skill.description !== '' && <p className="muted small">{skill.description}</p>}
                <code className="muted small mcp-target">{skill.path}</code>
                {skill.problem !== undefined && <div className="notice warn-note left small"><Icon name="alert" /><span>{skill.problem}</span></div>}
              </li>
            ))}
          </ul>
        </>
      )}
      {message !== null && <div className={`notice ${message.error ? 'error' : ''} left small`}><Icon name={message.error ? 'alert' : 'check'} /><span>{message.text}</span></div>}
    </section>
  )
}
