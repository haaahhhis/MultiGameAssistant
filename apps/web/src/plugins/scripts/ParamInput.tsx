import { useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { TaskInfo } from '@adg/protocol'
import { errorText } from './data.ts'

type Spec = TaskInfo['params'][string]

/**
 * One task parameter: a list when the pack gives values (fixed, or read from
 * the script's config, with 「新建…」 when new ones can be made), else a text box.
 */
export function ParamInput({ client, scriptId, taskId, name, spec, value, onChange, onCreated }: {
  client: AdgClient
  scriptId: string
  taskId: string
  name: string
  spec: Spec
  value: string
  onChange: (value: string) => void
  /** The task list should be read again (a choice was added). */
  onCreated?: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const create = async () => {
    const label = window.prompt('新的名字（会复制一个现有的同类项，保存在本应用的本地配置里，原项目不变）', 'AutoDailyGamePlay')
    if (label === null || label.trim() === '') return
    setError(null)
    try {
      const { value: made } = await client.connection.call('runs/choices/create', { scriptId, taskId, param: name, name: label.trim() })
      onCreated?.()
      onChange(made)
    } catch (e) {
      setError(errorText(e))
    }
  }

  let input
  if (spec.choices !== undefined) {
    const known = spec.choices.some(c => c.value === value)
    input = (
      <select className="text-input plain" value={known ? value : ''} onChange={e => { if (e.target.value === '\u0000new') void create(); else onChange(e.target.value) }}>
        <option value="" disabled>{spec.choices.length === 0 ? '本地配置里还没有，先新建或在脚本里建一个' : '请选择'}</option>
        {spec.choices.map(c => <option key={c.value} value={c.value}>{c.label}{c.detail === undefined ? '' : `（${c.detail}）`}</option>)}
        {spec.canCreate === true && <option value={'\u0000new'}>＋ 新建…</option>}
      </select>
    )
  } else if (spec.type === 'boolean') {
    input = (
      <select className="text-input plain" value={value} onChange={e => onChange(e.target.value)}>
        <option value="true">是</option><option value="false">否</option>
      </select>
    )
  } else if (spec.enum !== undefined) {
    input = (
      <select className="text-input plain" value={value} onChange={e => onChange(e.target.value)}>
        {spec.enum.map(option => <option key={String(option)} value={String(option)}>{String(option)}</option>)}
      </select>
    )
  } else {
    input = <input className="text-input plain" value={value} placeholder={spec.default === undefined ? '必填' : String(spec.default)} inputMode={spec.type === 'string' ? 'text' : 'numeric'} onChange={e => onChange(e.target.value)} />
  }
  return (
    <label className="param-row">
      <span className="field-label">{name}{spec.description === undefined ? '' : ` · ${spec.description}`}</span>
      {input}
      {error !== null && <span className="error small">{error}</span>}
    </label>
  )
}
