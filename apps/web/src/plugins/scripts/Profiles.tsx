/**
 * A script's config profiles (several saved local configs: another account,
 * another set of tasks), shared by the config card, the run form and the
 * pipeline editor.
 */
import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ProfileList } from '@adg/protocol'
import { useStore } from '../../hooks.ts'
import { Select } from '../../components/Select.tsx'

/** The script's profiles, kept current; null until read (or for scripts without a pack). */
export function useProfiles(client: AdgClient, scriptId: string | undefined, enabled = true): ProfileList | null {
  const status = useStore(client.connection.status)
  const [list, setList] = useState<ProfileList | null>(null)
  useEffect(() => {
    setList(null)
    if (scriptId === undefined || !enabled || status.state !== 'open') return
    let live = true
    client.connection.call('configs/profiles', { scriptId }).then(l => { if (live) setList(l) }, () => {})
    const off = client.connection.on('configs/profiles/changed', e => { if (e.scriptId === scriptId) setList(e.list) })
    return () => { live = false; off() }
  }, [client, scriptId, enabled, status.state])
  return list
}

export function profileName(list: ProfileList | null, id: string | undefined): string | undefined {
  if (list === null) return undefined
  return list.items.find(p => p.id === (id ?? list.current))?.name
}

/**
 * Pick a profile; `value` undefined means "the script's current one". Shown only
 * when the script has more than one.
 */
export function ProfileSelect({ list, value, onChange, id, label = '配置' }: {
  list: ProfileList | null
  value: string | undefined
  onChange: (profile: string | undefined) => void
  id: string
  label?: string
}) {
  if (list === null || list.items.length < 2) return null
  const current = list.items.find(p => p.id === list.current)
  const missing = value !== undefined && !list.items.some(p => p.id === value)
  return (
    <>
      <label className="field-label" htmlFor={id}>{label}</label>
      <Select id={id} value={value ?? ''} onChange={next => onChange(next === '' ? undefined : next)} options={[
        { value: '', label: '跟随当前使用的', hint: `现在是「${current?.name ?? '默认'}」` },
        ...list.items.map(p => ({ value: p.id, label: p.name })),
        ...(missing ? [{ value: value!, label: '已删除的配置', disabled: true }] : []),
      ]} />
      {missing && <span className="muted small">这份配置已经删了，运行时会失败；请重新选一份。</span>}
    </>
  )
}
