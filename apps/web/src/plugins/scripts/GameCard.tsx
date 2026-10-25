import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { RequestResult } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { desktop } from '../../desktop.ts'
import { useStore } from '../../hooks.ts'
import { errorText } from './data.ts'

type View = RequestResult<'configs/launch'>
type Found = RequestResult<'configs/launch/locate'>

/** Who starts the game before a run: the script itself, or MultiGameAssistant when the script does not. */
export function GameCard({ client, scriptId, scriptName, openSession }: { client: AdgClient; scriptId: string; scriptName: string; openSession: (sessionId: string) => void }) {
  const status = useStore(client.connection.status)
  const [view, setView] = useState<View | null>(null)
  const [exe, setExe] = useState('')
  const [process, setProcess] = useState('')
  const [pkg, setPkg] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [saved, setSaved] = useState(false)
  const [found, setFound] = useState<Found | null>(null)
  const [locating, setLocating] = useState(false)

  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('configs/launch', { scriptId }).then(v => {
      if (!live) return
      setView(v)
      setExe(v.settings.pcExe ?? '')
      setProcess(v.settings.pcProcess ?? '')
      setPkg(v.settings.androidPackage ?? '')
    }).catch(e => { if (live) setError(errorText(e)) })
    return () => { live = false }
  }, [client, scriptId, status.state])

  const set = async (patch: Omit<Parameters<typeof client.connection.call<'configs/launch/set'>>[1], 'scriptId'>) => {
    setBusy(true)
    setError(null)
    setSaved(false)
    try {
      setView(await client.connection.call('configs/launch/set', { scriptId, ...patch }))
      setSaved(true)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setBusy(false)
    }
  }

  const saveExe = async (path: string) => {
    setExe(path)
    await set({ pcExe: path })
  }

  // One click: look, and keep it when there is exactly one.
  const locate = async () => {
    setLocating(true)
    setError(null)
    setSaved(false)
    setFound(null)
    try {
      const result = await client.connection.call('configs/launch/locate', { scriptId })
      setFound(result)
      if (result.candidates.length === 1) await saveExe(result.candidates[0]!.path)
    } catch (e) {
      setError(errorText(e))
    } finally {
      setLocating(false)
    }
  }

  const askAgent = async () => {
    setError(null)
    try {
      const { sessionId } = await client.connection.call('sessions/create', {})
      await client.connection.call('session/prompt', {
        sessionId, requestId: `locate-${Date.now()}`, mode: 'queue',
        text: `帮我找到「${scriptName}」（脚本 id: ${scriptId}）要玩的 PC 游戏${view?.game.name === undefined ? '' : `「${view.game.name}」`}装在哪里：先用 game_locate；没找到就在各个磁盘上搜索名为 ${found?.exe ?? view?.game.pcProcess ?? '游戏进程名'} 的程序（可以问我装在哪个盘）。找到后告诉我路径和你怎么确认的，再用 game_path_set 保存。`,
      })
      openSession(sessionId)
    } catch (e) {
      setError(errorText(e))
    }
  }

  const pick = async () => {
    const bridge = desktop()
    if (bridge === undefined) return
    const path = await bridge.pickFile({ title: '选择游戏程序', defaultPath: exe.trim() === '' ? undefined : exe.trim(), filterName: '程序', extensions: ['exe'] })
    if (path !== null) await saveExe(path)
  }

  if (view === null) return error === null ? null : <section className="card"><div className="notice error left"><Icon name="alert" /><span>{error}</span></div></section>
  const { settings, game, uses } = view
  if (!uses.adb && !uses.desktop) return null
  return (
    <section className="card">
      <div className="card-head">
        <div>
          <h3>启动游戏{game.name === undefined ? '' : `：${game.name}`}</h3>
          <p className="muted small">有的脚本不会自己打开游戏或模拟器。运行前，本应用会先启动模拟器（模拟器任务），再按这里的设置启动游戏；游戏已经开着、或脚本自己会启动时不会重复启动。{game.selfLaunch}。</p>
        </div>
      </div>
      <label className="field-label" htmlFor={`launch-mode-${scriptId}`}>运行前由谁启动游戏</label>
      <select id={`launch-mode-${scriptId}`} className="text-input plain" value={settings.mode} disabled={busy} onChange={e => void set({ mode: e.target.value as 'auto' | 'platform' | 'off' })}>
        <option value="auto">自动：脚本不会启动时由本应用启动（推荐）</option>
        <option value="platform">总是由本应用启动（游戏没开时）</option>
        <option value="off">不启动，交给脚本或我自己</option>
      </select>
      {settings.mode !== 'off' && uses.adb && (
        <>
          <label className="field-label" htmlFor={`launch-pkg-${scriptId}`}>模拟器里的游戏包名（模拟器任务）</label>
          <div className="key-input">
            <input id={`launch-pkg-${scriptId}`} className="text-input" value={pkg} onChange={e => setPkg(e.target.value)} placeholder={game.androidPackage ?? '例如 com.example.game；不填则不在模拟器里启动游戏'} spellCheck={false} />
            <button className="small-button" disabled={busy} onClick={() => void set({ androidPackage: pkg.trim() === '' ? null : pkg.trim() })}>保存</button>
          </div>
          {game.androidPackage !== undefined && <p className="muted small">默认 {game.androidPackage}；B 服、国际服等版本的包名不同时在这里改。</p>}
        </>
      )}
      {settings.mode !== 'off' && uses.desktop && (
        <>
          <label className="field-label" htmlFor={`launch-exe-${scriptId}`}>PC 游戏程序位置（占用鼠标键盘的任务）</label>
          <div className="key-input">
            <input id={`launch-exe-${scriptId}`} className="text-input" value={exe} onChange={e => setExe(e.target.value)} placeholder="例如 D:\Games\Endfield\Endfield.exe（也可以是游戏启动器）" spellCheck={false} />
            <button className="small-button" disabled={busy} onClick={() => void set({ pcExe: exe.trim() === '' ? null : exe.trim().replace(/^"|"$/g, '') })}>保存</button>
          </div>
          <div className="button-row">
            <button className="small-button" disabled={busy || locating} onClick={() => void locate()}>{locating ? '正在查找…' : '自动查找'}</button>
            {desktop() !== undefined && <button className="small-button" disabled={busy || locating} onClick={() => void pick()}>选择文件…</button>}
            <button className="link-button small" disabled={locating} onClick={() => void askAgent()}>让 agent 找</button>
          </div>
          {found !== null && found.exe === undefined && <p className="muted small">脚本包没有写游戏的进程名：先在下面填进程名，或用「选择文件…」/ 让 agent 找。</p>}
          {found !== null && found.exe !== undefined && found.candidates.length === 0 && (
            <p className="muted small">没找到 {found.exe}（查了正在运行的程序、已安装程序、开始菜单和桌面快捷方式、各盘的常见游戏目录）。可以「选择文件…」，或「让 agent 找」在整个磁盘上搜。</p>
          )}
          {found !== null && found.candidates.length === 1 && <p className="muted small">找到并保存了：{found.candidates[0]!.path}（{found.candidates[0]!.source}）</p>}
          {found !== null && found.candidates.length > 1 && (
            <div className="candidate-list">
              <span className="muted small">找到 {found.candidates.length} 个，选一个：</span>
              {found.candidates.map(c => (
                <button key={c.path} className={`candidate ${settings.pcExe === c.path ? 'chosen' : ''}`} disabled={busy} onClick={() => void saveExe(c.path)}>
                  <span className="mono">{c.path}</span><span className="muted small">{c.source}</span>
                </button>
              ))}
            </div>
          )}
          <label className="field-label" htmlFor={`launch-proc-${scriptId}`}>游戏进程名（判断游戏是否已经开着）</label>
          <div className="key-input">
            <input id={`launch-proc-${scriptId}`} className="text-input" value={process} onChange={e => setProcess(e.target.value)} placeholder={game.pcProcess ?? '默认是上面程序的文件名'} spellCheck={false} />
            <button className="small-button" disabled={busy} onClick={() => void set({ pcProcess: process.trim() === '' ? null : process.trim() })}>保存</button>
          </div>
          <p className="muted small">填的是启动器时，进程名要填游戏本身的（在任务管理器「详细信息」里看）。</p>
        </>
      )}
      {saved && <div className="muted small">已保存，下次运行生效。</div>}
      {error !== null && <div className="notice error left"><Icon name="alert" /><span>{error}</span></div>}
    </section>
  )
}
