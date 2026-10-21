import { useEffect, useMemo, useState } from 'react'
import type { RequestResult, SkillInfo } from '@adg/protocol'
import type { PageProps } from '../../plugins.ts'
import { Icon } from '../../components/Icons.tsx'
import { Markdown } from '../../components/Markdown.tsx'
import { desktop } from '../../desktop.ts'
import { useStore } from '../../hooks.ts'
import { errorText } from '../scripts/data.ts'
import './skills.css'

type Skill = RequestResult<'skills/get'>

/** Where a skill comes from, in the order the list shows them. */
const GROUPS: readonly { label: string; match: (source: string) => boolean }[] = [
  { label: '本应用自带', match: s => s === 'bundled' },
  { label: '脚本包和游戏包', match: s => s === 'custom' },
  { label: '你的技能文件夹', match: s => s.startsWith('user-') },
  { label: '工作文件夹里的', match: s => s.startsWith('project-') },
]
const OTHER = '其他'

function groupOf(skill: SkillInfo): string {
  return GROUPS.find(g => g.match(skill.source))?.label ?? OTHER
}

/**
 * The agent's skills: what each is for, whether the agent uses it by itself
 * or it is called with /name, and its instructions.
 */
export function SkillsPage({ client, arg }: PageProps) {
  const status = useStore(client.connection.status)
  const [skills, setSkills] = useState<SkillInfo[] | null>(null)
  const [query, setQuery] = useState('')
  const [selected, setSelected] = useState<string>(arg ?? '')
  const [detail, setDetail] = useState<Skill | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [revision, setRevision] = useState(0)
  const [copied, setCopied] = useState(false)

  useEffect(() => { if (arg !== undefined) setSelected(arg) }, [arg])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('skills/list', {}).then(r => { if (live) { setSkills(r.skills); setError(null) } }, e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, status.state, revision])

  const needle = query.trim().toLowerCase()
  const shown = useMemo(() => (skills ?? []).filter(s => needle === '' || `${s.name} ${s.description} ${s.whenToUse ?? ''}`.toLowerCase().includes(needle)), [skills, needle])
  const groups = useMemo(() => {
    const labels = [...GROUPS.map(g => g.label), OTHER]
    return labels.map(label => ({ label, items: shown.filter(s => groupOf(s) === label).sort((a, b) => a.name.localeCompare(b.name)) })).filter(g => g.items.length > 0)
  }, [shown])
  const current = shown.find(s => s.name === selected) ?? groups[0]?.items[0]

  useEffect(() => {
    if (current === undefined) { setDetail(null); return }
    let live = true
    setCopied(false)
    client.connection.call('skills/get', { name: current.name }).then(r => { if (live) setDetail(r) }, e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, current?.name])

  const copyCommand = (name: string) => {
    void navigator.clipboard?.writeText(`/${name} `).then(() => setCopied(true), () => {})
  }

  return (
    <section className="main scripts-page skills-page">
      <header className="page-header">
        <div className="breadcrumb"><span>技能</span><span className="breadcrumb-divider">/</span><h1>agent 的技能</h1></div>
        <div className="page-actions">
          <button className="small-button" onClick={() => setRevision(r => r + 1)}><Icon name="refresh" />刷新</button>
        </div>
      </header>
      <div className="scripts-body">
        <aside className="scripts-list" aria-label="技能列表">
          <div className="skills-search">
            <Icon name="search" />
            <input className="text-input" value={query} onChange={e => setQuery(e.target.value)} placeholder="搜索技能" aria-label="搜索技能" />
          </div>
          {skills !== null && shown.length === 0 && <p className="muted small pad">{needle === '' ? '还没有技能。' : '没有匹配的技能。'}</p>}
          {groups.map(group => (
            <div key={group.label} className="skills-group">
              <div className="sidebar-label">{group.label}<span className="skills-count">{group.items.length}</span></div>
              {group.items.map(skill => (
                <button key={skill.name} className={`script-row ${current?.name === skill.name ? 'active' : ''}`} onClick={() => setSelected(skill.name)}>
                  <span className="script-row-main">
                    <span className="script-row-name">{skill.name}</span>
                    <span className="muted small skills-row-desc">{skill.description}</span>
                  </span>
                </button>
              ))}
            </div>
          ))}
        </aside>
        <div className="scripts-detail">
          <div className="script-detail">
            {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
            {skills === null && error === null && <p className="muted">正在读取…</p>}
            {current !== undefined && (
              <article className="card skill-card">
                <div className="skill-head">
                  <h2>{current.name}</h2>
                  <span className="badge">{groupOf(current)}</span>
                  {current.modelInvocable && <span className="badge ok" title="agent 遇到相关的事会自己读这个技能">agent 自动使用</span>}
                  {current.userInvocable && <span className="badge" title="在对话里输入 /名字 来用它">可以用 /{current.name} 调用</span>}
                </div>
                <p className="skill-desc">{current.description}</p>
                {current.whenToUse !== undefined && <p className="muted small">什么时候用：{current.whenToUse}</p>}
                <div className="skill-actions">
                  {current.userInvocable && <button className="small-button" onClick={() => copyCommand(current.name)}><Icon name="copy" />{copied ? '已复制' : `复制 /${current.name}`}</button>}
                  {current.path !== undefined && (
                    <button className="small-button" title={current.path} disabled={desktop()?.openPath === undefined}
                      onClick={() => void desktop()?.openPath?.(current.path!.replace(/[\\/][^\\/]+$/, ''))}>
                      <Icon name="layers" />打开所在文件夹
                    </button>
                  )}
                  {current.path !== undefined && <code className="muted small skill-path" title={current.path}>{current.path}</code>}
                </div>
                <div className="skill-body">
                  {detail?.name === current.name ? <Markdown text={detail.content} /> : <p className="muted">正在读取…</p>}
                </div>
              </article>
            )}
          </div>
        </div>
      </div>
    </section>
  )
}
