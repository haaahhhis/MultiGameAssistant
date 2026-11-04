import { useMemo, useRef, useState } from 'react'
import type { AdgClient, ChatItem } from '@adg/client-core'
import { BY_YOU, type HandOff, type RelayNote, type TaskNote } from '@adg/protocol'
import { MAIN, agentOf, useLastReplies, useRoles, type Agent } from '../../agents.ts'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { useStore } from '../../hooks.ts'

/**
 * What agents say to each other, as each conversation shows it
 * (docs/design/agent-roles.md §10): in the one that asked, the work it handed
 * on and the reply that came back; in the one that did it, the work it was
 * handed. Only messages cross; the steps stay where they were taken.
 */

/** The main agent's tool for handing work to another agent (packages/notify/src/delegate.ts). */
export const DELEGATE_TOOL = 'agent_delegate'

function argsOf(json: string): { agent: string; task: string; expecting?: string } {
  try {
    const a = JSON.parse(json) as { agent?: unknown; task?: unknown; expecting?: unknown }
    return { agent: String(a.agent ?? ''), task: String(a.task ?? ''), ...(typeof a.expecting === 'string' && a.expecting !== '' ? { expecting: a.expecting } : {}) }
  } catch {
    return { agent: '', task: json }
  }
}

function useAgent(client: AdgClient, nameOrId: string): Agent | undefined {
  const roles = useRoles(client)
  const role = roles.find(r => r.name === nameOrId || r.id === nameOrId)
  return role === undefined ? (nameOrId === MAIN.name ? MAIN : undefined) : agentOf(role)
}

const STATE: Readonly<Record<HandOff['state'], { label: string; tone: string }>> = {
  running: { label: '进行中', tone: 'running' },
  done: { label: '交回了', tone: 'ok' },
  failed: { label: '没做成', tone: 'failed' },
}

/**
 * Work 助手 handed on (agent_delegate), in 助手's conversation: who to, the
 * task as 助手 wrote it, and where it stands — while the agent works, what it
 * last said. Its reply comes back below as its own message.
 */
export function DelegationCard({ client, item, handOffs }: { client: AdgClient; item: Extract<ChatItem, { kind: 'tool' }>; handOffs: readonly HandOff[] }) {
  const { agent: name, task, expecting } = useMemo(() => argsOf(item.arguments), [item.arguments])
  const agent = useAgent(client, name)
  const handOff = handOffs.find(h => h.callId === item.callId)
  const refused = item.status === 'error' || item.status === 'interrupted'
  const state = refused ? STATE.failed : handOff === undefined ? (item.status === 'running' ? STATE.running : undefined) : STATE[handOff.state]
  const shown = agent?.name ?? name
  return (
    <div className={`delegation ${state?.tone ?? ''}`}>
      <HandOffHead agent={agent} name={shown} from={MAIN.name} state={state} />
      <div className="delegation-said">
        <div className="delegation-task">{task}</div>
        {expecting !== undefined && <div className="delegation-expecting">要交回：{expecting}</div>}
      </div>
      {handOff?.state === 'running' && <Working client={client} handOff={handOff} name={shown} />}
      {handOff?.state === 'done' && <div className="delegation-note">回复见下方「消息来自 {shown}」</div>}
      {refused && <div className="delegation-failed"><Icon name="alert" />{item.result ?? item.error ?? '没有交出去'}</div>}
    </div>
  )
}

/** Work the app handed on itself (监控 → 干预) still going: shown at the end of 助手's conversation until the reply comes. */
export function HandOffStrip({ client, handOff }: { client: AdgClient; handOff: HandOff }) {
  const agent = useAgent(client, handOff.to)
  const name = agent?.name ?? handOff.to
  return (
    <div className="delegation running app-handoff">
      <HandOffHead agent={agent} name={name} from={handOff.by} state={STATE.running} />
      <div className="delegation-said"><div className="delegation-task">{handOff.title}</div></div>
      <Working client={client} handOff={handOff} name={name} />
    </div>
  )
}

