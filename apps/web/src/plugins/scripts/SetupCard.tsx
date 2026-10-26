/**
 * A setup program waiting to be installed (the release was an NSIS / Inno
 * Setup installer, not an archive). The agent may be on it; the user can also
 * install it themselves — needed when no model is set up yet: open its window
 * (the folder prefilled), click through, then import the folder it installed into.
 */
import { useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { PendingSetupInfo } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { errorText } from './data.ts'

const KIND: Record<PendingSetupInfo['kind'], string> = { nsis: 'NSIS', inno: 'Inno Setup' }

export function SetupCard({ client, setup, openSession, onImported }: {
  client: AdgClient
  setup: PendingSetupInfo
  openSession: (sessionId: string) => void
  onImported: (scriptId: string) => void
}) {
  const [path, setPath] = useState(setup.dir)
  const [opened, setOpened] = useState(false)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [confirmDiscard, setConfirmDiscard] = useState(false)
  const agent = setup.agent
  const act = async (what: string, work: () => Promise<void>) => {
    setBusy(what)
    setError(null)
    try { await work() } catch (e) { setError(errorText(e)) } finally { setBusy(null) }
  }

  return (
    <section className="card setup-card">
      <div className="card-head">
        <div>
          <h3>{setup.update ? '更新' : '安装'} {setup.name} {setup.version}</h3>
          <p className="muted small">下载到的是 {KIND[setup.kind]} 安装程序，不是压缩包：要运行它把文件装好，再导入装好的文件夹。</p>
        </div>
      </div>

      {agent?.state === 'running' && (
        <div className="notice left"><Icon name="info" /><span>agent 正在安装。也可以不等它，按下面的步骤自己装。</span>
          <button className="link-button" onClick={() => openSession(agent.sessionId)}>查看对话</button></div>
      )}
      {agent?.state === 'failed' && (
        <div className="notice warn-box left"><Icon name="alert" /><span>agent 没能装好：{agent.reason ?? '原因不明'}。可以按下面的步骤自己装，也可以之后再交给 agent。</span>
          <button className="link-button" onClick={() => openSession(agent.sessionId)}>查看对话</button></div>
      )}

      <ol className="setup-steps">
        <li><div className="setup-step">
          <span>打开安装程序，按它的提示装完。安装位置已经填好，保持不变；最后不用勾选「立即运行」。</span>
          <button className="small-button" disabled={busy !== null} onClick={() => void act('open', async () => {
            await client.connection.call('scripts/setup/open', { id: setup.scriptId })
            setOpened(true)
          })}>{busy === 'open' ? '正在打开…' : opened ? '再打开一次' : '打开安装程序'}</button>
        </div></li>
        <li><div className="setup-step">
          <span>装好后导入装好的文件夹。{setup.update ? '' : '改了安装位置的话，填你选的文件夹。'}</span>
          <form className="setup-import" onSubmit={e => { e.preventDefault(); void act('import', async () => {
            const info = await client.connection.call('scripts/import', { path: path.trim().replace(/^"|"$/g, ''), id: setup.scriptId })
            onImported(info.id)
          }) }}>
            <input className="text-input plain" aria-label="装好的文件夹" value={path} onChange={e => setPath(e.target.value)} spellCheck={false} disabled={busy !== null} />
            <button className="primary small-button" type="submit" disabled={busy !== null || path.trim() === ''}>{busy === 'import' ? '导入中…' : '装好了，导入'}</button>
          </form>
        </div></li>
      </ol>

      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}

      <div className="key-actions">
        {!confirmDiscard ? (
          <>
            {agent?.state !== 'running' && (
              <button className="small-button" disabled={busy !== null} onClick={() => void act('agent', async () => {
                const { sessionId } = await client.connection.call('scripts/setup/agent', { id: setup.scriptId })
                openSession(sessionId)
              })}>{busy === 'agent' ? '正在交给 agent…' : '让 agent 安装'}</button>
            )}
            <span className="spacer" />
            <button className="danger-outline small-button" disabled={busy !== null} onClick={() => setConfirmDiscard(true)}>不装了</button>
          </>
        ) : (
          <>
            <span className="muted small">删除下载好的安装程序，什么都不装。</span>
            <span className="spacer" />
            <button className="small-button" onClick={() => setConfirmDiscard(false)}>取消</button>
            <button className="danger small-button" disabled={busy !== null} onClick={() => void act('discard', async () => {
              await client.connection.call('scripts/setup/discard', { id: setup.scriptId })
            })}>确认删除</button>
          </>
        )}
      </div>
    </section>
  )
}
