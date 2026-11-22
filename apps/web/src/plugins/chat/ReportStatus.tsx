import type { ChatItem } from '@adg/client-core'
import './ReportStatus.css'

type Tone = 'running' | 'waiting' | 'ok' | 'failed' | 'neutral'

/** A short, accessible counterpart to the step details in the full transcript. */
export function ReportStatus({ label, status, tone = 'running', onOpen, href }: {
  label: string
  status?: string | undefined
  tone?: Tone
  onOpen?: (() => void) | undefined
  href?: string | undefined
}) {
  const words = <><span className="report-action">{label}</span>{status && <small aria-live="polite">{status}</small>}</>
  return (
    <div className="report-status" data-tone={tone}>
      <span className="report-agent-mark" aria-hidden="true" />
      {href ? <a href={href}>{words}</a> : onOpen ? <button type="button" onClick={onOpen}>{words}</button> : <span>{words}</span>}
    </div>
  )
}

type Tool = Extract<ChatItem, { kind: 'tool' }>
const TOOL_ACTIVITY: Readonly<Record<string, string>> = {
  web_fetch: '正在读取网页', web_search: '正在搜索网页', read: '正在读取文件',
  write: '正在写入文件', edit: '正在编辑文件', run_code: '正在运行代码',
  game_activities: '正在核对游戏活动', game_notice: '正在保存公告', game_record: '正在保存活动',
  agent_threads: '正在查看任务进度', agent_message: '正在发送任务消息',
  script_runs: '正在查看脚本运行状态',
}

/** Only active calls from the current turn describe what is happening now. */
export function reportToolActivity(tool: Tool): string {
  if (tool.approval === 'asked') return '等待你批准操作'
  if (tool.name === 'ask_user_question') return '等待你回答问题'
  if (tool.name === 'run_code') {
    try {
      const { title } = JSON.parse(tool.arguments)
      if (typeof title === 'string' && title.trim()) return title.trim()
    } catch { /* Arguments may still be streaming. */ }
  }
  return TOOL_ACTIVITY[tool.name] ?? `正在调用 ${tool.name}`
}
