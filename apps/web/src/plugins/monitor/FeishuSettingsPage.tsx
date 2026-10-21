import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { FEISHU_SECRET_REF, type ChannelStatus, type RequestResult } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { relativeTime } from '../../components/SessionList.tsx'
import { useNow, useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'

type View = RequestResult<'feishu/settings'>

const STATE: Readonly<Record<ChannelStatus['state'], [string, string]>> = {
  off: ['', '未启用'], connecting: ['', '连接中'], ready: ['ok', '已连接'], error: ['warn', '有问题'],
}

/** The Feishu channel: app credentials, connection self-check, who may use the bot. */
export function FeishuSettingsPage({ client }: { client: AdgClient }) {
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
  const [chatId, setChatId] = useState('')
  const [manual, setManual] = useState('')
  const [names, setNames] = useState<Record<string, string>>({})

  useEffect(() => client.connection.on('notify/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('feishu/settings', {}).then(v => {
      if (!live) return
      setView(v)
      setAppId(a => a === '' ? v.settings.appId ?? '' : a)
      setChatId(c => c === '' ? v.settings.chatId ?? '' : c)
    }).catch(e => { if (live) setError(errorText(e)) })
    client.connection.call('notify/status', {}).then(s => { if (live) setChannel(s.channels.find(c => c.id === 'feishu') ?? null) }).catch(() => {})
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
    if (secret.trim() !== '') await client.setCredential(FEISHU_SECRET_REF, secret.trim())
    setSecret('')
    return client.connection.call('feishu/settings/set', { appId: appId.trim() === '' ? null : appId.trim(), enabled: true })
  }, '已保存，正在连接…')

  const test = () => act('test', async () => {
    const result = await client.connection.call('notify/test', { channel: 'feishu' })
    if (result.failed.length > 0) throw new Error(result.failed.map(f => f.error).join('；'))
  }, '测试消息已发送，去飞书看看')

  const settings = view?.settings
  const [tone, label] = STATE[channel?.state ?? 'off']

  return (
    <div className="settings-page">
      <h2>飞书</h2>
      <p>脚本出问题时把通知（带截图和「停止 / 重试 / 忽略」按钮）发到飞书；在飞书里直接回复就能让 agent 干活，例如「现在什么状态」「跑一下方舟日常」。agent 需要你确认的操作也会发成卡片，在飞书或这里先回答的生效。</p>

      <details className="card guide">
        <summary><strong>第一次使用：在飞书开放平台创建应用（约 5 分钟）</strong></summary>
        <ol className="guide-steps">
          <li>打开 <a href="https://open.feishu.cn/app" target="_blank" rel="noreferrer">open.feishu.cn/app</a>（国际版 Lark 用 open.larksuite.com/app），「创建企业自建应用」。</li>
          <li>「添加应用能力」→ 添加「机器人」。</li>
          <li>「权限管理」开通：<code>im:message</code>（获取与发送单聊、群组消息）、<code>im:message:send_as_bot</code>、<code>im:message.p2p_msg:readonly</code>（读取用户发给机器人的单聊消息）、<code>im:message.group_at_msg:readonly</code>（接收群聊中 @ 机器人的消息，可选）、<code>im:resource</code>（上传截图）。</li>
          <li>「事件与回调」→「事件配置」：订阅方式选<strong>使用长连接接收事件</strong>，添加事件 <code>im.message.receive_v1</code>（接收消息）。</li>
          <li>「事件与回调」→「回调配置」：订阅方式同样选<strong>使用长连接接收回调</strong>，添加回调 <code>card.action.trigger</code>（卡片回传交互）。</li>
          <li>「版本管理与发布」创建版本并发布，可用范围包含你自己。权限或事件改过以后都要重新发布才生效。</li>
          <li>把「凭证与基础信息」里的 App ID 和 App Secret 填到下面；保存后在飞书里搜索机器人名字，给它发一条消息，再回到这里「允许」自己。</li>
        </ol>
        <p className="muted small">先保存凭证再配置长连接：飞书要求应用在线时才能保存「长连接」订阅方式。</p>
      </details>

      <section className="card">
        <div className="card-head">
          <div><h3>连接</h3><p className="muted small">{channel?.detail ?? (channel?.state === 'ready' ? `通知会发给 ${channel.recipients} 个接收方` : '…')}</p></div>
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
          <button className="small-button" disabled={busy !== null} onClick={() => void act('check', () => client.connection.call('feishu/check', {}))}>{busy === 'check' ? '检查中…' : '重新检查'}</button>
          <button className="small-button" disabled={busy !== null || channel?.state !== 'ready'} onClick={() => void test()}>发送测试消息</button>
          {settings !== undefined && (
            <label className="check-label"><input type="checkbox" checked={settings.enabled} disabled={busy !== null}
              onChange={e => void act('enable', () => client.connection.call('feishu/settings/set', { enabled: e.target.checked }))} />启用飞书</label>
          )}
        </div>
      </section>

      {settings !== undefined && (
        <section className="card">
          <h3>应用凭证</h3>
          <label className="field-label" htmlFor="feishu-domain">平台</label>
          <select id="feishu-domain" className="text-input plain" value={settings.domain} disabled={busy !== null}
            onChange={e => void act('domain', () => client.connection.call('feishu/settings/set', { domain: e.target.value as 'feishu' | 'lark' }))}>
            <option value="feishu">飞书（open.feishu.cn）</option>
            <option value="lark">Lark 国际版（open.larksuite.com）</option>
          </select>
          <label className="field-label" htmlFor="feishu-app-id">App ID</label>
          <input id="feishu-app-id" className="text-input" value={appId} onChange={e => setAppId(e.target.value)} placeholder="cli_xxxxxxxx" spellCheck={false} />
          <label className="field-label" htmlFor="feishu-secret">App Secret {view?.secretConfigured === true && <span className="badge ok">已保存</span>}</label>
          <input id="feishu-secret" className="text-input" type="password" value={secret} onChange={e => setSecret(e.target.value)}
            placeholder={view?.secretConfigured === true ? '留空则保持不变' : '在「凭证与基础信息」里复制'} spellCheck={false} autoComplete="off" />
          <p className="muted small">App Secret 存在本机的 dsh 凭据里，不会再显示出来。</p>
          <div className="key-actions"><span className="spacer" /><button className="primary small-button" disabled={busy !== null || appId.trim() === ''} onClick={() => void saveCredentials()}>{busy === 'credentials' ? '保存中…' : '保存并连接'}</button></div>
        </section>
      )}

      {settings !== undefined && (
        <section className="card">
          <h3>允许的用户</h3>
          <p className="muted small">只有这些人能给机器人下指令、按卡片上的按钮；通知也发给他们。</p>
          {settings.allowedUsers.length === 0 && <div className="muted small">还没有。给机器人发一条消息，它会出现在下面的「待允许」里。</div>}
          <ul className="version-list">
            {settings.allowedUsers.map(u => (
              <li key={u.openId}>
                <span>{u.name ?? '（未命名）'}</span>
                <span className="muted small">{u.openId}</span>
                <span className="spacer" />
                <button className="small-button" disabled={busy !== null} onClick={() => void act(`rm-${u.openId}`, () => client.connection.call('feishu/users/remove', { openId: u.openId }))}>移除</button>
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
                    <button className="small-button" disabled={busy !== null} onClick={() => void act(`dismiss-${p.openId}`, () => client.connection.call('feishu/users/remove', { openId: p.openId }))}>忽略</button>
                    <button className="primary small-button" disabled={busy !== null}
                      onClick={() => void act(`allow-${p.openId}`, () => client.connection.call('feishu/users/allow', { openId: p.openId, ...(names[p.openId]?.trim() ? { name: names[p.openId]!.trim() } : {}) }))}>允许</button>
                  </li>
                ))}
              </ul>
            </>
          )}
          <label className="field-label" htmlFor="feishu-manual">手动添加 open_id</label>
          <div className="key-input">
            <input id="feishu-manual" className="text-input" value={manual} onChange={e => setManual(e.target.value)} placeholder="ou_xxxxxxxx" spellCheck={false} />
            <button className="small-button" disabled={busy !== null || manual.trim() === ''} onClick={() => void act('manual', async () => { const v = await client.connection.call('feishu/users/allow', { openId: manual.trim() }); setManual(''); return v })}>添加</button>
          </div>
        </section>
      )}

      {settings !== undefined && (
        <section className="card">
          <h3>通知</h3>
          <label className="check-label"><input type="checkbox" checked={settings.otherApprovals} disabled={busy !== null}
            onChange={e => void act('approvals', () => client.connection.call('feishu/settings/set', { otherApprovals: e.target.checked }))} />软件里的会话（对话、定时运行、游戏读取）需要确认或 agent 提问时也发到飞书</label>
          <p className="muted small">在飞书里和 agent 的对话需要确认、或 agent 有问题问你时，只发给发消息的那个人（直接回复文字也算回答）；软件里的会话默认只在界面里问。两边都能回答，先回答的生效。</p>
          <label className="field-label" htmlFor="feishu-chat">同时发到群（可选，填群 ID，机器人需要在群里）</label>
          <div className="key-input">
            <input id="feishu-chat" className="text-input" value={chatId} onChange={e => setChatId(e.target.value)} placeholder="oc_xxxxxxxx" spellCheck={false} />
            <button className="small-button" disabled={busy !== null} onClick={() => void act('chat', () => client.connection.call('feishu/settings/set', { chatId: chatId.trim() === '' ? null : chatId.trim() }))}>保存</button>
          </div>
        </section>
      )}

      {info !== null && <div className="notice info left"><Icon name="check" /><span>{info}</span></div>}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </div>
  )
}
