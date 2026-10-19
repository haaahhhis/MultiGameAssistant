import { useCallback, useMemo, useState } from 'react'
import { Background, Controls, Handle, Position, ReactFlow, type Connection, type Edge, type Node, type NodeChange, type NodeProps } from '@xyflow/react'
import '@xyflow/react/dist/style.css'
import type { AdgClient } from '@adg/client-core'
import type { NodeRun, Pipeline, PipelineCheck, PipelineEdge, PipelineNode, PipelineRun } from '@adg/protocol'
import { Icon } from '../../components/Icons.tsx'
import { useTheme } from '../../theme.ts'
import { errorText } from '../scripts/data.ts'
import { useScriptTasks } from './data.ts'

const KIND: Readonly<Record<PipelineNode['kind'], string>> = { 'script-task': '脚本任务', agent: 'agent 步骤', wait: '等待', notify: '发消息', gate: '人工确认' }
const NODE_STATE: Readonly<Record<NodeRun['state'], string>> = {
  pending: '待运行', waiting: '等待中', running: '运行中', succeeded: '成功', failed: '失败', skipped: '跳过', cancelled: '取消',
}
const WHEN: Readonly<Record<PipelineEdge['when'], string>> = { success: '成功后', failure: '失败后', always: '结束后' }
const INPUT: Readonly<Record<string, string>> = { desktop: '鼠标键盘', adb: '模拟器', window: '后台窗口', none: '' }

type StepData = { node: PipelineNode; label: string; sub: string; input: string; state?: NodeRun | undefined; issue?: string | undefined }
type StepNode = Node<StepData, 'step'>

function StepCard({ data, selected }: NodeProps<StepNode>) {
  const state = data.state?.state
  return (
    <div className={`step-node ${state ?? ''} ${selected ? 'selected' : ''} ${data.issue !== undefined ? 'has-issue' : ''}`}>
      <Handle type="target" position={Position.Left} />
      <div className="step-kind">
        <span>{KIND[data.node.kind]}</span>
        {data.input !== '' && <span className="badge">{data.input}</span>}
        {state !== undefined && <span className={`step-state ${state}`}>{NODE_STATE[state]}{(data.state?.attempts ?? 0) > 1 ? ` · 第 ${data.state!.attempts} 次` : ''}</span>}
      </div>
      <div className="step-title">{data.label}</div>
      {data.sub !== '' && <div className="step-sub">{data.sub}</div>}
      {data.state?.detail !== undefined && data.state.detail !== '' && <div className="step-detail">{data.state.detail}</div>}
      {data.issue !== undefined && data.state === undefined && <div className="step-detail issue">{data.issue}</div>}
      <Handle type="source" position={Position.Right} />
    </div>
  )
}

const nodeTypes = { step: StepCard }

/** Place nodes without a position in columns by depth. */
function layout(pipeline: Pipeline): Map<string, { x: number; y: number }> {
  const depth = new Map<string, number>()
  const visit = (id: string, seen: Set<string>): number => {
    if (depth.has(id)) return depth.get(id)!
    if (seen.has(id)) return 0
    seen.add(id)
    const ups = pipeline.edges.filter(e => e.to === id).map(e => visit(e.from, seen) + 1)
    const d = Math.max(0, ...ups)
    depth.set(id, d)
    return d
  }
  for (const node of pipeline.nodes) visit(node.id, new Set())
  const rows = new Map<number, number>()
  const out = new Map<string, { x: number; y: number }>()
  for (const node of pipeline.nodes) {
    if (node.position !== undefined) { out.set(node.id, node.position); continue }
    const d = depth.get(node.id) ?? 0
    const row = rows.get(d) ?? 0
    rows.set(d, row + 1)
    out.set(node.id, { x: 40 + d * 280, y: 40 + row * 130 })
  }
  return out
}

let seq = 0
const newId = (prefix: string, pipeline: Pipeline) => {
  for (;;) {
    const id = `${prefix}${++seq}`
    if (!pipeline.nodes.some(n => n.id === id)) return id
  }
}

