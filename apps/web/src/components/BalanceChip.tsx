/**
 * What the DeepSeek account still holds, beside the context meter, from
 * DeepSeek's balance API. Only while the session's model is served by
 * DeepSeek's own API with a key; the host decides that, and answers null for
 * anything else. Read when a turn starts and ends, and every minute during
 * one, so a long run does not show a stale amount. A failed query says so
 * rather than showing an old amount or a zero.
 */
import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ProviderBalance } from '@adg/protocol'
import { useModelCatalog, useStore } from '../hooks.ts'
import { sessionSelection } from './ModelPicker.tsx'

const REFRESH_WHILE_RUNNING_MS = 60_000
const SYMBOL: Readonly<Record<string, string>> = { CNY: '¥', USD: '$' }

const money = (currency: string, amount: string) => {
  const symbol = SYMBOL[currency]
  return symbol === undefined ? `${amount} ${currency}` : `${symbol}${amount}`
}

/** `¥110.00`; an account in two currencies shows each one that holds anything. */
export function formatBalance({ balances }: ProviderBalance): string {
  const held = balances.filter(b => Number(b.total) !== 0)
  return (held.length > 0 ? held : balances.slice(0, 1)).map(b => money(b.currency, b.total)).join(' / ')
}

function describe(balance: ProviderBalance): string {
  const parts = balance.balances.map(b => `${money(b.currency, b.total)}（充值 ${money(b.currency, b.toppedUp)}，赠送 ${money(b.currency, b.granted)}）`)
  return `DeepSeek 账户余额 ${parts.join('、')}${balance.available ? '' : '。余额不足，调用模型会失败'}`
}

type Reading = { provider: string; balance: ProviderBalance | null; error: string | null }

export function BalanceChip({ client, sessionId, running }: { client: AdgClient; sessionId: string; running: boolean }) {
  const { catalog } = useModelCatalog(client)
  const known = useStore(client.sessionModels).get(sessionId)
  const provider = sessionSelection(catalog, known)?.provider ?? null
  const credentials = useStore(client.credentialRevision)
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const [reading, setReading] = useState<Reading | null>(null)

  useEffect(() => {
    if (provider === null || status.state !== 'open' || !capabilities.has('providers')) return
    let live = true
    const load = () => client.providerBalance(provider).then(
      balance => { if (live) setReading({ provider, balance, error: null }) },
      (e: unknown) => { if (live) setReading({ provider, balance: null, error: e instanceof Error ? e.message : String(e) }) },
    )
    void load()
    const timer = running ? setInterval(() => void load(), REFRESH_WHILE_RUNNING_MS) : undefined
    return () => { live = false; clearInterval(timer) }
  }, [client, provider, credentials, status.state, capabilities, running])

  // A reading taken for another model's provider says nothing about this one.
  if (reading === null || reading.provider !== provider) return null
  if (reading.error !== null) return <span className="balance-chip failed" title={reading.error}>余额 ?</span>
  if (reading.balance === null || reading.balance.balances.length === 0) return null
  return <span className={`balance-chip ${reading.balance.available ? '' : 'low'}`} title={describe(reading.balance)}>{formatBalance(reading.balance)}</span>
}
