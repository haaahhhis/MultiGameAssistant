import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { GuardGrant, PackDraft, PackVersion, ScriptInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { relativeTime } from '../../components/SessionList.tsx'
import { errorText } from './data.ts'
import { Select } from '../../components/Select.tsx'

/**
 * Asking the agent to analyze this script (the pack it writes is in use at once);
 * pack drafts left from when each waited to be accepted or rejected (with the
 * documents each was written from); going back to a version of the pack that was
 * replaced (the agent's changes are not confirmed first, so this is the way back); and, after
 * the script updated past its pack's version, asking whether to check the pack.
 */
export function PackCard({ client, script, openSession }: { client: AdgClient; script: ScriptInfo; openSession: (id: string) => void }) {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const now = useNow(60_000)
  const [drafts, setDrafts] = useState<PackDraft[]>([])
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [open, setOpen] = useState<'manifest' | 'skill' | null>(null)
  const [versions, setVersions] = useState<PackVersion[]>([])
  const [restored, setRestored] = useState(false)

  useEffect(() => client.connection.on('packs/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('packs')) return
    let live = true
    client.connection.call('packs/drafts', { scriptId: script.id }).then(r => { if (live) setDrafts(r.items) }).catch(() => {})
    return () => { live = false }
  }, [client, script.id, status.state, capabilities, revision])

  // What the pack can go back to: the versions the agent's changes replaced, and the built-in pack under a user pack.
  useEffect(() => {
    if (status.state !== 'open' || !capabilities.has('packs') || script.packId === undefined) { setVersions([]); return }
    let live = true
    client.connection.call('packs/history', { packId: script.packId }).then(r => { if (live) setVersions(r.items) }).catch(() => { if (live) setVersions([]) })
    return () => { live = false }
  }, [client, script.packId, status.state, capabilities, revision])

  const act = async (fn: () => Promise<unknown>) => {
    setBusy(true)
    setError(null)
    try { await fn() } catch (e) { setError(errorText(e)) } finally { setBusy(false) }
  }

  const analyze = () => act(async () => {
    // The 脚本 agent's session: it has pack_propose (a session without a role does not, and only hands the saving on).
    const { sessionId } = await client.connection.call('sessions/create', { focus: { scripts: [script.id] }, role: 'scripts' })
    await client.connection.call('session/prompt', {
      sessionId, requestId: `analyze-${Date.now()}`, mode: 'queue',
      text: `请按 script-analysis 技能分析脚本库里的「${script.name}」（id: ${script.id}），${script.packId === undefined ? '为它生成' : '检查并改进它的'}脚本包：先找到并读完这个项目自己的文档（目录里的说明、仓库 README、Wiki、文档站），再结合代码核对补全，实在没有文档才直接看代码。写好给我看的使用说明（每个任务和参数是什么、每个功能怎么开启、配置文件怎么设置、运行前检查什么、常见问题），给 agent 的备注写进 SKILL.md。用 pack_propose 保存（直接生效），docs 里写明依据的文档。`,
    })
    openSession(sessionId)
  })

  const review = (decision: 'check' | 'keep') => act(async () => {
    const { sessionId } = await client.connection.call('scripts/packReview', { id: script.id, decision })
    if (sessionId !== undefined) openSession(sessionId)
  })

  const optimize = (decision: 'run' | 'keep') => act(async () => {
    const { sessionId } = await client.connection.call('scripts/optimize', { id: script.id, decision })
    if (sessionId !== undefined) openSession(sessionId)
  })

  const restore = (version: PackVersion) => act(async () => {
    setRestored(false)
    await client.connection.call('packs/restore', { packId: script.packId!, version: version.id })
    setRestored(true)
  })
  const versionLabel = (version: PackVersion) => `${version.builtin === true ? '内置脚本包' : `${relativeTime(version.at ?? now, now)}被替换`} · 任务：${version.tasks.map(t => t.title).join('、') || '无'}`

  const draft = drafts[0]
  const previous = versions[0]
  const due = script.optimize?.due
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>脚本包</h3>
          <p className="muted small">{script.packId === undefined ? '还没有脚本包：agent 还不知道怎么运行它。' : `使用脚本包 ${script.packId}。`}</p>
        </div>
        <span className="key-actions">
          {script.packId !== undefined && (
            <button className="small-button" disabled={busy || status.state !== 'open'} onClick={() => void optimize('run')}
              title="用运行攒下的信息：重新总结脚本包、调「多久没动静算卡住」、把走通的步骤存成只给它用的技能">
              <Icon name="sparkles" />优化脚本
            </button>
          )}
          <button className="small-button" disabled={busy || status.state !== 'open'} onClick={() => void analyze()}><Icon name="sparkles" />{script.packId === undefined ? '让 agent 分析' : '让 agent 改进'}</button>
        </span>
      </div>
      {script.packReview !== undefined && draft === undefined && (
        <div className="notice left pack-review">
          <Icon name="refresh" />
          <span>{script.name} 从 {script.packReview.from ?? '旧版本'} 更新到了 {script.packReview.to}，脚本包是按旧版本写的。要让 agent 先读这次的更新日志，再检查脚本包要不要改吗？</span>
          <span className="key-actions">
            <button className="small-button" disabled={busy} onClick={() => void review('keep')}>不用改</button>
            <button className="primary small-button" disabled={busy || status.state !== 'open'} onClick={() => void review('check')}>让 agent 检查</button>
          </span>
        </div>
      )}
      {due !== undefined && script.packReview === undefined && draft === undefined && (
        <div className="notice left pack-review">
          <Icon name="sparkles" />
          <span>{due === 'updated' ? `${script.name} 更新后已经跑通了。` : `${script.name} ${script.optimize?.at === undefined ? '装好以来' : '上次优化以来'}已经跑成功 ${script.optimize?.runs ?? 0} 次。`}要让 agent 用这些运行记录优化它吗：重新总结脚本包、调卡住时间、把走通的步骤存成技能。</span>
          <span className="key-actions">
            <button className="small-button" disabled={busy} onClick={() => void optimize('keep')}>这次不用</button>
            <button className="primary small-button" disabled={busy || status.state !== 'open'} onClick={() => void optimize('run')}>优化脚本</button>
          </span>
        </div>
      )}
      {previous !== undefined && (
        <div className="pack-history">
          <div className="key-actions">
            <span className="muted small">{previous.builtin === true ? '现在用的是自己写的脚本包，可以换回' : '上一版脚本包：'}{versionLabel(previous)}</span>
            <span className="spacer" />
            <button className="small-button" disabled={busy || status.state !== 'open'} title="现在用的这一版会留在历史里，可以再恢复回来" onClick={() => void restore(previous)}>{previous.builtin === true ? '恢复内置的' : '恢复上一版'}</button>
          </div>
          {versions.length > 1 && (
            <details className="draft-docs">
              <summary className="muted small">更早的版本（{versions.length - 1}）</summary>
              <ul>{versions.slice(1).map(v => <li key={v.id}>{versionLabel(v)} <button className="link-button" disabled={busy || status.state !== 'open'} onClick={() => void restore(v)}>恢复</button></li>)}</ul>
            </details>
          )}
          {restored && <p className="muted small">已恢复。刚才用的那一版留在历史里，可以再恢复回来。</p>}
        </div>
      )}
      {draft !== undefined && (
        <div className="draft">
          <div className="draft-head">
            <span className="badge warn">待确认的草稿</span>
            <span className="muted small">{relativeTime(draft.proposedAt, now)}提交 · 任务：{draft.tasks.map(t => t.title).join('、') || '无'}</span>
          </div>
          <p className="draft-summary">{draft.summary}</p>
          {draft.docs !== undefined && draft.docs.length > 0 && (
            <details className="draft-docs">
              <summary className="muted small">依据的文档（{draft.docs.length}）</summary>
              <ul>{draft.docs.map(d => <li key={d.source}><code>{d.source}</code>：{d.used}</li>)}</ul>
            </details>
          )}
          {draft.noDocs !== undefined && <p className="muted small">没有找到项目文档，按代码分析：{draft.noDocs}</p>}
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
