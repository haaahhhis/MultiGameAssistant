import { useEffect, useState } from 'react'
import type { AdgClient } from '@adg/client-core'
import type { TaskInfo } from '@adg/protocol'
import { useStore } from '../../hooks.ts'

/** Every library script that has tasks, with them: the canvas palette. */
export function useScriptTasks(client: AdgClient, revision = 0) {
  const status = useStore(client.connection.status)
  const [tasks, setTasks] = useState<{ scriptId: string; scriptName: string; tasks: TaskInfo[] }[]>([])
  useEffect(() => {
    if (status.state !== 'open') return
    let live = true
    void (async () => {
      const { scripts } = await client.connection.call('scripts/list', {})
      const out: typeof tasks = []
      for (const script of scripts) {
        if (script.packId === undefined) continue
        const r = await client.connection.call('runs/tasks', { scriptId: script.id }).catch(() => undefined)
        if (r !== undefined && r.tasks.length > 0) out.push({ scriptId: script.id, scriptName: script.name, tasks: r.tasks })
      }
      if (live) setTasks(out)
    })().catch(() => {})
    return () => { live = false }
  }, [client, status.state, revision])
  return tasks
}