export function PipelineEditor({ client, pipeline, onChange, run, check }: { client: AdgClient; pipeline: Pipeline; onChange: (p: Pipeline) => void; run: PipelineRun | undefined; check: PipelineCheck | null }) {
  const theme = useTheme()
  const scripts = useScriptTasks(client)
  const [selectedNode, setSelectedNode] = useState<string | null>(null)
  const [selectedEdge, setSelectedEdge] = useState<number | null>(null)
  // React Flow reports each node's rendered size; a controlled flow must hand it back, or nodes stay hidden and edges undrawn.
  const [measured, setMeasured] = useState<Record<string, { width: number; height: number }>>({})

  const labelOf = useCallback((node: PipelineNode): { label: string; sub: string; input: string } => {
    if (node.kind === 'script-task') {
      const script = scripts.find(s => s.scriptId === node.scriptId)
      const task = script?.tasks.find(t => t.id === node.taskId)
      const params = Object.entries(node.params).map(([k, v]) => `${k}=${String(v)}`).join(' ')
      return { label: node.title ?? `${script?.scriptName ?? node.scriptId} · ${task?.title ?? node.taskId}`, sub: params, input: INPUT[task?.input ?? 'none'] ?? '' }
    }
    if (node.kind === 'wait') return { label: node.title ?? (node.minutes !== undefined ? `等 ${node.minutes} 分钟` : `等到 ${node.until}`), sub: '', input: '' }
    if (node.kind === 'agent') return { label: node.title ?? 'agent 步骤', sub: node.prompt.slice(0, 40), input: '' }
    return { label: node.title ?? KIND[node.kind], sub: node.text.slice(0, 40), input: '' }
  }, [scripts])

  const positions = useMemo(() => layout(pipeline), [pipeline])
  const nodes: StepNode[] = useMemo(() => pipeline.nodes.map(node => ({
    id: node.id,
    type: 'step',
    position: positions.get(node.id)!,
    selected: node.id === selectedNode,
    ...(measured[node.id] === undefined ? {} : { measured: measured[node.id] }),
    data: { node, ...labelOf(node), state: run?.nodes[node.id], issue: check?.issues.find(i => i.nodeId === node.id && i.level === 'error')?.message },
  })), [pipeline, positions, labelOf, run, check, selectedNode, measured])
  const edges: Edge[] = useMemo(() => pipeline.edges.map((edge, index) => ({
    id: `e${index}`,
    source: edge.from,
    target: edge.to,
    label: WHEN[edge.when],
    selected: index === selectedEdge,
    animated: run?.nodes[edge.from]?.state === 'running',
    className: `edge-${edge.when}`,
  })), [pipeline.edges, selectedEdge, run])

  const onNodesChange = useCallback((changes: NodeChange<StepNode>[]) => {
    let next = pipeline
    const sizes: Record<string, { width: number; height: number }> = {}
    for (const change of changes) {
      if (change.type === 'dimensions' && change.dimensions !== undefined) {
        sizes[change.id] = change.dimensions
      } else if (change.type === 'position' && change.position !== undefined) {
        next = { ...next, nodes: next.nodes.map(n => (n.id === change.id ? { ...n, position: { x: Math.round(change.position!.x), y: Math.round(change.position!.y) } } : n)) }
      } else if (change.type === 'remove') {
        next = { ...next, nodes: next.nodes.filter(n => n.id !== change.id), edges: next.edges.filter(e => e.from !== change.id && e.to !== change.id) }
        setSelectedNode(null)
      }
    }
    if (Object.keys(sizes).length > 0) setMeasured(m => ({ ...m, ...sizes }))
    if (next !== pipeline) onChange(next)
  }, [pipeline, onChange])

  const onConnect = useCallback((c: Connection) => {
    if (c.source === c.target || pipeline.edges.some(e => e.from === c.source && e.to === c.target)) return
    onChange({ ...pipeline, edges: [...pipeline.edges, { from: c.source, to: c.target, when: 'success' }] })
  }, [pipeline, onChange])

  const add = (node: PipelineNode) => {
    // New nodes go to the right of everything.
    const x = Math.max(0, ...[...positions.values()].map(p => p.x)) + (pipeline.nodes.length === 0 ? 40 : 280)
    onChange({ ...pipeline, nodes: [...pipeline.nodes, { ...node, position: { x: pipeline.nodes.length === 0 ? 40 : x, y: 40 } }] })
    setSelectedNode(node.id)
    setSelectedEdge(null)
  }

  const node = pipeline.nodes.find(n => n.id === selectedNode)
  const edge = selectedEdge === null ? undefined : pipeline.edges[selectedEdge]
  const replaceNode = (next: PipelineNode) => onChange({ ...pipeline, nodes: pipeline.nodes.map(n => (n.id === next.id ? next : n)) })

  return (
    <div className="pipeline-editor">
      <div className="pipeline-palette" aria-label="节点">
        <div className="sidebar-label">脚本任务</div>
        {scripts.length === 0 && <div className="muted small pad">脚本库里还没有带脚本包的脚本</div>}
        {scripts.map(s => (
          <details key={s.scriptId} className="palette-group" open={scripts.length <= 3}>
            <summary>{s.scriptName}</summary>
            {s.tasks.map(t => (
              <button key={t.id} className="palette-item" title={t.description ?? t.title}
                onClick={() => add({ id: newId(s.scriptId.replace(/[^A-Za-z0-9_-]/g, '').slice(0, 20) || 'task', pipeline), kind: 'script-task', scriptId: s.scriptId, taskId: t.id, params: {} })}>
                <span>{t.title}</span>{INPUT[t.input] !== '' && <span className="badge">{INPUT[t.input]}</span>}
              </button>
            ))}
          </details>
        ))}
        <div className="sidebar-label pack-label">其他步骤</div>
        <button className="palette-item" onClick={() => add({ id: newId('agent', pipeline), kind: 'agent', prompt: '检查活动还剩几天，快结束的提醒我' })}>agent 步骤</button>
        <button className="palette-item" onClick={() => add({ id: newId('wait', pipeline), kind: 'wait', minutes: 10 })}>等待</button>
        <button className="palette-item" onClick={() => add({ id: newId('notify', pipeline), kind: 'notify', text: `${pipeline.name}跑完了` })}>发消息</button>
        <button className="palette-item" onClick={() => add({ id: newId('gate', pipeline), kind: 'gate', text: '确认后继续' })}>人工确认</button>
        <p className="muted small pad">从节点右边的圆点拖到另一个节点左边，表示「这个完成后再运行那个」。没有连线的节点会同时开始；需要同一资源的会自动排队。</p>
      </div>

      <div className="pipeline-canvas">
        <ReactFlow
          nodes={nodes}
          edges={edges}
          nodeTypes={nodeTypes}
          onNodesChange={onNodesChange}
          onConnect={onConnect}
          onNodeClick={(_e, n) => { setSelectedNode(n.id); setSelectedEdge(null) }}
          onEdgeClick={(_e, e) => { setSelectedEdge(Number(e.id.slice(1))); setSelectedNode(null) }}
          onPaneClick={() => { setSelectedNode(null); setSelectedEdge(null) }}
          deleteKeyCode={['Delete', 'Backspace']}
          colorMode={theme}
          fitView
          fitViewOptions={{ maxZoom: 1, padding: 0.2 }}
          proOptions={{ hideAttribution: true }}
        >
          <Background gap={20} />
          <Controls showInteractive={false} />
        </ReactFlow>
        {pipeline.nodes.length === 0 && <div className="canvas-hint">从左边点一个任务加到画布上</div>}
      </div>

      <aside className="pipeline-inspector">
        {node !== undefined && <NodeInspector client={client} node={node} pipeline={pipeline} run={run} scripts={scripts} onChange={replaceNode}
          onRemove={() => { onChange({ ...pipeline, nodes: pipeline.nodes.filter(n => n.id !== node.id), edges: pipeline.edges.filter(e => e.from !== node.id && e.to !== node.id) }); setSelectedNode(null) }} />}
        {edge !== undefined && (
          <section className="inspector-section">
            <h4>连线</h4>
            <p className="muted small">「{pipeline.nodes.find(n => n.id === edge.from)?.title ?? edge.from}」→「{pipeline.nodes.find(n => n.id === edge.to)?.title ?? edge.to}」</p>
            <label className="field-label" htmlFor="edge-when">什么时候运行下一步</label>
            <select id="edge-when" className="text-input plain" value={edge.when}
              onChange={e => onChange({ ...pipeline, edges: pipeline.edges.map((x, i) => (i === selectedEdge ? { ...x, when: e.target.value as PipelineEdge['when'] } : x)) })}>
              <option value="success">上一步成功后</option>
              <option value="failure">上一步失败后</option>
              <option value="always">上一步结束后（不管成败）</option>
            </select>
            <button className="danger-outline small-button" onClick={() => { onChange({ ...pipeline, edges: pipeline.edges.filter((_x, i) => i !== selectedEdge) }); setSelectedEdge(null) }}>删除连线</button>
          </section>
        )}
        {node === undefined && edge === undefined && <p className="muted small pad">点一个节点或连线来修改。选中后按 Delete 也能删除。</p>}
      </aside>
    </div>
  )
}

