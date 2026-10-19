/**
 * The feasibility check before a pipeline runs (docs/PLAN.zh.md §5.3):
 * structure (unknown nodes, cycles), every script task against its pack
 * (task exists, parameters render), which branches drawn in parallel will
 * take turns because they need the same resource, and a rough duration.
 */
import { renderTask, TaskInputError, type ScriptManifest } from '@adg/pack-schema'
import { isMarker, type Pipeline, type PipelineCheck, type PipelineIssue, type PipelineNode, type ScriptInfo } from '@adg/protocol'
import { parseDuration } from '@adg/runner'

export interface CheckLibrary {
  get(id: string): ScriptInfo
  packOf(id: string): { manifest: ScriptManifest } | undefined
}

/** Node → its upstream / downstream neighbours. */
export function graph(pipeline: Pipeline): { up: Map<string, string[]>; down: Map<string, string[]> } {
  const up = new Map<string, string[]>(pipeline.nodes.map(n => [n.id, []]))
  const down = new Map<string, string[]>(pipeline.nodes.map(n => [n.id, []]))
  for (const edge of pipeline.edges) {
    up.get(edge.to)?.push(edge.from)
    down.get(edge.from)?.push(edge.to)
  }
  return { up, down }
}

/** Node ids in an order where every edge points forward; undefined when there is a cycle. */
export function topoOrder(pipeline: Pipeline): string[] | undefined {
  const { up, down } = graph(pipeline)
  const indegree = new Map([...up].map(([id, ups]) => [id, ups.length]))
  const queue = [...indegree].filter(([, d]) => d === 0).map(([id]) => id)
  const order: string[] = []
  while (queue.length > 0) {
    const id = queue.shift()!
    order.push(id)
    for (const next of down.get(id) ?? []) {
      indegree.set(next, indegree.get(next)! - 1)
      if (indegree.get(next) === 0) queue.push(next)
    }
  }
  return order.length === pipeline.nodes.length ? order : undefined
}

/** For each node, every node reachable from it. */
function reach(pipeline: Pipeline, order: string[]): Map<string, Set<string>> {
  const { down } = graph(pipeline)
  const result = new Map<string, Set<string>>()
  for (const id of [...order].reverse()) {
    const set = new Set<string>()
    for (const next of down.get(id) ?? []) {
      set.add(next)
      for (const deeper of result.get(next) ?? []) set.add(deeper)
    }
    result.set(id, set)
  }
  return result
}

export function nodeLabel(node: PipelineNode, library?: CheckLibrary): string {
  if (node.title !== undefined && node.title !== '') return node.title
  if (node.kind === 'script-task') {
    try {
      const pack = library?.packOf(node.scriptId)
      const task = pack?.manifest.tasks.find(t => t.id === node.taskId)
      return `${library?.get(node.scriptId).name ?? node.scriptId} · ${task?.title ?? node.taskId}`
    } catch {
      return `${node.scriptId} · ${node.taskId}`
    }
  }
  return { agent: 'agent 步骤', wait: '等待', notify: '发消息', gate: '人工确认', start: '开始', end: '结束' }[node.kind]
}

/** Resources a script task holds, as lock-like keys (an emulator task counts as `adb`). */
function resourcesOf(node: PipelineNode, library: CheckLibrary): string[] {
  if (node.kind !== 'script-task') return []
  const task = library.packOf(node.scriptId)?.manifest.tasks.find(t => t.id === node.taskId)
  if (task === undefined) return []
  // Most telling first: a shared desktop says more than "the same script".
  return [
    ...(task.resources.input === 'desktop' ? ['desktop'] : []),
    ...(task.resources.input === 'adb' ? ['adb'] : []),
    ...(task.resources.account === undefined ? [] : [`account:${task.resources.account}`]),
    `script:${node.scriptId}`,
  ]
}

const RESOURCE: Readonly<Record<string, string>> = { desktop: '桌面鼠标键盘', adb: '同一台模拟器' }
const describe = (key: string) => RESOURCE[key] ?? (key.startsWith('account:') ? `游戏账号 ${key.slice(8)}` : key.startsWith('script:') ? '同一个脚本' : key)

function minutesOf(node: PipelineNode, library: CheckLibrary): number | undefined {
  if (node.kind === 'wait') return node.minutes
  if (node.kind !== 'script-task') return 0
  const task = library.packOf(node.scriptId)?.manifest.tasks.find(t => t.id === node.taskId)
  const ms = parseDuration(task?.expectedDuration)
  return ms === undefined ? undefined : ms / 60_000
}

