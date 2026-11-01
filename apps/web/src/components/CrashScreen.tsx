import { Component, type ReactNode } from 'react'

/**
 * What the window shows when the page itself fails to render (boot.css's
 * failed startup screen), instead of nothing: React drops the whole tree on an
 * error no component catches. The error also goes to the console, which the
 * desktop app copies into dsh.log.
 */
export class CrashScreen extends Component<{ children: ReactNode }, { error: Error | null }> {
  override state: { error: Error | null } = { error: null }

  static getDerivedStateFromError(error: unknown) {
    return { error: error instanceof Error ? error : new Error(String(error)) }
  }

  override componentDidCatch(error: unknown, info: { componentStack?: string | null }) {
    console.error(`界面出错：${error instanceof Error ? error.stack ?? error.message : String(error)}${info.componentStack ?? ''}`)
  }

  override render() {
    const { error } = this.state
    if (error === null) return this.props.children
    const detail = `${error.message}\n\n${(error.stack ?? '').split('\n').slice(1, 8).join('\n')}`
    return (
      <div className="boot failed">
        <div className="boot-center">
          <h1 className="boot-name">MultiGameAssistant</h1>
          <p className="boot-stage" role="alert"><span>界面出错了</span></p>
          <div className="boot-detail"><pre tabIndex={0}>{detail}</pre></div>
          <div className="boot-actions">
            <button type="button" className="primary" onClick={() => location.reload()}>重新载入</button>
            <button type="button" onClick={() => void navigator.clipboard?.writeText(detail)}>复制错误信息</button>
          </div>
        </div>
      </div>
    )
  }
}