function NodeInspector({ client, node, pipeline, run, scripts, onChange, onRemove }: {
  client: AdgClient; node: PipelineNode; pipeline: Pipeline; run: PipelineRun | undefined
  scripts: ReturnType<typeof useScriptTasks>; onChange: (n: PipelineNode) => void; onRemove: () => void
}) {
  const [error, setError] = useState<string | null>(null)
  const state = run?.nodes[node.id]
  const task = node.kind === 'script-task' ? scripts.find(s => s.scriptId === node.scriptId)?.tasks.find(t => t.id === node.taskId) : undefined
  const policy = node.onFailure
  return (
    <section className="inspector-section">
      <h4>{KIND[node.kind]}</h4>
      <label className="field-label" htmlFor="node-title">名称（可选）</label>
      <input id="node-title" className="text-input plain" value={node.title ?? ''} maxLength={60}
        onChange={e => { const { title: _t, ...rest } = node; onChange((e.target.value === '' ? rest : { ...rest, title: e.target.value }) as PipelineNode) }} />

      {node.kind === 'script-task' && task !== undefined && Object.entries(task.params).map(([name, spec]) => (
        <label key={name} className="param-row">
          <span className="field-label">{name}{spec.description === undefined ? '' : ` · ${spec.description}`}</span>
          {spec.enum !== undefined ? (
            <select className="text-input plain" value={String(node.params[name] ?? spec.default ?? '')} onChange={e => onChange({ ...node, params: { ...node.params, [name]: spec.type === 'string' ? e.target.value : Number(e.target.value) } })}>
              {spec.enum.map(o => <option key={String(o)} value={String(o)}>{String(o)}</option>)}
            </select>
          ) : spec.type === 'boolean' ? (
            <select className="text-input plain" value={String(node.params[name] ?? spec.default ?? false)} onChange={e => onChange({ ...node, params: { ...node.params, [name]: e.target.value === 'true' } })}>
              <option value="true">是</option><option value="false">否</option>
            </select>
          ) : (
            <input className="text-input plain" value={String(node.params[name] ?? '')} placeholder={spec.default === undefined ? '必填' : `默认 ${String(spec.default)}`}
              onChange={e => {
                const { [name]: _old, ...rest } = node.params
                const raw = e.target.value
                onChange({ ...node, params: raw === '' ? rest : { ...rest, [name]: spec.type === 'string' ? raw : Number(raw) } })
              }} />
          )}
        </label>
      ))}
      {node.kind === 'agent' && (
        <><label className="field-label" htmlFor="node-prompt">让 agent 做什么</label>
          <textarea id="node-prompt" className="text-input plain" rows={4} value={node.prompt} onChange={e => onChange({ ...node, prompt: e.target.value })} /></>
      )}
      {(node.kind === 'notify' || node.kind === 'gate') && (
        <><label className="field-label" htmlFor="node-text">{node.kind === 'notify' ? '消息内容' : '确认时显示的话'}</label>
          <textarea id="node-text" className="text-input plain" rows={3} value={node.text} onChange={e => onChange({ ...node, text: e.target.value })} /></>
      )}
      {node.kind === 'wait' && (
        <div className="key-input">
          <select className="text-input plain" aria-label="等待方式" value={node.minutes !== undefined ? 'minutes' : 'until'}
            onChange={e => onChange(e.target.value === 'minutes' ? { id: node.id, kind: 'wait', minutes: 10, ...(node.title === undefined ? {} : { title: node.title }), ...(node.position === undefined ? {} : { position: node.position }) } : { id: node.id, kind: 'wait', until: '05:00', ...(node.title === undefined ? {} : { title: node.title }), ...(node.position === undefined ? {} : { position: node.position }) })}>
            <option value="minutes">等几分钟</option><option value="until">等到某个时间</option>
          </select>
          {node.minutes !== undefined
            ? <input className="text-input plain" type="number" min={1} max={1440} value={node.minutes} onChange={e => onChange({ ...node, minutes: Math.max(1, Math.min(1440, Math.round(Number(e.target.value) || 1))) })} />
            : <input className="text-input plain" type="time" value={node.until} onChange={e => onChange({ ...node, until: e.target.value })} />}
        </div>
      )}

      {node.kind !== 'gate' && node.kind !== 'notify' && (
        <>
          <label className="field-label" htmlFor="node-fail">失败时</label>
          <select id="node-fail" className="text-input plain" value={policy === undefined ? 'inherit' : `${policy.retries}:${policy.then}`}
            onChange={e => {
              const { onFailure: _f, ...rest } = node
              if (e.target.value === 'inherit') return onChange(rest as PipelineNode)
              const [retries, then] = e.target.value.split(':')
              onChange({ ...rest, onFailure: { retries: Number(retries), then: then as 'continue' | 'stop' } } as PipelineNode)
            }}>
            <option value="inherit">按流水线的设置（{pipeline.onFailure.retries > 0 ? `重试 ${pipeline.onFailure.retries} 次后` : ''}{pipeline.onFailure.then === 'stop' ? '停止' : '继续'}）</option>
            {[0, 1, 2].flatMap(r => (['continue', 'stop'] as const).map(t => <option key={`${r}:${t}`} value={`${r}:${t}`}>{r === 0 ? '' : `重试 ${r} 次，仍失败就`}{t === 'continue' ? '继续其他分支' : '停止流水线'}</option>))}
          </select>
        </>
      )}

      {state !== undefined && (
        <div className="inspector-run">
          <div className="sidebar-label">这次运行</div>
          <div>{NODE_STATE[state.state]}{state.attempts > 1 ? ` · 第 ${state.attempts} 次` : ''}</div>
          {state.detail !== undefined && <div className="muted small">{state.detail}</div>}
          {state.runIds.length > 0 && <div className="muted small">脚本运行：{state.runIds.join('、')}（在「运行」页看日志）</div>}
          {node.kind === 'gate' && state.state === 'running' && run !== undefined && (
            <div className="key-actions">
              <button className="primary small-button" onClick={() => void client.connection.call('pipelines/gate', { runId: run.id, nodeId: node.id, decision: 'continue' }).catch(e => setError(errorText(e)))}>继续</button>
              <button className="danger-outline small-button" onClick={() => void client.connection.call('pipelines/gate', { runId: run.id, nodeId: node.id, decision: 'stop' }).catch(e => setError(errorText(e)))}>停止</button>
            </div>
          )}
        </div>
      )}
      {error !== null && <div className="notice error left small"><Icon name="alert" /><span>{error}</span></div>}
      <button className="danger-outline small-button" onClick={onRemove}>删除这个节点</button>
    </section>
  )
}
