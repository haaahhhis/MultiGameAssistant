/**
 * Another copy of the app open on this computer (the desktop app and the dsh
 * plugin at once): what clashes, in the floating dock. 「知道了」 hides it
 * until the other copies or what clashes change.
 */
import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { OtherCopy } from '@adg/protocol'
import { useStore } from '../hooks.ts'
import { Icon } from './Icons.tsx'

const SEEN_KEY = 'adg.otherCopies.seen'

/** The other copies; empty without the capability. */
export function useOtherCopies(client: AdgClient): OtherCopy[] {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const available = capabilities.has('instances')
  const [others, setOthers] = useState<OtherCopy[]>([])
  useEffect(() => client.connection.on('instances/changed', p => setOthers(p.others)), [client])
  useEffect(() => {
    if (status.state !== 'open' || !available) { setOthers([]); return }
    let live = true
    client.connection.call('instances/others', {}).then(p => { if (live) setOthers(p.others) }).catch(() => {})
    return () => { live = false }
  }, [client, status.state, available])
  return others
}

export function OtherCopiesCard({ client }: { client: AdgClient }) {
  const others = useOtherCopies(client)
  const signature = JSON.stringify(others.map(o => [o.pid, o.warnings]))
  const [seen, setSeen] = useState(() => { try { return localStorage.getItem(SEEN_KEY) } catch { return null } })
  if (others.length === 0 || seen === signature) return null
  const dismiss = () => {
    try { localStorage.setItem(SEEN_KEY, signature) } catch { /* only for this window then */ }
    setSeen(signature)
  }
  return (
    <div className="approval-card other-copies" role="status">
      <div className="approval-head">
        <Icon name="alert" />
        <div className="approval-text">
          <span className="approval-title">{others.length === 1 ? '另一个多游戏助手也开着' : `另外 ${others.length} 个多游戏助手也开着`}</span>
          <span className="approval-tool">{others.map(o => o.label).join('、')}</span>
        </div>
      </div>
      <ul className="other-copies-list">
        {[...new Set(others.flatMap(o => o.warnings))].map(warning => <li key={warning}>{warning}</li>)}
      </ul>
      <div className="approval-actions">
        <button onClick={dismiss}>知道了</button>
      </div>
    </div>
  )
}
