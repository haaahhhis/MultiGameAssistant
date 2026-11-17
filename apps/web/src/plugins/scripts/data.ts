import { useCallback, useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { HubItem, RequestResult, ScriptInfo, ScriptJob } from '@adg/protocol'
import { useStore } from '../../hooks.ts'

export type ScriptList = RequestResult<'scripts/list'>

/** The library, re-read on `scripts/changed` and after every reconnect. */
export function useScriptList(client: AdgClient) {
  const status = useStore(client.connection.status)
  const [state, setState] = useState<{ data: ScriptList | null; error: string | null }>({ data: null, error: null })
  const [revision, setRevision] = useState(0)
  const refresh = useCallback(() => setRevision(r => r + 1), [])

  useEffect(() => client.connection.on('scripts/changed', () => refresh()), [client, refresh])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('scripts/list', {})
      .then(data => { if (live) setState({ data, error: null }) })
      .catch(error => { if (live) setState(s => ({ ...s, error: errorText(error) })) })
    return () => { live = false }
  }, [client, status.state, revision])
  return { ...state, refresh }
}

/** Latest job per script, from `scripts/jobs` plus live `scripts/job` notifications. */
export function useScriptJobs(client: AdgClient): ReadonlyMap<string, ScriptJob> {
  const status = useStore(client.connection.status)
  const [jobs, setJobs] = useState<ReadonlyMap<string, ScriptJob>>(new Map())
  useEffect(() => client.connection.on('scripts/job', job => {
    setJobs(map => {
      const previous = map.get(job.scriptId)
      if (previous !== undefined && previous.id !== job.id && previous.startedAt > job.startedAt) return map
      return new Map(map).set(job.scriptId, job)
    })
  }), [client])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    client.connection.call('scripts/jobs', {}).then(({ items }) => {
      if (!live) return
      const latest = new Map<string, ScriptJob>()
      for (const job of [...items].sort((a, b) => a.startedAt - b.startedAt)) latest.set(job.scriptId, job)
      setJobs(latest)
    }).catch(() => {})
    return () => { live = false }
  }, [client, status.state])
  return jobs
}

export function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 ** 2) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 ** 3) return `${(bytes / 1024 ** 2).toFixed(1)} MB`
  return `${(bytes / 1024 ** 3).toFixed(2)} GB`
}

export const PHASE_LABEL: Readonly<Record<ScriptJob['phase'], string>> = {
  queued: '排队中',
  resolving: '读取发布信息',
  downloading: '下载中',
  verifying: '校验中',
  extracting: '解压中',
  checking: '检查环境',
  running: '处理中',
  done: '完成',
  failed: '失败',
  cancelled: '已取消',
}

export const FAMILY_LABEL: Readonly<Record<string, string>> = {
  'maafw-pi': 'MaaFramework',
  cli: '命令行',
  'gui-config': '配置驱动 GUI',
  'generic-process': '通用程序',
  visual: '界面操作',
}

export function isActive(job: ScriptJob | undefined): job is ScriptJob {
  return job !== undefined && job.endedAt === undefined
}

/**
 * Downloaded 技能库 skills that have a newer version, re-read on
 * `skillhub/changed` (the 技能库 reads the repository at most once a day,
 * or when asked). Empty without the skill hub.
 */
export function useSkillUpdates(client: AdgClient): readonly HubItem[] {
  const status = useStore(client.connection.status)
  const capabilities = useStore(client.capabilities)
  const hub = capabilities.has('skillhub')
  const [items, setItems] = useState<readonly HubItem[]>([])
  const [revision, setRevision] = useState(0)
  useEffect(() => client.connection.on('skillhub/changed', () => setRevision(r => r + 1)), [client])
  useEffect(() => {
    if (status.state !== 'open' || !hub) return
    let live = true
    client.connection.call('skillhub/list', {})
      // One this app is too old for has nothing to do on the scripts page (the 技能库 says why).
      .then(data => { if (live) setItems(data.items.filter(i => i.installed?.update === true && i.incompatible === undefined)) })
      .catch(() => { /* the 技能库 page says why */ })
    return () => { live = false }
  }, [client, status.state, hub, revision])
  return items
}

/** The skills among `updates` that are for this script (its id, its pack, or what it was recognized as). */
export function skillUpdatesFor(script: Pick<ScriptInfo, 'id' | 'packId' | 'known'>, updates: readonly HubItem[]): HubItem[] {
  const ids = [script.id, script.packId, script.known].filter((x): x is string => x !== undefined)
  return updates.filter(item => item.scripts.some(s => ids.includes(s)))
}
