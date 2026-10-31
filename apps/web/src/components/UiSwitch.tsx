/**
 * The title bar's switch between this UI and dsh's own stock one
 * (apps/desktop/official.mjs): a separate dsh with its own conversations,
 * settings and model keys. It stays in the strip above the official page, to
 * come back. Desktop app only: a browser has nothing to switch to.
 */
import { useEffect, useState } from 'react'
import { desktop, type UiMode } from '../desktop.ts'
import { Icon } from './Icons.tsx'

const INTRO = [
  '切换到 dsh 官方界面：DeepSeek Harness 自带的原版界面，没有 MultiGameAssistant 的脚本、编排、游戏等功能。',
  '',
  '· 它是另一个独立的 dsh：聊天记录、设置和模型密钥都和这里分开，第一次用要在那边重新填模型密钥；',
  '· 第一次切换要启动它，可能要等一会儿；',
  '· 这边的定时任务和脚本在后台照常运行。',
  '',
  '点标题栏左上角的「返回 MultiGameAssistant」切回来。现在切换吗？',
].join('\n')
const INTRO_KEY = 'adg.officialIntro'

export function UiSwitch() {
  const bridge = desktop()?.uiMode
  const [state, setState] = useState<UiMode | null>(null)
  useEffect(() => {
    if (bridge === undefined) return
    let live = true
    bridge.state().then(s => { if (live) setState(s) }, () => {})
    const off = bridge.onChange(setState)
    return () => { live = false; off() }
  }, [bridge])
  if (bridge === undefined || state === null) return null

  const official = state.mode === 'official'
  const go = () => {
    if (official) { void bridge.set('adg'); return }
    if (!introduced() && !window.confirm(INTRO)) return
    markIntroduced()
    void bridge.set('official')
  }
  const label = state.starting ? '正在启动官方界面…' : official ? '返回 MultiGameAssistant' : 'dsh 官方界面'
  return (
    <div className="ui-switch">
      <button type="button" className={`ui-switch-button ${official ? 'active' : ''}`} disabled={state.starting} onClick={go}
        title={official ? '切回 MultiGameAssistant 的界面' : '切换到 DeepSeek Harness 自带的界面（聊天记录分开）'}>
        <Icon name={official ? 'back' : 'layers'} />
        <span>{label}</span>
      </button>
      {state.error !== undefined && (
        <span className="ui-switch-error" role="alert" title={state.error}>
          <span>{state.error}</span>
          <button type="button" className="icon-button" aria-label="关闭" onClick={() => void bridge.set('adg')}><Icon name="close" /></button>
        </span>
      )}
    </div>
  )
}

function introduced(): boolean {
  try { return localStorage.getItem(INTRO_KEY) === '1' } catch { return false }
}
function markIntroduced(): void {
  try { localStorage.setItem(INTRO_KEY, '1') } catch { /* asked again next time */ }
}
