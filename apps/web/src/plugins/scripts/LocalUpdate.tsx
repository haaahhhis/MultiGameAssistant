/**
 * Updates for a locally imported script: the version found in its folder,
 * where it updates from (its pack's repository, or one the user names), and
 * an in-place update that backs up what it replaces and can be undone.
 */
import { useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ScriptInfo } from '@adg/protocol'
import { relativeTime } from '../../components/SessionList.tsx'

export function LocalUpdate({ client, script, disabled, busy, now, act }: {
  client: AdgClient
  script: ScriptInfo
  disabled: boolean
  busy: string | null
  now: number
  act: (name: string, fn: () => Promise<string | void>) => Promise<void>
}) {
  const [editing, setEditing] = useState(false)
  const [repo, setRepo] = useState(script.updateFrom ?? '')
  const [confirming, setConfirming] = useState(false)
  const version = script.localVersion
  const update = script.update

  const setSource = (value: string | null | undefined) => act('source', async () => {
    await client.connection.call('scripts/source/set', { id: script.id, ...(value === undefined ? {} : { repo: value }) })
    setEditing(false)
    return value === null ? '已关闭这个脚本的更新' : value === undefined ? '已改回脚本包的更新来源' : `更新来源已设为 ${value}`
  })

  return (
    <div className="local-update">
      <dl className="local-facts">
        <dt>当前版本</dt>
        <dd>
          {version !== undefined
            ? <><span className="version-name">{version.version}</span><span className="muted small">{version.from === '更新' ? '（由 MultiGameAssistant 更新）' : `（读自 ${version.from}）`}</span></>
            : <span className="muted small">认不出这个目录的版本：检查更新时会当作可以更新</span>}
        </dd>
        <dt>更新来源</dt>
        <dd>
          {!editing ? (
            <>
              {script.updateFrom !== undefined
                ? <><span>GitHub · {script.updateFrom}</span>{script.updateFromPack === true && <span className="muted small">（脚本包）</span>}</>
                : <span className="muted small">未设置：填写它的 GitHub 仓库后就能检查和更新</span>}
              {script.mirrorchyan !== undefined && <span className="badge" title="填了 Mirror酱 CDK 后从 Mirror酱 下载（有增量包时只下变化的文件）">Mirror酱 {script.mirrorchyan}</span>}
              <button className="ghost small-button" disabled={disabled} onClick={() => { setRepo(script.updateFrom ?? ''); setEditing(true) }}>{script.updateFrom === undefined ? '设置' : '修改'}</button>
            </>
          ) : (
            <span className="local-source-edit">
              <input className="text-input plain" aria-label="更新来源 GitHub 仓库" value={repo} onChange={e => setRepo(e.target.value)} placeholder="owner/repo，例如 MaaAssistantArknights/MaaAssistantArknights" spellCheck={false} autoFocus />
              <button className="primary small-button" disabled={disabled || !/^[\w.-]+\/[\w.-]+$/.test(repo.trim())} onClick={() => void setSource(repo.trim())}>保存</button>
              {script.packId !== undefined && <button className="small-button" disabled={disabled} onClick={() => void setSource(undefined)}>用脚本包的</button>}
              {script.updateFrom !== undefined && <button className="small-button" disabled={disabled} onClick={() => void setSource(null)}>不再更新</button>}
              <button className="ghost small-button" onClick={() => setEditing(false)}>取消</button>
            </span>
          )}
        </dd>
      </dl>

      {!confirming ? (
        <div className="key-actions">
          <span className="muted small">
            {update === undefined ? '还没有检查过更新' : update.available ? `有新版本 ${update.latest}` : `已是最新（${update.latest}）`}
            {update !== undefined && ` · ${relativeTime(update.checkedAt, now)}检查`}
          </span>
          <span className="spacer" />
          <button className="small-button" disabled={disabled || script.updateFrom === undefined} onClick={() => void act('check', async () => {
            const r = await client.connection.call('scripts/checkUpdate', { id: script.id })
            return r.available ? `发现新版本 ${r.latest}${r.current === undefined ? '（认不出当前版本）' : `，当前 ${r.current}`}` : '已是最新版本'
          })}>{busy === 'check' ? '检查中…' : '检查更新'}</button>
          <button className="primary small-button" disabled={disabled || update?.available !== true} onClick={() => setConfirming(true)}>更新</button>
        </div>
      ) : (
        <div className="local-confirm">
          <p className="small">
            将在 <code>{script.dir}</code> 里更新到 {update?.latest}：被替换的程序文件先备份到工具目录（可以撤销），已有的配置文件不动。请先关闭这个脚本。
          </p>
          <div className="key-actions">
            <span className="spacer" />
            <button className="small-button" onClick={() => setConfirming(false)}>取消</button>
            <button className="primary small-button" disabled={disabled} onClick={() => void act('update', async () => {
              setConfirming(false)
              const r = await client.connection.call('scripts/update', { id: script.id })
              return r.upToDate ? '已是最新版本' : undefined
            })}>确认更新</button>
          </div>
        </div>
      )}

      {script.undo !== undefined && (
        <div className="key-actions">
          <span className="muted small">上次更新：{script.undo.from ?? '（未知版本）'} → {script.undo.to} · {relativeTime(script.undo.at, now)}</span>
          <span className="spacer" />
          <button className="small-button" disabled={disabled} onClick={() => void act('restore', async () => {
            const r = await client.connection.call('scripts/restore', { id: script.id })
            return `已撤销，换回了更新前的文件${r.localVersion === undefined ? '' : `（${r.localVersion.version}）`}`
          })}>{busy === 'restore' ? '撤销中…' : '撤销上次更新'}</button>
        </div>
      )}
    </div>
  )
}
