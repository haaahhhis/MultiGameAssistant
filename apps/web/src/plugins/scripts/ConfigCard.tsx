import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { RequestResult, ScriptInfo } from '@adg/protocol'
import { Fold } from '../../components/Fold.tsx'
import { Icon } from '../../components/Icons.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { relativeTime } from '../../components/SessionList.tsx'
import { errorText } from './data.ts'
import { useProfiles } from './Profiles.tsx'

type Status = RequestResult<'configs/status'>
type Source = 'copy' | 'original' | 'folder'

/**
 * The script's local config copies: what MultiGameAssistant runs with. A
 * script can keep several (profiles); runs use the current one unless a run
 * or pipeline step names another. The original project config stays as the
 * user left it; changes made in the script's own window show up as drift to
 * import.
 */
export function ConfigCard({ client, script }: { client: AdgClient; script: ScriptInfo }) {
  const status = useStore(client.connection.status)
  const now = useNow(60_000)
  const profiles = useProfiles(client, script.id)
  const [selected, setSelected] = useState<string | undefined>(undefined)
  const [data, setData] = useState<Status | null>(null)
  const [revision, setRevision] = useState(0)
  const [confirm, setConfirm] = useState<'import' | 'remove' | null>(null)
  const [saving, setSaving] = useState<{ name: string; source: Source; dir: string } | null>(null)
  const [renaming, setRenaming] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  /** The script's own settings window, open to change a profile by hand. */
  const [editing, setEditing] = useState<{ runId: string; profile: string; finishing: 'done' | 'discard' | null } | null>(null)

  // The profile shown: the one picked, else the current one (and back to it when the picked one is gone).
  const shown = profiles?.items.find(p => p.id === selected) ?? profiles?.items.find(p => p.id === profiles.current)
  useEffect(() => { setConfirm(null); setRenaming(null) }, [shown?.id])

  // A finished settings session or run may have changed the local copy.
  useEffect(() => client.connection.on('runs/state', run => {
    if (run.scriptId !== script.id || run.endedAt === undefined) return
    setRevision(r => r + 1)
    setEditing(open => {
      if (open === null || open.runId !== run.id) return open
      setNote(run.state === 'succeeded' ? `修改已同步到「${open.profile}」` : run.state === 'cancelled' ? '已放弃这次修改，本地配置没变' : `没能保存修改：${run.outcome ?? '脚本窗口异常退出'}`)
      return null
    })
  }), [client, script.id])

  const finishEditing = async (how: 'done' | 'discard') => {
    if (editing === null) return
    setEditing({ ...editing, finishing: how })
    try {
      if (how === 'done') await client.connection.call('configs/done', { runId: editing.runId })
      else await client.connection.call('runs/stop', { runId: editing.runId })
    } catch (e) {
      setError(errorText(e))
      setEditing(null)
    }
  }
  useEffect(() => {
    if (status.state !== 'open' || shown === undefined) return
    let live = true
    client.connection.call('configs/status', { scriptId: script.id, profile: shown.id })
      .then(s => { if (live) { setData(s); setError(null) } })
      .catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, script.id, script.packId, status.state, revision, shown?.id])

  const act = async (fn: () => Promise<string | void>) => {
    setBusy(true)
    setError(null)
    setNote(null)
    try {
      const message = await fn()
      if (typeof message === 'string') setNote(message)
      setRevision(r => r + 1)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const many = (profiles?.items.length ?? 0) > 1
  const isCurrent = shown !== undefined && shown.id === profiles?.current
  const present = data?.files.filter(f => f.local) ?? []
  const current = data !== null && data.profile.id === shown?.id ? data : null
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>配置</h3>
          <p className="muted small">通过本应用运行时，用的是本地保存的配置；原项目里的配置不会被改动，你自己打开脚本时仍是它原来的设置。可以存几份（比如两个账号），运行和编排时选用哪一份。</p>
        </div>
        <button className="small-button" disabled={busy || editing !== null || status.state !== 'open' || shown === undefined} onClick={() => void act(async () => {
          const run = await client.connection.call('configs/open', { scriptId: script.id, profile: shown!.id })
          if (run.endedAt === undefined) setEditing({ runId: run.id, profile: shown!.name, finishing: null })
          else if (run.state !== 'succeeded') throw new Error(run.outcome ?? '没能打开脚本的设置界面')
        })}><Icon name="settings" />打开脚本修改设置</button>
      </div>

      {profiles !== null && (many || (data?.files.length ?? 0) > 0) && (
        <div className="profile-bar">
          <div className="profile-chips" role="tablist" aria-label="配置">
            {profiles.items.map(p => (
              <button key={p.id} role="tab" aria-selected={p.id === shown?.id} className={`profile-chip ${p.id === shown?.id ? 'active' : ''}`} onClick={() => setSelected(p.id)}>
                {p.name}{p.id === profiles.current && many && <span className="profile-current" title="不指定配置的运行都用它">当前使用</span>}
              </button>
            ))}
            <button className="ghost small-button" disabled={busy} onClick={() => setSaving(s => (s === null ? { name: '', source: 'copy', dir: '' } : null))}>＋ 另存一份</button>
          </div>
          {shown !== undefined && many && renaming === null && (
            <div className="key-actions">
              <span className="muted small">{isCurrent ? '运行时没有指定配置就用这一份' : '在编排或运行时选它才会用到'}</span>
              <span className="spacer" />
              {!isCurrent && <button className="small-button" disabled={busy} onClick={() => void act(async () => {
                await client.connection.call('configs/profiles/update', { scriptId: script.id, profile: shown.id, current: true })
                return `现在默认使用「${shown.name}」`
              })}>设为当前使用</button>}
              <button className="ghost small-button" disabled={busy} onClick={() => setRenaming(shown.name)}>改名</button>
              {shown.id !== 'default' && (confirm === 'remove'
                ? (
                  <>
                    <span className="muted small">用了这份配置的编排步骤会运行失败</span>
                    <button className="small-button" onClick={() => setConfirm(null)}>取消</button>
                    <button className="danger-outline small-button" disabled={busy} onClick={() => void act(async () => {
                      await client.connection.call('configs/profiles/remove', { scriptId: script.id, profile: shown.id })
                      setConfirm(null)
                      setSelected(undefined)
                      return `已删除「${shown.name}」`
                    })}>确认删除</button>
                  </>
                )
                : <button className="ghost small-button" disabled={busy} onClick={() => setConfirm('remove')}>删除</button>)}
            </div>
          )}
          {shown !== undefined && renaming !== null && (
            <div className="key-input">
              <input className="text-input plain" aria-label="新名字" value={renaming} maxLength={30} autoFocus onChange={e => setRenaming(e.target.value)} />
              <button className="small-button" onClick={() => setRenaming(null)}>取消</button>
              <button className="primary small-button" disabled={busy || renaming.trim() === ''} onClick={() => void act(async () => {
                await client.connection.call('configs/profiles/update', { scriptId: script.id, profile: shown.id, name: renaming.trim() })
                setRenaming(null)
              })}>保存</button>
            </div>
          )}
          {saving !== null && shown !== undefined && (
            <div className="profile-save">
              <label className="field-label" htmlFor="profile-name">新配置的名字</label>
              <input id="profile-name" className="text-input plain" placeholder="例如：小号、只清体力" value={saving.name} maxLength={30} autoFocus onChange={e => setSaving({ ...saving, name: e.target.value })} />
              <fieldset className="asset-list" disabled={busy}>
                <legend className="field-label">内容从哪里来</legend>
                {([
                  ['copy', `复制「${shown.name}」`, '复制后可以「打开脚本修改设置」单独改它'],
                  ['original', '读取原项目现在的配置', '在脚本自己的界面里设好了另一套设置时用'],
                  ['folder', '从别的文件夹读取', `另一份同样的脚本，或存下来的配置；只读 ${data?.files.map(f => f.file).join('、') || '脚本包声明的配置文件'}`],
                ] as const).map(([value, title, hint]) => (
                  <label key={value} className={`asset-option choice-option ${saving.source === value ? 'active' : ''}`}>
                    <input type="radio" name="profile-source" value={value} checked={saving.source === value} onChange={() => setSaving({ ...saving, source: value })} />
                    <span className="choice-text"><span>{title}</span><span className="muted small">{hint}</span></span>
                  </label>
                ))}
              </fieldset>
              {saving.source === 'folder' && (
                <input className="text-input plain" aria-label="文件夹" placeholder="文件夹的完整路径，例如 D:\MAA2" value={saving.dir} onChange={e => setSaving({ ...saving, dir: e.target.value })} />
              )}
              <div className="key-actions">
                <span className="spacer" />
                <button className="small-button" onClick={() => setSaving(null)}>取消</button>
                <button className="primary small-button" disabled={busy || saving.name.trim() === '' || (saving.source === 'folder' && saving.dir.trim() === '')} onClick={() => void act(async () => {
                  const from = saving.source === 'copy' ? { kind: 'copy' as const, profile: shown.id } : saving.source === 'original' ? { kind: 'original' as const } : { kind: 'folder' as const, dir: saving.dir.trim() }
                  const r = await client.connection.call('configs/profiles/create', { scriptId: script.id, name: saving.name.trim(), from })
                  setSaving(null)
                  setSelected(r.profile.id)
                  return `已保存「${r.profile.name}」：${r.files.length > 0 ? r.files.join('、') : '还没有配置文件'}`
                })}>保存</button>
              </div>
            </div>
          )}
        </div>
      )}

      {current !== null && (
        <>
          {current.drift.length > 0 && (
            <div className="notice warn-box left">
              <Icon name="info" />
              <span>原项目的配置在导入后改过（{current.drift.join('、')}），可能是在脚本自己的界面里改的。本应用仍按「{current.profile.name}」运行；需要的话可以导入。</span>
            </div>
          )}
          <Fold id={`config.files.${script.id}`} title="配置文件" count={current.files.length}>
            <ul className="version-list">
              {current.files.map(f => <ConfigFileRow key={`${current.profile.id}:${f.file}`} client={client} scriptId={script.id} profile={current.profile.id} file={f} />)}
              {current.files.length === 0 && <li className="muted small">脚本包没有声明配置文件</li>}
            </ul>
          </Fold>
          <div className="key-actions">
            <span className="muted small">
              {current.importedAt === undefined ? '还没有导入' : `${relativeTime(current.importedAt, now)}${many ? `存的「${current.profile.name}」` : '从原项目导入'}`}
              {present.length > 0 && ' · '}
              {present.length > 0 && <button className="link-button" onClick={() => void navigator.clipboard?.writeText(current.dir)}>复制本地配置目录</button>}
            </span>
            <span className="spacer" />
            {confirm !== 'import'
              ? <button className="small-button" disabled={busy} onClick={() => setConfirm('import')}>导入原项目设置</button>
              : (
                <>
                  <span className="muted small">会用原项目当前的配置覆盖「{current.profile.name}」</span>
                  <button className="small-button" onClick={() => setConfirm(null)}>取消</button>
                  <button className="primary small-button" disabled={busy} onClick={() => void act(async () => {
                    const r = await client.connection.call('configs/import', { scriptId: script.id, profile: current.profile.id })
                    setConfirm(null)
                    return r.imported.length > 0 ? `已导入到「${current.profile.name}」：${r.imported.join('、')}` : '原项目里还没有这些配置文件'
                  })}>确认导入</button>
                </>
              )}
          </div>
        </>
      )}
      {note !== null && <div className="notice info left small">{note}</div>}
      {editing !== null && (
        <div className="dialog-backdrop">
          <div className="dialog" role="alertdialog" aria-modal="true" aria-labelledby="config-edit-title">
            <h3 id="config-edit-title"><Icon name="settings" />正在用脚本自己的界面修改设置</h3>
            <p>{script.name} 的设置窗口已经打开，用的是本地配置「{editing.profile}」。在那个窗口里改好、保存后，回到这里点「我已手动改好」：脚本窗口会关闭，修改同步到「{editing.profile}」，之后的运行和编排都用它。</p>
            <p className="muted small">直接关掉脚本窗口也会保存。原项目里的配置不会被改动。</p>
            {editing.finishing !== null && (
              <p className="dialog-progress"><span className="tool-spinner" aria-hidden />{editing.finishing === 'done' ? '正在关闭脚本窗口并保存修改…' : '正在关闭脚本窗口，不保存…'}</p>
            )}
            <div className="key-actions">
              <button className="small-button" disabled={editing.finishing !== null} onClick={() => void finishEditing('discard')}>放弃修改</button>
              <span className="spacer" />
              <button className="primary small-button" disabled={editing.finishing !== null} onClick={() => void finishEditing('done')}>{editing.finishing === 'done' ? '保存中…' : '我已手动改好'}</button>
            </div>
          </div>
        </div>
      )}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}

/** One config file: its state, and its local copy when opened. */
function ConfigFileRow({ client, scriptId, profile, file: f }: { client: AdgClient; scriptId: string; profile: string; file: { file: string; local: boolean; changed: boolean; original: boolean } }) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState<{ content: string; truncated: boolean } | null>(null)
  const [error, setError] = useState<string | null>(null)
  const toggle = () => {
    setOpen(o => !o)
    if (text !== null || !f.local) return
    client.connection.call('configs/read', { scriptId, file: f.file, profile }).then(setText, e => setError(errorText(e)))
  }
  return (
    <li className={`config-file ${open ? 'open' : ''}`}>
      <button type="button" className="config-file-head" aria-expanded={open} onClick={toggle} disabled={!f.local} title={f.local ? '展开看本地配置的内容' : '本地还没有这个文件'}>
        <Icon name="chevron" className={`fold-chevron ${open ? 'open' : ''}`} />
        <span className="version-name">{f.file}</span>
        {f.local ? <span className="badge ok">本地已保存</span> : <span className="badge">本地没有</span>}
        {f.changed && <span className="badge warn">原项目已改动</span>}
        {!f.original && <span className="muted small">原项目里没有</span>}
      </button>
      {open && (error !== null
        ? <div className="notice error left small"><Icon name="alert" /><span>{error}</span></div>
        : text === null
          ? <div className="muted small">读取中…</div>
          : <pre className="config-preview">{text.content}{text.truncated ? '\n…（太长，只显示前一部分）' : ''}</pre>)}
    </li>
  )
}
