/**
 * Scripts: a newer version waiting for the user's yes (设置 → 权限 →
 * 「脚本有新版本时」set to 先问我) on the chat's input box, and a card in the
 * floating dock that celebrates an install or update that went through.
 */
import { useEffect, useRef, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ScriptJob, ScriptUpdatePolicy } from '@adg/protocol'
import { useStore } from '../hooks.ts'
import { errorText, isActive, PHASE_LABEL, useScriptJobs, useScriptList } from '../plugins/scripts/data.ts'
import { Icon } from './Icons.tsx'

/** 「以后再说」: script id → the version it was said for; a newer one asks again. */
const LATER_KEY = 'adg.scriptUpdate.later'
/** How long a success card stays. */
const DONE_SHOWN_MS = 9000

function readLater(): Record<string, string> {
  try { return JSON.parse(localStorage.getItem(LATER_KEY) ?? '{}') as Record<string, string> } catch { return {} }
}

/** In the floating dock: installs and updates that went through. */
export function ScriptDock({ client }: { client: AdgClient }) {
  const capabilities = useStore(client.capabilities)
  if (!capabilities.has('scripts')) return null
  return <ScriptDoneCards client={client} />
}

/** On the chat's input box: each script with a newer version to ask about. */
export function ScriptUpdateNotes({ client }: { client: AdgClient }) {
  const capabilities = useStore(client.capabilities)
  if (!capabilities.has('scripts')) return null
  return <UpdateNotes client={client} />
}

function UpdateNotes({ client }: { client: AdgClient }) {
  const { data } = useScriptList(client)
  const jobs = useScriptJobs(client)
  const [policy, setPolicy] = useState<ScriptUpdatePolicy | null>(null)
  const [later, setLater] = useState(readLater)
  const [errors, setErrors] = useState<ReadonlyMap<string, string>>(new Map())
  // The setting changes with the library (scripts/changed), so read it again with the list.
  useEffect(() => {
    if (data === null) return
    let live = true
    client.connection.call('scripts/settings', {}).then(s => { if (live) setPolicy(s.autoUpdate) }).catch(() => {})
    return () => { live = false }
  }, [client, data])
  if (data === null || policy !== 'ask') return null

  const waiting = data.scripts.filter(s => s.update?.available === true && later[s.id] !== s.update.latest)
  if (waiting.length === 0) return null
  const postpone = (id: string, version: string) => {
    const next = { ...readLater(), [id]: version }
    try { localStorage.setItem(LATER_KEY, JSON.stringify(next)) } catch { /* only until the page reloads then */ }
    setLater(next)
  }
  const update = (id: string) => {
    setErrors(e => { const next = new Map(e); next.delete(id); return next })
    client.connection.call('scripts/update', { id }).catch(e => setErrors(m => new Map(m).set(id, errorText(e))))
  }
  return waiting.map(script => {
    const job = jobs.get(script.id)
    const running = isActive(job)
    const current = script.source.kind === 'local' ? script.localVersion?.version : script.current
    const error = errors.get(script.id)
    return (
      <div key={script.id} className="reminder script-update-note" role="status">
        <Icon name="download" />
        <span>
          <strong>{script.name}</strong> 有新版本 {script.update!.latest}（当前 {current ?? '认不出的版本'}），要现在更新吗？
          {error !== undefined && <span className="error"> 没有更新成功：{error}</span>}
        </span>
        {running
          ? <span className="script-update-progress muted"><span className="spinner" />{job.message ?? PHASE_LABEL[job.phase]}…</span>
          : (
            <>
              <button type="button" className="ghost small-button" title="有更新的版本时再问" onClick={() => postpone(script.id, script.update!.latest)}>以后再说</button>
              <button type="button" className="primary small-button" onClick={() => update(script.id)}>更新</button>
            </>
          )}
      </div>
    )
  })
}

interface Done { readonly job: ScriptJob; readonly name: string }

/** Every install or update that finished while the app is open: a moment of its own, then it goes. */
function ScriptDoneCards({ client }: { client: AdgClient }) {
  const [done, setDone] = useState<readonly Done[]>([])
  const seen = useRef(new Set<string>())
  useEffect(() => client.connection.on('scripts/job', job => {
    // A setup program still has to be run, and an environment fix is not a new version.
    if (job.phase !== 'done' || job.setup !== undefined || job.kind === 'env-fix' || seen.current.has(job.id)) return
    seen.current.add(job.id)
    client.connection.call('scripts/get', { id: job.scriptId })
      .then(s => s.name, () => job.scriptId)
      .then(name => setDone(list => [...list, { job, name }]))
  }), [client])
  const close = (id: string) => setDone(list => list.filter(d => d.job.id !== id))
  return done.map(d => <DoneCard key={d.job.id} done={d} onClose={() => close(d.job.id)} />)
}

function DoneCard({ done, onClose }: { done: Done; onClose: () => void }) {
  const [hover, setHover] = useState(false)
  useEffect(() => {
    if (hover) return
    const timer = setTimeout(onClose, DONE_SHOWN_MS)
    return () => clearTimeout(timer)
  }, [hover, onClose])
  const { job, name } = done
  const updated = job.kind === 'update'
  return (
    <div className="approval-card done-card" role="status" onMouseEnter={() => setHover(true)} onMouseLeave={() => setHover(false)}>
      <div className="approval-head">
        <span className="done-badge" aria-hidden="true">
          <svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="10" /><path d="M7.5 12.5l3 3 6-6.5" /></svg>
        </span>
        <div className="approval-text">
          <span className="approval-title">{updated ? '更新成功' : '安装成功'}</span>
          <span className="done-line">{name}{job.version === undefined ? '' : updated ? ` 已更新到 ${job.version}` : ` ${job.version} 已装好`}</span>
        </div>
        <button className="ghost icon-button update-close" aria-label="关闭" onClick={onClose}><Icon name="close" /></button>
      </div>
      {!hover && <span className="done-timer" style={{ animationDuration: `${DONE_SHOWN_MS}ms` }} />}
    </div>
  )
}
