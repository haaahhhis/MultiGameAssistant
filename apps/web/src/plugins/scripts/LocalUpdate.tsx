/**
 * Updates for a locally imported script: the version found in its folder,
 * where it updates from (GitHub and Mirror酱, each on its own), and
 * an in-place update that backs up what it replaces and can be undone.
 */
import { useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ScriptInfo } from '@adg/protocol'
import { relativeTime } from '../../components/SessionList.tsx'
import { ChannelRows } from './Channels.tsx'

export function LocalUpdate({ client, script, disabled, busy, now, act }: {
  client: AdgClient
  script: ScriptInfo
  disabled: boolean
  busy: string | null
  now: number
  act: (name: string, fn: () => Promise<string | void>) => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const version = script.localVersion
  const update = script.update
  const channels = script.channels.github !== undefined || script.channels.mirrorchyan !== undefined

  return (
    <div className="local-update">
      <dl className="local-facts">
        <dt>当前版本</dt>
        <dd>
          {version !== undefined
            ? <><span className="version-name">{version.version}</span><span className="muted small">{version.from === '更新' ? '（由 MultiGameAssistant 更新）' : `（读自 ${version.from}）`}</span></>
            : <span className="muted small">认不出这个目录的版本：检查更新时会当作可以更新</span>}
        </dd>
        <ChannelRows client={client} script={script} disabled={disabled} act={act} />
      </dl>

      {!confirming ? (
        <div className="key-actions">
          <span className="muted small">
            {update === undefined ? '还没有检查过更新' : update.available ? `有新版本 ${update.latest}` : `已是最新（${update.latest}）`}
            {update !== undefined && ` · ${relativeTime(update.checkedAt, now)}检查`}
          </span>
          <span className="spacer" />
          <button className="small-button" disabled={disabled || !channels} onClick={() => void act('check', async () => {
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
