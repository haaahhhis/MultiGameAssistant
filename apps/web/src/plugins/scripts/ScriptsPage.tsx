import { useEffect, useState } from 'react'
import type { PageProps } from '../../plugins.ts'
import { Icon } from '../../components/Icons.tsx'
import { FAMILY_LABEL, isActive, PHASE_LABEL, useScriptJobs, useScriptList } from './data.ts'
import { ImportPanel, InstallPanel, MirrorInstallPanel } from './InstallPanel.tsx'
import { JobProgress } from './JobProgress.tsx'
import { ScriptDetail } from './ScriptDetail.tsx'

type Panel = { kind: 'install'; repo?: string } | { kind: 'mirror'; rid?: string } | { kind: 'import' } | null

/** The script library: what is installed or imported, what packs can be installed, and each script's details. */
export function ScriptsPage({ client, openSession, arg }: PageProps) {
  const { data, error } = useScriptList(client)
  const jobs = useScriptJobs(client)
  const [selected, setSelected] = useState<string | null>(null)
  const [panel, setPanel] = useState<Panel>(null)
  // A link such as the game page's (#/p/scripts/mirror:okww) opens the Mirror酱 install of that resource.
  useEffect(() => {
    if (arg?.startsWith('mirror:') === true) setPanel({ kind: 'mirror', rid: arg.slice('mirror:'.length) })
  }, [arg])
  const scripts = data?.scripts ?? []
  const available = (data?.packs ?? []).filter(p => !p.installed && p.repo !== undefined && p.error === undefined)
  const broken = (data?.packs ?? []).filter(p => p.error !== undefined)
  // Known projects no pack describes (BetterGI…): installed from Mirror酱 when it has them, else GitHub.
  const known = (data?.known ?? []).filter(k => !k.installed)
  // An install of a new script has no library entry until its files land: while it runs, its progress is shown instead.
  const pending = selected === null || scripts.some(s => s.id === selected) ? undefined : jobs.get(selected)
  const current = scripts.find(s => s.id === selected) ?? (panel === null && pending === undefined ? scripts[0] : undefined)

  return (
    <section className="main scripts-page">
      <header className="page-header">
        <div className="breadcrumb"><span>脚本</span><span className="breadcrumb-divider">/</span><h1>脚本库</h1></div>
        <div className="page-actions">
          <button className="small-button" onClick={() => setPanel({ kind: 'import' })}><Icon name="paperclip" />导入本地项目</button>
          <button className="small-button" onClick={() => setPanel({ kind: 'mirror' })}><Icon name="plus" />从 Mirror酱 安装</button>
          <button className="primary small-button" onClick={() => setPanel({ kind: 'install' })}><Icon name="plus" />从 GitHub 安装</button>
        </div>
      </header>

      <div className="scripts-body">
        <aside className="scripts-list" aria-label="脚本列表">
          {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
          {data === null && error === null && <div className="muted small pad">加载中…</div>}

          {data !== null && (
            <>
              <div className="sidebar-label">我的脚本（{scripts.length}）</div>
              {scripts.length === 0 && ![...jobs.values()].some(isActive) && <div className="sidebar-empty"><Icon name="package" /><span>还没有脚本</span><span>从下面的脚本包安装，或导入已有目录</span></div>}
              {scripts.map(script => {
                const job = jobs.get(script.id)
                const problems = script.env?.items.filter(i => i.status !== 'ok' && i.status !== 'unsupported').length ?? 0
                return (
                  <button key={script.id} className={`script-row ${script.id === current?.id && panel === null ? 'active' : ''}`}
                    onClick={() => { setSelected(script.id); setPanel(null) }}>
                    <span className="script-row-main">
                      <span className="script-row-name">{script.name}</span>
                      <span className="muted small">{script.source.kind === 'local' ? '本地' : script.current ?? '未安装'}{script.family === undefined ? '' : ` · ${FAMILY_LABEL[script.family] ?? script.family}`}</span>
                    </span>
                    {isActive(job) ? <span className="run-dot" role="img" aria-label="进行中" />
                      : script.update?.available === true ? <span className="badge ok">可更新</span>
                        : problems > 0 ? <span className="badge warn">环境 {problems}</span> : null}
                  </button>
                )
              })}

              {[...jobs.values()].filter(j => isActive(j) && !scripts.some(s => s.id === j.scriptId)).map(job => (
                <button key={job.id} className={`script-row ${selected === job.scriptId && panel === null ? 'active' : ''}`} onClick={() => { setSelected(job.scriptId); setPanel(null) }}>
                  <span className="script-row-main">
                    <span className="script-row-name">{job.scriptId}</span>
                    <span className="muted small">正在安装 · {PHASE_LABEL[job.phase]}{job.total !== undefined && job.received !== undefined && job.total > 0 ? ` ${Math.floor((job.received / job.total) * 100)}%` : ''}</span>
                  </span>
                  <span className="run-dot" role="img" aria-label="进行中" />
                </button>
              ))}

              {(available.length > 0 || known.length > 0) && (
                <>
                  <div className="sidebar-label pack-label">可安装的脚本包</div>
                  {available.map(pack => (
                    <div key={pack.id} className="pack-row">
                      <span className="script-row-main">
                        <span className="script-row-name">{pack.name}</span>
                        <span className="muted small">{pack.description ?? pack.repo}</span>
                      </span>
                      <button className="small-button" onClick={() => setPanel({ kind: 'install', repo: pack.repo! })}>安装</button>
                    </div>
                  ))}
                  {known.map(project => (
                    <div key={project.id} className="pack-row">
                      <span className="script-row-main">
                        <span className="script-row-name">{project.name}</span>
                        <span className="muted small">{[project.mirrorchyan === undefined ? undefined : `Mirror酱 ${project.mirrorchyan}`, project.repo].filter(Boolean).join(' · ')}</span>
                      </span>
                      <button className="small-button" onClick={() => setPanel(project.mirrorchyan !== undefined ? { kind: 'mirror', rid: project.mirrorchyan } : { kind: 'install', repo: project.repo! })}>安装</button>
                    </div>
                  ))}
                </>
              )}
              {broken.length > 0 && (
                <div className="notice error left small"><Icon name="alert" /><span>{broken.length} 个脚本包无法读取：{broken.map(p => p.id).join('、')}</span></div>
              )}
            </>
          )}
        </aside>

        <div className="scripts-detail">
          {panel?.kind === 'install' && (
            <InstallPanel key={panel.repo ?? 'blank'} client={client} jobs={jobs} {...(panel.repo === undefined ? {} : { initialRepo: panel.repo })}
              onClose={() => setPanel(null)} onDone={id => { setSelected(id); setPanel(null) }} />
          )}
          {panel?.kind === 'mirror' && (
            <MirrorInstallPanel key={panel.rid ?? 'blank'} client={client} jobs={jobs} {...(panel.rid === undefined ? {} : { initialRid: panel.rid })}
              onClose={() => setPanel(null)} onDone={id => { setSelected(id); setPanel(null) }} onGitHub={repo => setPanel({ kind: 'install', repo })} />
          )}
          {panel?.kind === 'import' && (
            <ImportPanel client={client} onClose={() => setPanel(null)} onImported={id => { setSelected(id); setPanel(null) }} />
          )}
          {panel === null && current !== undefined && (
            <ScriptDetail key={current.id} client={client} script={current} job={jobs.get(current.id)} onRemoved={() => setSelected(null)} openSession={openSession} />
          )}
          {panel === null && current === undefined && pending !== undefined && (
            <section className="card"><div className="card-head"><div><h3>{pending.scriptId}</h3><p className="muted small">{isActive(pending) ? '正在安装，装好后这里显示脚本的详情' : '安装没有完成'}</p></div></div><JobProgress client={client} job={pending} /></section>
          )}
          {panel === null && current === undefined && pending === undefined && data !== null && (
            <div className="empty">
              {/* An install of a new script has no library entry until its files land. */}
              {[...jobs.values()].filter(j => isActive(j) && !scripts.some(s => s.id === j.scriptId)).map(job => (
                <div key={job.id} className="pending-install"><strong>{job.scriptId}</strong><JobProgress client={client} job={job} /></div>
              ))}
              <p>选择左侧的脚本查看详情，或安装一个新脚本。</p>
            </div>
          )}
          {data !== null && <p className="tools-dir muted small">工具目录：{data.toolsDir}</p>}
        </div>
      </div>
    </section>
  )
}
