import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { ProfileList, TaskInfo } from '@adg/protocol'
import { useStore } from '../../hooks.ts'

/** Every library script that has tasks, with them: the canvas palette. */
export function useScriptTasks(client: AdgClient, revision = 0) {
  const status = useStore(client.connection.status)
  const [tasks, setTasks] = useState<{ scriptId: string; scriptName: string; tasks: TaskInfo[]; profiles?: ProfileList | undefined }[]>([])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    void (async () => {
      const { scripts } = await client.connection.call('scripts/list', {})
      const out: typeof tasks = []
      for (const script of scripts) {
        if (script.packId === undefined) continue
        const r = await client.connection.call('runs/tasks', { scriptId: script.id }).catch(() => undefined)
        if (r === undefined || r.tasks.length === 0) continue
        const profiles = await client.connection.call('configs/profiles', { scriptId: script.id }).catch(() => undefined)
        out.push({ scriptId: script.id, scriptName: script.name, tasks: r.tasks, profiles })
      }
      if (live) setTasks(out)
    })().catch(() => {})
    return () => { live = false }
  }, [client, status.state, revision])
  // Profiles saved, renamed or removed elsewhere: node labels and pickers follow.
  useEffect(() => client.connection.on('configs/profiles/changed', e => {
    setTasks(list => list.map(s => (s.scriptId === e.scriptId ? { ...s, profiles: e.list } : s)))
  }), [client])
  return tasks
}