export function checkPipeline(pipeline: Pipeline, library: CheckLibrary): PipelineCheck {
  const issues: PipelineIssue[] = []
  const ids = new Set<string>()
  for (const node of pipeline.nodes) {
    if (ids.has(node.id)) issues.push({ level: 'error', nodeId: node.id, message: `节点 id 重复：${node.id}` })
    ids.add(node.id)
  }
  for (const edge of pipeline.edges) {
    if (!ids.has(edge.from) || !ids.has(edge.to)) issues.push({ level: 'error', message: `连线指向不存在的节点：${edge.from} → ${edge.to}` })
    if (edge.from === edge.to) issues.push({ level: 'error', nodeId: edge.from, message: '节点不能连到自己' })
  }
  if (!pipeline.nodes.some(n => !isMarker(n))) issues.push({ level: 'error', message: '流水线里还没有步骤' })
  for (const kind of ['start', 'end'] as const) {
    const marks = pipeline.nodes.filter(n => n.kind === kind)
    if (marks.length > 1) issues.push({ level: 'error', nodeId: marks[1]!.id, message: `只能有一个「${kind === 'start' ? '开始' : '结束'}」节点` })
  }
  for (const edge of pipeline.edges) {
    const from = pipeline.nodes.find(n => n.id === edge.from)
    const to = pipeline.nodes.find(n => n.id === edge.to)
    if (to?.kind === 'start') issues.push({ level: 'error', nodeId: to.id, message: '「开始」前面不能再连别的节点' })
    if (from?.kind === 'end') issues.push({ level: 'error', nodeId: from.id, message: '「结束」后面不能再连别的节点' })
  }
  const order = issues.some(i => i.level === 'error') ? undefined : topoOrder(pipeline)
  if (order === undefined && !issues.some(i => i.level === 'error')) issues.push({ level: 'error', message: '连线成环了：节点之间不能互相等待' })

  for (const node of pipeline.nodes) {
    if (node.kind !== 'script-task') continue
    let script: ScriptInfo
    try {
      script = library.get(node.scriptId)
    } catch {
      issues.push({ level: 'error', nodeId: node.id, message: `脚本库里没有 ${node.scriptId}` })
      continue
    }
    const pack = library.packOf(node.scriptId)
    if (pack === undefined) { issues.push({ level: 'error', nodeId: node.id, message: `${script.name} 没有脚本包，不知道怎么运行` }); continue }
    if (!pack.manifest.tasks.some(t => t.id === node.taskId)) { issues.push({ level: 'error', nodeId: node.id, message: `${script.name} 没有任务 ${node.taskId}` }); continue }
    if (script.dir === undefined) issues.push({ level: 'error', nodeId: node.id, message: `${script.name} 还没有安装` })
    try {
      renderTask(pack.manifest, node.taskId, node.params, { dir: script.dir ?? '.', adb: '0.0.0.0:0' })
    } catch (error) {
      issues.push({ level: 'error', nodeId: node.id, message: error instanceof TaskInputError || error instanceof Error ? error.message : String(error) })
    }
  }

  const serialized: PipelineCheck['serialized'] = []
  let estimateMinutes: number | undefined
  if (order !== undefined) {
    const reachable = reach(pipeline, order)
    const nodes = new Map(pipeline.nodes.map(n => [n.id, n]))
    const resources = new Map(pipeline.nodes.map(n => [n.id, resourcesOf(n, library)]))
    for (let i = 0; i < order.length; i++) {
      for (let j = i + 1; j < order.length; j++) {
        const a = order[i]!
        const b = order[j]!
        if (reachable.get(a)!.has(b) || reachable.get(b)!.has(a)) continue
        const shared = resources.get(a)!.find(k => resources.get(b)!.includes(k))
        if (shared !== undefined) serialized.push({ a, b, resource: describe(shared) })
      }
    }
    for (const pair of serialized) {
      issues.push({ level: 'info', message: `「${nodeLabel(nodes.get(pair.a)!, library)}」和「${nodeLabel(nodes.get(pair.b)!, library)}」画成了并行，但都要用${pair.resource}，会自动排队依次运行` })
    }

    // Longest path, and no shorter than the total of tasks sharing one resource.
    const minutes = new Map(pipeline.nodes.map(n => [n.id, minutesOf(n, library)]))
    if ([...minutes.values()].every(m => m !== undefined)) {
      const { up } = graph(pipeline)
      const finish = new Map<string, number>()
      for (const id of order) finish.set(id, Math.max(0, ...(up.get(id) ?? []).map(u => finish.get(u)!)) + minutes.get(id)!)
      const totals = new Map<string, number>()
      for (const [id, keys] of resources) for (const key of keys) totals.set(key, (totals.get(key) ?? 0) + minutes.get(id)!)
      estimateMinutes = Math.round(Math.max(0, ...finish.values(), ...totals.values()))
    }
  }
  return { ok: !issues.some(i => i.level === 'error'), issues, serialized, ...(estimateMinutes === undefined ? {} : { estimateMinutes }) }
}
