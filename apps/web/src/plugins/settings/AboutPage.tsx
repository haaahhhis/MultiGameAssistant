/**
 * 「设置 → 关于」: which build this is, its license (AGPL-3.0-only) and where
 * its source is. AGPL section 13 asks a program people use over a network to
 * offer them its source; this is where the app does. The installed app also
 * checks for and installs updates here (components/Updates.tsx).
 */
import { useEffect, useState } from 'react'
import { Icon } from '../../components/Icons.tsx'
import { desktop } from '../../desktop.ts'
import { UpdateActions, useUpdates } from '../../components/Updates.tsx'

const REPOSITORY = 'https://github.com/haaahhhis/MultiGameAssistant'

type AppInfo = Awaited<ReturnType<NonNullable<NonNullable<ReturnType<typeof desktop>>['appInfo']>>>

export function AboutPage() {
  const [info, setInfo] = useState<AppInfo | null | undefined>(undefined)
  useEffect(() => {
    const appInfo = desktop()?.appInfo
    if (appInfo === undefined) { setInfo(null); return }
    let live = true
    appInfo().then(i => { if (live) setInfo(i) }, () => { if (live) setInfo(null) })
    return () => { live = false }
  }, [])
  const build = info === undefined ? '…'
    : info === null ? '在浏览器里打开（版本见桌面版）'
      : info.fromSource ? `从源码运行（${info.arch}）`
        : `${info.version ?? '未知版本'}（${info.arch}${info.commit === undefined ? '' : ` · ${info.commit}`}）`

  return (
    <div className="settings-page about-page">
      <h2>关于</h2>
      <p>MultiGameAssistant（多游戏助手）：让 agent 替你管好各个游戏的日常脚本。</p>

      <section className="card about-card">
        <dl className="about-facts">
          <dt>版本</dt><dd>{build}</dd>
          <dt>源代码</dt><dd><a href={REPOSITORY} target="_blank" rel="noreferrer">{REPOSITORY.replace('https://', '')}</a></dd>
          <dt>许可证</dt><dd><a href={`${REPOSITORY}/blob/main/LICENSE`} target="_blank" rel="noreferrer">GNU AGPL-3.0-only</a></dd>
        </dl>
      </section>

      {info?.fromSource === true
        ? <section className="card about-card"><h3>更新</h3><p className="muted">从源码运行：在项目目录 git pull 后重新构建（pnpm install、pnpm build）。</p></section>
        : info !== null && info !== undefined && <UpdateSection />}

      <section className="card about-card">
        <h3>许可证</h3>
        <p>Copyright (C) 2026 MultiGameAssistant contributors</p>
        <p>本程序是自由软件：你可以按自由软件基金会发布的 GNU Affero 通用公共许可证第 3 版（AGPL-3.0-only）再分发和修改它。分发修改后的版本，或让别人通过网络使用修改后的版本时，要以同样的许可证提供它的完整源代码。</p>
        <p>发布本程序是希望它有用，但不提供任何担保，也没有适销性或特定用途适用性的默示担保。详见许可证全文。</p>
        <p className="muted small">附带的第三方组件（Electron、DeepSeek Harness 等）遵循各自的许可证，许可证文件在程序的安装目录里。本程序安装和调度的游戏脚本是各自独立的项目，不属于本程序。</p>
      </section>
    </div>
  )
}

function UpdateSection() {
  const { bridge, state } = useUpdates()
  if (bridge === undefined || state === null) return null
  const latest = state?.latest
  const status = state === undefined ? '…'
    : state.checking ? '正在检查…'
      : state.error !== undefined ? state.error
        : latest !== undefined ? `有新版本 ${latest.version}${latest.prerelease ? '（预发布版）' : ''}${latest.version === state.skipped ? '，已跳过' : ''}`
          : state.checkedAt !== undefined ? `已经是最新版本（${new Date(state.checkedAt).toLocaleString()} 检查）`
            : '还没有检查过'
  return (
    <section className="card about-card">
      <div className="card-head">
        <div>
          <h3>更新</h3>
          <p className={state?.error !== undefined && !state.checking ? 'error small' : 'muted small'}>
            {status}{latest !== undefined && <> · <a href={latest.notesUrl} target="_blank" rel="noreferrer">查看更新内容</a></>}
          </p>
        </div>
        <button className="small-button" disabled={state === undefined || state.checking} onClick={() => void bridge.check()}><Icon name="refresh" />检查更新</button>
      </div>
      {state !== undefined && <UpdateActions bridge={bridge} state={state} />}
      {state !== undefined && (
        <label className="check-label">
          <input type="checkbox" checked={state.auto} onChange={e => void bridge.setAuto(e.target.checked)} />
          自动检查更新（启动后和每隔几小时，从 GitHub Releases；{/-/.test(state.current) ? '预发布版也会收到更新的预发布版' : '只提示正式版'}）
        </label>
      )}
    </section>
  )
}
