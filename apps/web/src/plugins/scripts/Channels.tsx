/**
 * A script's update channels, GitHub and Mirror酱, each shown and set on its
 * own (rows of a `.local-facts` list). How a script was installed stays its
 * channel; the others can be set, turned off or put back to the automatic one.
 */
import { useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ChannelFrom, ScriptInfo } from '@adg/protocol'

const FROM: Readonly<Record<ChannelFrom, string>> = {
  install: '安装来源',
  pack: '脚本包',
  known: '已知项目',
  user: '你设置的',
}

type Kind = 'repo' | 'mirrorchyan'

export function ChannelRows({ client, script, disabled, act }: {
  client: AdgClient
  script: ScriptInfo
  disabled: boolean
  act: (name: string, fn: () => Promise<string | void>) => Promise<void>
}) {
  const [editing, setEditing] = useState<Kind | null>(null)
  const [value, setValue] = useState('')
  const github = script.channels.github
  const mirror = script.channels.mirrorchyan

  const set = (kind: Kind, next: string | null | 'reset') => act('channel', async () => {
    await client.connection.call('scripts/source/set', next === 'reset' ? { id: script.id, reset: [kind] }
      : kind === 'repo' ? { id: script.id, repo: next } : { id: script.id, mirrorchyan: next })
    setEditing(null)
    const label = kind === 'repo' ? 'GitHub' : 'Mirror酱'
    return next === null ? `已不再从 ${label} 更新` : next === 'reset' ? `${label} 更新渠道已恢复自动` : `${label} 更新渠道已设为 ${next}`
  })
  const valid = (kind: Kind, text: string) => kind === 'repo' ? /^[\w.-]+\/[\w.-]+$/.test(text) : /^[\w.-]{1,100}$/.test(text)

  const row = (kind: Kind, label: string, shown: { text: string; from: ChannelFrom } | undefined, hint: string, placeholder: string) => (
    <>
      <dt>{label}</dt>
      <dd>
        {editing !== kind ? (
          <>
            {shown !== undefined
              ? <><span>{shown.text}</span><span className="muted small">（{FROM[shown.from]}）</span></>
              : <span className="muted small">{hint}</span>}
            {shown?.from !== 'install' && (
              <button className="ghost small-button" disabled={disabled} onClick={() => {
                setValue(shown?.text ?? '')
                setEditing(kind)
              }}>{shown === undefined ? '设置' : '修改'}</button>
            )}
          </>
        ) : (
          <span className="local-source-edit">
            <input className="text-input plain" aria-label={`${label}更新渠道`} value={value} onChange={e => setValue(e.target.value)} placeholder={placeholder} spellCheck={false} autoFocus />
            <button className="primary small-button" disabled={disabled || !valid(kind, value.trim())} onClick={() => void set(kind, value.trim())}>{kind === 'mirrorchyan' ? '查询并保存' : '保存'}</button>
            <button className="small-button" disabled={disabled} onClick={() => void set(kind, 'reset')}>恢复自动</button>
            {shown !== undefined && <button className="small-button" disabled={disabled} onClick={() => void set(kind, null)}>不用</button>}
            <button className="ghost small-button" onClick={() => setEditing(null)}>取消</button>
          </span>
        )}
      </dd>
    </>
  )

  return (
    <>
      {row('repo', 'GitHub', github === undefined ? undefined : { text: github.repo, from: github.from }, '未设置：填写它的 GitHub 仓库', 'owner/repo，例如 babalae/better-genshin-impact')}
      {row('mirrorchyan', 'Mirror酱', mirror === undefined ? undefined : { text: mirror.rid, from: mirror.from }, '未设置：在 Mirror酱 发布的脚本填它的资源 id', '资源 id，例如 BGI、MAA')}
    </>
  )
}
