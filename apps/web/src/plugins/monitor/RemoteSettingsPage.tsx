import { useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import { useStore } from '../../hooks.ts'
import { FeishuSection } from './FeishuSection.tsx'
import { QQSection } from './QQSection.tsx'

const CHANNELS = [
  { id: 'feishu', title: '飞书', capability: 'feishu', component: FeishuSection },
  { id: 'qq', title: 'QQ 机器人', capability: 'qqbot', component: QQSection },
] as const

/**
 * 远程连接: talking to 助手 from a chat app — Feishu, the QQ official bot.
 * Its conversation is the same there as in the app; notices go there too.
 */
export function RemoteSettingsPage({ client }: { client: AdgClient }) {
  const capabilities = useStore(client.capabilities)
  const shown = CHANNELS.filter(c => capabilities.has(c.capability))
  const [open, setOpen] = useState<string>(shown[0]?.id ?? 'feishu')
  const current = shown.find(c => c.id === open) ?? shown[0]
  return (
    <div className="settings-page">
      <h2>远程连接</h2>
      <p>不在电脑前也能用：在飞书或 QQ 里和助手说话。和助手的对话两边完全一样——在软件里说的、在聊天软件里说的、助手和其他 agent 之间的往来、助手的回复，都会同步过去；脚本出问题的通知也发到那里，在聊天软件里点按钮或直接回复就能处理。</p>
      {shown.length > 1 && (
        <nav className="agent-tabs remote-tabs" role="tablist" aria-label="远程连接方式">
          {shown.map(c => (
            <button key={c.id} role="tab" aria-selected={c.id === current?.id} className={c.id === current?.id ? 'active' : ''} onClick={() => setOpen(c.id)}>{c.title}</button>
          ))}
        </nav>
      )}
      {current === undefined ? <p className="muted">当前连接没有提供远程连接。</p> : <current.component key={current.id} client={client} />}
    </div>
  )
}
