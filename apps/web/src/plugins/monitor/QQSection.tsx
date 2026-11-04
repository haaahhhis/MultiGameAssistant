import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { QQBOT_SECRET_REF, type ChannelStatus, type RequestResult } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

type View = RequestResult<'qqbot/settings'>

const STATE: Readonly<Record<ChannelStatus['state'], [string, string]>> = {
  off: ['', '未启用'], connecting: ['', '连接中'], ready: ['ok', '已连接'], error: ['warn', '有问题'],
}

/** The QQ official bot (远程连接 → QQ 机器人): AppID and AppSecret, connection self-check, who may use the bot. */
export function QQSection({ client }: { client: AdgClient }) {
  const status = useStore(client.connection.status)
  const now = useNow(30_000)
  const [view, setView] = useState<View | null>(null)
  const [channel, setChannel] = useState<ChannelStatus | null>(null)
  const [revision, setRevision] = useState(0)
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [info, setInfo] = useState<string | null>(null)
  const [appId, setAppId] = useState('')
  const [secret, setSecret] = useState('')
  const [manual, setManual] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})

  useEffect(() => client.connection.on('notify/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('qqbot/settings', {}).then(v => {
      if (!live) return
      setView(v)
      setAppId(a => a === '' ? v.settings.appId ?? '' : a)
    }).catch(e => { if (live) setError(errorText(e)) })
    client.connection.call('notify/status', {}).then(s => { if (live) setChannel(s.channels.find(c => c.id === 'qq') ?? null) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, revision])

  const act = async (name: string, fn: () => Promise<unknown>, done?: string) => {
    setBusy(name)
    setError(null)
    setInfo(null)
    try {
      const result = await fn()
      if (result !== null && typeof result === 'object' && 'settings' in result) setView(result as View)
      if (done !== undefined) setInfo(done)
      setRevision(r => r + 1)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(null)
    }
  }

  const saveCredentials = () => act('credentials', async () => {
    if (secret.trim() !== '') await client.setCredential(QQBOT_SECRET_REF, secret.trim())
    setSecret('')
    return client.connection.call('qqbot/settings/set', { appId: appId.trim() === '' ? null : appId.trim(), enabled: true })
  }, '已保存，正在连接…')

  const test = () => act('test', async () => {
    const result = await client.connection.call('notify/test', { channel: 'qq' })
    if (result.failed.length > 0) throw new Error(result.failed.map(f => f.error).join('；'))
  }, '测试消息已发送，去 QQ 看看')

  const settings = view?.settings
  const [tone, label] = STATE[channel?.state ?? 'off']

  return (
    <div className="remote-section">
      <p className="muted">QQ 官方机器人：在 QQ 里和它单聊。通知和对话都是文字；需要确认的操作在软件里点，agent 问你问题时直接回复文字就行。</p>

      <details className="card guide">
        <summary><strong>第一次使用：在 QQ 开放平台创建机器人（约 10 分钟）</strong></summary>
        <ol className="guide-steps">
          <li>打开 <a href="https://bot.q.qq.com/open" target="_blank" rel="noreferrer">QQ 开放平台</a>，用 QQ 扫码登录，创建一个机器人。</li>
          <li>在机器人的「开发设置」里复制 <strong>AppID</strong> 和 <strong>AppSecret</strong>，填到下面。</li>
          <li>「功能配置」里开启<strong>单聊</strong>（消息走 WebSocket，不用填回调地址）。还在沙箱阶段的机器人，要把自己的 QQ 加进「沙箱配置」的测试成员。</li>
          <li>保存后用手机 QQ 找到机器人（资料卡或沙箱二维码），给它发一条消息，再回到这里「允许」自己。</li>
        </ol>
        <p className="muted small">机器人发给你的不是回复的消息（同步的对话、通知）算「主动消息」：在机器人资料卡里要开着「允许主动发送」。</p>
      </details>

      <section className="card">
        <div className="card-head">
          <div><h3>连接</h3><p className="muted small">{channel?.detail ?? (channel?.state === 'ready' ? `通知和对话会发给 ${channel.recipients} 个人` : '…')}</p></div>
          <span className={`badge ${tone}`}>{label}</span>
        </div>
        {channel !== null && channel.checks.length > 0 && (
          <ul className="check-list">
            {channel.checks.map(c => (
              <li key={c.id} className={c.ok === true ? 'ok' : c.ok === false ? 'failed' : ''}>
                <span className="check-mark">{c.ok === true ? '✓' : c.ok === false ? '✗' : '…'}</span>
                <span>{c.label}</span>
                {c.detail !== undefined && <span className="muted small">{c.detail}</span>}
              </li>
            ))}
          </ul>
        )}
        <div className="key-actions">
          <button className="small-button" disabled={busy !== null} onClick={() => void act('check', () => client.connection.call('qqbot/check', {}))}>{busy === 'check' ? '检查中…' : '重新检查'}</button>
          <button className="small-button" disabled={busy !== null || channel?.state !== 'ready'} onClick={() => void test()}>发送测试消息</button>
          {settings !== undefined && (
            <label className="check-label"><input type="checkbox" checked={settings.enabled} disabled={busy !== null}
              onChange={e => void act('enable', () => client.connection.call('qqbot/settings/set', { enabled: e.target.checked }))} />启用 QQ 机器人</label>
          )}
        </div>
      </section>

      {settings !== undefined && (
        <section className="card">
          <h3>机器人凭证</h3>
          <label className="field-label" htmlFor="qq-app-id">AppID</label>
          <input id="qq-app-id" className="text-input" value={appId} onChange={e => setAppId(e.target.value)} placeholder="102xxxxxx" spellCheck={false} inputMode="numeric" />
          <label className="field-label" htmlFor="qq-secret">AppSecret {view?.secretConfigured === true && <span className="badge ok">已保存</span>}</label>
          <input id="qq-secret" className="text-input" type="password" value={secret} onChange={e => setSecret(e.target.value)}
            placeholder={view?.secretConfigured === true ? '留空则保持不变' : '在「开发设置」里复制'} spellCheck={false} autoComplete="off" />
          <p className="muted small">AppSecret 存在本机的 dsh 凭据里，不会再显示出来。</p>
          <div className="key-actions"><span className="spacer" /><button className="primary small-button" disabled={busy !== null || appId.trim() === ''} onClick={() => void saveCredentials()}>{busy === 'credentials' ? '保存中…' : '保存并连接'}</button></div>
        </section>
      )}

      {settings !== undefined && (
        <section className="card">
          <h3>允许的用户</h3>
          <p className="muted small">只有这些人能给机器人下指令；通知和与助手的对话也发给他们。</p>
          {settings.allowedUsers.length === 0 && <div className="muted small">还没有。在 QQ 里给机器人发一条消息，它会出现在下面的「待允许」里。</div>}
          <ul className="version-list">
            {settings.allowedUsers.map(u => (
              <li key={u.openId}>
                <span>{u.name ?? '（未命名）'}</span>
                <span className="muted small">{u.openId}</span>
                <span className="spacer" />
                <button className="small-button" disabled={busy !== null} onClick={() => void act(`rm-${u.openId}`, () => client.connection.call('qqbot/users/remove', { openId: u.openId }))}>移除</button>
              </li>
            ))}
          </ul>
          {(view?.pending.length ?? 0) > 0 && (
            <>
              <div className="sidebar-label">待允许（给机器人发过消息的人）</div>
              <ul className="version-list">
                {view!.pending.map(p => (
                  <li key={p.openId}>
                    <span className="muted small">{p.openId}</span>
                    <span className="muted small">「{p.text}」 · {relativeTime(p.at, now)}</span>
                    <span className="spacer" />
                    <input className="text-input plain inline-name" placeholder="称呼（可选）" value={names[p.openId] ?? ''} onChange={e => setNames(n => ({ ...n, [p.openId]: e.target.value }))} />
                    <button className="small-button" disabled={busy !== null} onClick={() => void act(`dismiss-${p.openId}`, () => client.connection.call('qqbot/users/remove', { openId: p.openId }))}>忽略</button>
                    <button className="primary small-button" disabled={busy !== null}
                      onClick={() => void act(`allow-${p.openId}`, () => client.connection.call('qqbot/users/allow', { openId: p.openId, ...(names[p.openId]?.trim() ? { name: names[p.openId]!.trim() } : {}) }))}>允许</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <label className="field-label" htmlFor="qq-manual">手动添加 user_openid</label>
          <div className="key-input">
            <input id="qq-manual" className="text-input" value={manual} onChange={e => setManual(e.target.value)} placeholder="机器人回复你的那条消息里有" spellCheck={false} />
            <button className="small-button" disabled={busy !== null || manual.trim() === ''} onClick={() => void act('manual', async () => { const v = await client.connection.call('qqbot/users/allow', { openId: manual.trim() }); setManual(''); return v })}>添加</button>
          </div>
        </section>
      )}

      {info !== null && <div className="notice info left"><Icon name="check" /><span>{info}</span></div>}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}
