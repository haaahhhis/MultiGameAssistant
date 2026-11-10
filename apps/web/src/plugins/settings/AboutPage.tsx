/**
 * 「设置 → 关于」: which build this is, its license (AGPL-3.0-only) and where
 * its source is. AGPL section 13 asks a program people use over a network to
 * offer them its source; this is where the app does. The installed app also
 * checks for and installs updates here (components/Updates.tsx); the dsh plugin
 * package shows its version and checks too, updated in dsh (gateway about.ts).
 */
import { useCallback, useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { RequestResult } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useStore } from '../../hooks.ts'
import { desktop } from '../../desktop.ts'
import { UpdateActions, useUpdates } from '../../components/Updates.tsx'

const REPOSITORY = 'https://github.com/haaahhhis/MultiGameAssistant'

type AppInfo = Awaited<ReturnType<NonNullable<NonNullable<ReturnType<typeof desktop>>['appInfo']>>>

type HostAbout = RequestResult<'about/info'>

export function AboutPage({ client }: { client: AdgClient }) {
  const [info, setInfo] = useState<AppInfo | null | undefined>(undefined)
  const plugin = usePluginVersion(client, info === null)
  useEffect(() => {
    const appInfo = desktop()?.appInfo
    if (appInfo === undefined) { setInfo(null); return }
    let live = true
    appInfo().then(i => { if (live) setInfo(i) }, () => { if (live) setInfo(null) })
    return () => { live = false }
  }, [])
  const build = info === undefined ? '…'
    : info === null ? (plugin === undefined ? '…' : plugin === null ? '在浏览器里打开（版本见桌面版）' : `${plugin}（dsh 插件版）`)
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
        : info !== null && info !== undefined ? <UpdateSection />
          : typeof plugin === 'string' && <PluginUpdateSection client={client} />}

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

/** The dsh plugin package's version (about/info); null when this host is something else, undefined while asking. */
function usePluginVersion(client: AdgClient, wanted: boolean): string | null | undefined {
  const capabilities = useStore(client.capabilities)
  const status = useStore(client.connection.status)
  const [about, setAbout] = useState<HostAbout | null | undefined>(undefined)
  const has = capabilities.has('about')
  useEffect(() => {
    if (!wanted || status.state !== 'open') return
    if (!has) { setAbout(null); return }
    let live = true
    client.connection.call('about/info', {}).then(a => { if (live) setAbout(a) }, () => { if (live) setAbout(null) })
    return () => { live = false }
  }, [client, wanted, has, status.state])
  if (!wanted) return null
  return about === undefined ? undefined : about?.edition === 'plugin' ? about.version ?? null : null
}

const RELEASES = `${REPOSITORY}/releases`
const PLUGIN_NAME = 'dsh-multigameassistant'

/**
 * The plugin package's update check: asked when the page opens and on the
 * button. A plugin is updated in dsh by adding it again; by name when npm
 * already serves the version (a release goes live there once approved), else by
 * the release's own package link.
 */
function PluginUpdateSection({ client }: { client: AdgClient }) {
  const [state, setState] = useState<{ checking: boolean; result?: RequestResult<'about/checkUpdate'>; error?: string }>({ checking: true })
  const check = useCallback(() => {
    setState(s => ({ ...s, checking: true }))
    client.connection.call('about/checkUpdate', {}).then(
      result => setState({ checking: false, result }),
      e => setState(s => ({ checking: false, ...(s.result === undefined ? {} : { result: s.result }), error: e instanceof Error ? e.message : String(e) })),
    )
  }, [client])
  useEffect(() => { check() }, [check])
  const latest = state.result?.latest
  const status = state.checking ? '正在检查…'
    : state.error !== undefined ? state.error
      : latest !== undefined ? `有新版本 ${latest.version}${latest.prerelease ? '（预发布版）' : ''}`
        : state.result !== undefined ? `已经是最新版本（${new Date(state.result.checkedAt).toLocaleString()} 检查）`
          : '还没有检查过'
  const link = latest === undefined ? '' : `${RELEASES}/download/v${latest.version}/${PLUGIN_NAME}.tgz`
  return (
    <section className="card about-card">
      <div className="card-head">
        <div>
          <h3>更新</h3>
          <p className={state.error !== undefined && !state.checking ? 'error small' : 'muted small'}>
            {status}{latest !== undefined && !state.checking && <> · <a href={latest.notesUrl || RELEASES} target="_blank" rel="noreferrer">查看更新内容</a></>}
          </p>
        </div>
        <button className="small-button" disabled={state.checking} onClick={check}><Icon name="refresh" />检查更新</button>
      </div>
      {latest !== undefined && !state.checking && (
        <div className="plugin-update">
          {latest.onNpm !== false && (
            <p>在 dsh 的「Plugins」→「Add plugin」里再填一次 <CopyCode text={PLUGIN_NAME} /> 安装（命令行的 dsh：<CopyCode text={`dsh plugin add ${PLUGIN_NAME}`} />）。{latest.onNpm === undefined && '没连上 npm，不知道那边有没有这个版本；装完版本没变的话，用下面的链接。'}</p>
          )}
          {latest.onNpm !== true && (
            <p>{latest.onNpm === false && 'npm 上还没有这个版本（要等发布者批准）。'}在「Add plugin」里填这个链接安装：<CopyCode text={link} /></p>
          )}
          <p className="muted small">装好后刷新这个页面。你的数据、脚本和定时任务都在 dsh 的数据目录里，重新安装不会丢。</p>
        </div>
      )}
    </section>
  )
}

/** Text to paste somewhere else, with a button that copies it. */
function CopyCode({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)
  const copy = () => {
    navigator.clipboard.writeText(text).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1500) }, () => {})
  }
  return (
    <span className="copy-code">
      <code>{text}</code>
      <button type="button" className="link-button" onClick={copy} title="复制">{copied ? <Icon name="check" /> : <Icon name="copy" />}</button>
    </span>
  )
}