function HandOffHead({ agent, name, from, state }: { agent: Agent | undefined; name: string; from: string; state: { label: string; tone: string } | undefined }) {
  return (
    <div className="delegation-head">
      <span className={`agent-avatar small agent-${agent?.id ?? 'unknown'}`}><Icon name={agent?.icon ?? 'sparkles'} /></span>
      <span className="delegation-who">{from}<Icon name="arrow" className="delegation-arrow" /><strong>{name}</strong></span>
      {state !== undefined && <span className={`delegation-state tone-${state.tone}`}>{state.label}</span>}
      <span className="spacer" />
      {agent !== undefined && <a className="delegation-open" href={`#/a/${encodeURIComponent(agent.id)}`}>查看过程<Icon name="chevron" /></a>}
    </div>
  )
}

/** What the agent doing the work has said since: its conversation's last reply, once it is not the one from before. */
function Working({ client, handOff, name }: { client: AdgClient; handOff: HandOff; name: string }) {
  const session = useStore(client.sessions).items.find(s => s.id === handOff.toSession)
  const replies = useLastReplies(client, session === undefined ? [] : [{ id: session.id, updatedAt: session.updatedAt, running: session.running }])
  const now = session === undefined ? undefined : replies.get(session.id)
  const before = useRef<string | null | undefined>(undefined)
  if (before.current === undefined && now !== undefined) before.current = now
  const fresh = now != null && now !== '' && now !== before.current ? now : undefined
  return (
    <div className="delegation-now">
      <span className="tool-spinner" role="img" aria-label="进行中" />
      <span>{session?.running === true ? fresh ?? `${name} 正在做…` : `排在 ${name} 手上的事后面`}</span>
    </div>
  )
}

/** Replies longer than this fold to their first lines: what 助手 makes of them comes right after. */
const RELAY_FOLD = 280

/** A reply that came back (`（「游戏」交回了…）`), in the conversation that asked: the agent's words, as they came. */
export function RelayMessage({ client, note }: { client: AdgClient; note: RelayNote }) {
  const agent = useAgent(client, note.agent)
  const long = note.reply.length > RELAY_FOLD || note.reply.split('\n').length > 6
  const [open, setOpen] = useState(false)
  return (
    <div className={`relay ${note.ok ? 'ok' : 'failed'}`}>
      <div className="relay-head">
        <span className={`agent-avatar small agent-${agent?.id ?? 'unknown'}`}><Icon name={agent?.icon ?? 'sparkles'} /></span>
        <span>消息来自 <strong>{note.agent}</strong></span>
        <span className={`delegation-state tone-${note.ok ? 'ok' : 'failed'}`}>{note.ok ? '交回了' : '没有做完'}</span>
        <span className="spacer" />
        {agent !== undefined && <a className="delegation-open" href={`#/a/${encodeURIComponent(agent.id)}`}>查看过程<Icon name="chevron" /></a>}
      </div>
      <div className="relay-title">{note.asker === '你' ? MAIN.name : note.asker}交给它的：{note.title}</div>
      <div className={`relay-body ${long && !open ? 'folded' : ''}`}><Markdown text={note.reply} /></div>
      {long && <button className="link-button relay-more" onClick={() => setOpen(!open)}>{open ? '收起' : '展开全部'}</button>}
    </div>
  )
}

/** Work handed to this agent (`（监控交给你的事：…）`): who asked and what; the app's own long instructions fold away. */
export function TaskMessage({ note }: { note: TaskNote }) {
  const from = note.by === BY_YOU ? '你在软件里点的' : `${note.by}交给的事`
  const short = note.by === MAIN.name
  return (
    <div className="msg user delegated">
      <div className="msg-from">{from}</div>
      <div className="bubble">
        {short
          ? <div className="task-note-body">{note.body}</div>
          : <details className="task-note"><summary>{note.title}</summary><div className="task-note-body">{note.body}</div></details>}
      </div>
    </div>
  )
}
