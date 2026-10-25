import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { GuardGrant, PackDraft, ScriptInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { relativeTime } from '../../components/SessionList.tsx'
import { errorText } from './data.ts'
import { Select } from '../../components/Select.tsx'

/** Pack drafts the agent proposed for this script, to accept or reject; plus asking the agent to analyze it. */
export function PackCard({ client, script, openSession }: { client: AdgClient; script: ScriptInfo; openSession: (id: string) => void }) {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const now = useNow(60_000)
  const [drafts, setDrafts] = useState<PackDraft[]>([])
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<'manifest' | 'skill' | null>(null)

  useEffect(() => client.connection.on('packs/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('packs')) return
    let live = true
    client.connection.call('packs/drafts', { scriptId: script.id }).then(r => { if (live) setDrafts(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, script.id, status.state, capabilities, revision])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try { await fn() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const analyze = () => act(async () => {
    const { sessionId } = await client.connection.call('sessions/create', {})
    await client.connection.call('session/prompt', {
      sessionId, requestId: `analyze-${Date.now()}`, mode: 'queue',
      text: `请按 script-analysis 技能分析脚本库里的「${script.name}」（id: ${script.id}），${script.packId === undefined ? '为它生成' : '检查并改进它的'}脚本包，用 pack_propose 提交草稿。`,
    })
    openSession(sessionId)
  })

  const draft = drafts[0]
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>脚本包</h3>
          <p className="muted small">{script.packId === undefined ? '还没有脚本包：agent 还不知道怎么运行它。' : `使用脚本包 ${script.packId}。`}</p>
        </div>
        <button className="small-button" disabled={busy || status.state !== 'open'} onClick={() => void analyze()}><Icon name="sparkles" />{script.packId === undefined ? '让 agent 分析' : '让 agent 改进'}</button>
      </div>
      {draft !== undefined && (
        <div className="draft">
          <div className="draft-head">
            <span className="badge warn">待确认的草稿</span>
            <span className="muted small">{relativeTime(draft.proposedAt, now)}提交 · 任务：{draft.tasks.map(t => t.title).join('、') || '无'}</span>
          </div>
          <p className="draft-summary">{draft.summary}</p>
          {draft.current !== undefined && <p className="muted small">接受后会替换当前的{draft.current.builtin ? '内置' : ''}脚本包（之前的版本会保留在历史里）。</p>}
          <div className="segmented draft-tabs">
            <label className={open === 'manifest' ? 'active' : ''}><input type="checkbox" checked={open === 'manifest'} onChange={() => setOpen(o => o === 'manifest' ? null : 'manifest')} />adg.script.yaml</label>
            <label className={open === 'skill' ? 'active' : ''}><input type="checkbox" checked={open === 'skill'} onChange={() => setOpen(o => o === 'skill' ? null : 'skill')} />SKILL.md</label>
          </div>
          {open !== null && <pre className="draft-text">{open === 'manifest' ? draft.manifest : draft.skill}</pre>}
          <div className="key-actions">
            {draft.sessionId !== undefined && <button className="link-button" onClick={() => openSession(draft.sessionId!)}>查看分析过程</button>}
            <span className="spacer" />
            <button className="small-button" disabled={busy} onClick={() => void act(() => client.connection.call('packs/reject', { packId: draft.packId }))}>拒绝</button>
            <button className="primary small-button" disabled={busy} onClick={() => void act(() => client.connection.call('packs/accept', { packId: draft.packId }))}>接受并使用</button>
          </div>
        </div>
      )}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}

/** The user's explicit, time-limited permission for the agent to change this script's files. */
export function GuardCard({ client, script }: { client: AdgClient; script: ScriptInfo }) {
  const status = useStore(client.connection.status)
  const now = useNow(15_000)
  const [grant, setGrant] = useState<GuardGrant | undefined>(undefined)
  const [revision, setRevision] = useState(0)
  const [minutes, setMinutes] = useState(30)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => client.connection.on('guard/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('guard/grants', {}).then(r => { if (live) setGrant(r.items.find(g => g.scriptId === script.id)) }).catch(() => {})
    return () => { live = false }
  }, [client, script.id, status.state, revision])

  const activeGrant = grant !== undefined && grant.expiresAt > now ? grant : undefined
  const call = (fn: () => Promise<unknown>) => { setError(null); fn().catch(e => setError(errorText(e))) }
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>修改脚本文件</h3>
          <p className="muted small">默认禁止：agent 只能改脚本包声明的配置文件、只能用官方更新。确实需要改代码时，在这里临时允许。</p>
        </div>
        {activeGrant === undefined ? <span className="badge ok">受保护</span> : <span className="badge warn">已允许</span>}
      </div>
      {activeGrant === undefined ? (
        <div className="key-actions">
          <label className="check-label">允许 agent 修改
            <Select inline aria-label="允许多久" value={String(minutes)} onChange={m => setMinutes(Number(m))}
              options={[15, 30, 60, 120].map(m => ({ value: String(m), label: `${m} 分钟` }))} />
          </label>
          <span className="spacer" />
          <button className="small-button" onClick={() => call(() => client.connection.call('guard/grant', { scriptId: script.id, minutes }))}>临时允许</button>
        </div>
      ) : (
        <div className="key-actions">
          <span className="muted small">还剩约 {Math.max(1, Math.round((activeGrant.expiresAt - now) / 60_000))} 分钟</span>
          <span className="spacer" />
          <button className="danger-outline small-button" onClick={() => call(() => client.connection.call('guard/revoke', { scriptId: script.id }))}>立即收回</button>
        </div>
      )}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}
