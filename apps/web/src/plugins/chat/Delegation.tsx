import { useMemo } from 'react'
import type { AdgClient, ChatItem } from '@adg/client-core'
import { MAIN, agentOf, useLastReplies, useRoles } from '../../agents.ts'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { useStore } from '../../hooks.ts'

/** The main agent's tool for handing work to another agent (packages/notify/src/delegate.ts). */
export const DELEGATE_TOOL = 'agent_delegate'

/** The note delegate.ts puts before the task in the work's first message. */
const NOTE = /^（助手交给你的事：[^）]*）\n\n/

/** The task, when this message is work 助手 handed over (in the agent's own session); undefined: the person's. */
export function fromMain(text: string): string | undefined {
  return NOTE.test(text) ? text.replace(NOTE, '') : undefined
}

function argsOf(json: string): { agent: string; task: string; expecting?: string } {
  try {
    const a = JSON.parse(json) as { agent?: unknown; task?: unknown; expecting?: unknown }
    return { agent: String(a.agent ?? ''), task: String(a.task ?? ''), ...(typeof a.expecting === 'string' && a.expecting !== '' ? { expecting: a.expecting } : {}) }
  } catch {
    return { agent: '', task: json }
  }
}

/**
 * Work 助手 handed to another agent, in 助手's conversation: who to, the task
 * as 助手 wrote it, then — while the agent works — what it last said, and
 * once it is done, its reply. The work's own session opens from 「查看过程」.
 */
export function DelegationCard({ client, sessionId, item }: { client: AdgClient; sessionId: string; item: Extract<ChatItem, { kind: 'tool' }> }) {
  const roles = useRoles(client)
  const sessions = useStore(client.sessions)
  const { agent: name, task, expecting } = useMemo(() => argsOf(item.arguments), [item.arguments])
  const role = roles.find(r => r.name === name || r.id === name)
  const agent = role === undefined ? undefined : agentOf(role)
  const work = sessions.items.find(s => s.delegatedFrom?.sessionId === sessionId && s.delegatedFrom.callId === item.callId)
  const running = item.status === 'running'
  const replies = useLastReplies(client, running && work !== undefined ? [{ id: work.id, updatedAt: work.updatedAt, running: work.running }] : [])
  const now = work === undefined ? undefined : replies.get(work.id)
  const shown = agent?.name ?? name
  return (
    <div className={`delegation ${item.status}`}>
      <div className="delegation-head">
        <span className={`agent-avatar small agent-${agent?.id ?? 'unknown'}`}><Icon name={agent?.icon ?? 'sparkles'} /></span>
        <span className="delegation-who">{MAIN.name}<Icon name="arrow" className="delegation-arrow" /><strong>{shown}</strong></span>
        <span className={`delegation-state tone-${item.status === 'ok' ? 'ok' : item.status === 'error' || item.status === 'interrupted' ? 'failed' : 'running'}`}>
          {running ? '进行中' : item.status === 'ok' ? '交回了' : '没做成'}
        </span>
        <span className="spacer" />
        {work !== undefined && <a className="delegation-open" href={`#/s/${encodeURIComponent(work.id)}`}>查看过程<Icon name="chevron" /></a>}
      </div>
      <div className="delegation-said">
        <div className="delegation-label">{MAIN.name} 交给 {shown}</div>
        <div className="delegation-task">{task}</div>
        {expecting !== undefined && <div className="delegation-expecting">要交回：{expecting}</div>}
      </div>
      {running && (
        <div className="delegation-now">
          <span className="tool-spinner" role="img" aria-label="进行中" />
          <span>{now != null && now !== '' ? now : `${shown} 正在做…`}</span>
        </div>
      )}
      {!running && item.result !== undefined && item.status === 'ok' && (
        <div className="delegation-said reply">
          <div className="delegation-label">{shown} 的回复</div>
          <Markdown text={item.result} />
        </div>
      )}
      {!running && item.status !== 'ok' && (
        <div className="delegation-failed"><Icon name="alert" />{item.result ?? item.error ?? '没有回来'}</div>
      )}
    </div>
  )
}
