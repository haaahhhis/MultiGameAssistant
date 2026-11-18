/**
 * Agent tools for what a script offers agents beyond its tasks:
 * - `script_mcp_list` / `script_mcp_tools` / `script_mcp_call`: drive a script
 *   through its own MCP server. Servers start only when used; one no built-in
 *   pack describes is started after the user approved it once.
 * - `script_skills` / `script_skills_import`: the skills a script ships, put
 *   among this app's skills (belonging to that script).
 * Named `script_*`, so the 脚本 agent keeps them (role.ts).
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { JsonSchemaNode, ToolDefinition, ToolRunContext } from '@deepseek-ai/dsh-tools'
import { ScriptId } from '@adg/protocol'
import { z } from 'zod'
import type { ScriptLibrary } from './library.ts'
import type { ScriptIntegrations } from './script-integrations.ts'
import type { Approve } from './tools.ts'

export const MCP_TOOL_NAMES = {
  list: 'script_mcp_list',
  tools: 'script_mcp_tools',
  call: 'script_mcp_call',
  skills: 'script_skills',
  importSkills: 'script_skills_import',
} as const

const MAX_CALL_SECONDS = 60 * 60

function parse<T>(schema: z.ZodType<T>, args: unknown): T {
  const parsed = schema.safeParse(args)
  if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
  return parsed.data
}

function tool(spec: {
  name: string; description: string; properties: Record<string, JsonSchemaNode>; required?: string[]
  kind: 'read' | 'execute' | 'edit'; timeoutMs?: number
  title(args: Record<string, unknown>): string
  execute(args: unknown, exec: ToolRunContext): Promise<unknown>
}): ToolDefinition {
  return {
    name: spec.name,
    description: spec.description,
    parameters: { type: 'object', properties: spec.properties, ...(spec.required === undefined ? {} : { required: spec.required }), additionalProperties: false },
    output: { schema: {}, render: (_a, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] },
    timeoutMs: spec.timeoutMs ?? 120_000,
    isConcurrencySafe: () => spec.kind === 'read',
    execute: async (args, exec) => JSON.parse(JSON.stringify(await spec.execute(args, exec) ?? null)) as never,
    presentCall: args => ({ card: 'generic', title: spec.title((args ?? {}) as Record<string, unknown>), kind: spec.kind }),
  }
}

const blank = (value: unknown) => value === null || (typeof value === 'string' && value.trim() === '') ? undefined : value
const opt = <T extends z.ZodType>(schema: T) => z.preprocess(blank, schema.optional())

export function mcpTools(library: ScriptLibrary, integrations: ScriptIntegrations, approve: Approve): ToolDefinition[] {
  const id = { type: 'string', description: '脚本库里的脚本 id。' } as const
  const server = { type: 'string', description: 'MCP 服务名（script_mcp_list 列出的 name）；脚本只有一个服务时可以省略。' } as const

  return [
    tool({
      name: MCP_TOOL_NAMES.list,
      description: '列出脚本的 MCP 服务（Model Context Protocol）：从脚本目录里的 MCP 配置（.mcp.json、.vscode/mcp.json 等）自动读出的，和脚本包 mcp 一节写的；以及脚本包写的用法。脚本支持 MCP 时，可以用 script_mcp_tools 看它的工具，再用 script_mcp_call 直接操控脚本（比如查询状态、开始或停止一项任务），不只靠 script_run 运行整个任务。省略 id 列出所有有 MCP 服务的脚本。只读，不会启动任何程序。',
      properties: { id },
      kind: 'read',
      title: a => a['id'] === undefined ? '列出脚本的 MCP 服务' : `MCP 服务：${String(a['id'])}`,
      execute: async args => {
        const a = parse(z.object({ id: opt(ScriptId) }), args)
        const scripts = a.id === undefined ? library.list().scripts.filter(s => s.dir !== undefined) : [library.get(a.id)]
        const out = []
        for (const script of scripts) {
          if (script.dir === undefined) { out.push({ id: script.id, name: script.name, error: '还没有安装' }); continue }
          const endpoints = await integrations.endpoints(script.id).catch(() => [])
          if (endpoints.length === 0 && a.id === undefined) continue
          out.push({
            id: script.id, name: script.name,
            servers: await Promise.all(endpoints.map(e => integrations.view(script.id, e))),
            ...integrations.usage(script.id),
          })
        }
        return { scripts: out, ...(out.length === 0 ? { note: a.id === undefined ? '没有脚本提供 MCP 服务' : '这个脚本没有 MCP 服务' } : {}) }
      },
    }),
    tool({
      name: MCP_TOOL_NAMES.tools,
      description: '连接脚本的 MCP 服务，列出它的工具（名字、说明、参数的 JSON Schema），附上脚本包对这些工具的说明。第一次连接一个不是内置脚本包描述的服务时会先请用户同意（它会启动脚本目录里的程序）。由脚本程序自己提供的服务（needsRunning，或 http 地址）要先把脚本打开。',
      properties: { id, server },
      required: ['id'],
      kind: 'execute',
      timeoutMs: 180_000,
      title: a => `MCP 工具：${String(a['id'] ?? '')}${a['server'] === undefined ? '' : ` / ${String(a['server'])}`}`,
      execute: async (args, exec) => {
        const a = parse(z.object({ id: ScriptId, server: opt(z.string().min(1).max(32)) }), args)
        const endpoint = await integrations.endpoint(a.id, a.server)
        const listed = await integrations.tools(a.id, endpoint, reason => approve(exec, reason), exec.signal)
        const notes = integrations.usage(a.id)
        return {
          server: endpoint.name,
          ...listed,
          ...(notes.usage === undefined ? {} : { usage: notes.usage }),
          notes: notes.tools.filter(t => t.server === undefined || t.server === endpoint.name),
          next: `用 script_mcp_call（id=${a.id}${a.server === undefined ? '' : `, server=${endpoint.name}`}, tool=…, arguments_json='{…}'）调用；参数按工具的 inputSchema 填。`,
        }
      },
    }),
    tool({
      name: MCP_TOOL_NAMES.call,
      description: '调用脚本 MCP 服务的一个工具，返回它的结果（文字和结构化内容）。先用 script_mcp_tools 看有哪些工具和参数。会改变脚本状态或开始游戏操作的调用，和 script_run 一样要注意：同一个模拟器或屏幕上不要同时跑别的任务。',
      properties: {
        id, server,
        tool: { type: 'string', description: '工具名（script_mcp_tools 列出的 name）。' },
        arguments_json: { type: 'string', description: '工具的参数：一个 JSON 对象的文本，按它的 inputSchema 填，例如 {"task":"Fight","stage":"1-7"}；没有参数时省略。' },
        timeout_seconds: { type: 'integer', description: `最多等多久（秒，默认 300，最多 ${MAX_CALL_SECONDS}）；服务报告进度时会重新计时。` },
      },
      required: ['id', 'tool'],
      kind: 'execute',
      timeoutMs: (MAX_CALL_SECONDS + 120) * 1000,
      title: a => `MCP 调用：${String(a['id'] ?? '')} · ${String(a['tool'] ?? '')}`,
      execute: async (args, exec) => {
        const a = parse(z.object({
          id: ScriptId, server: opt(z.string().min(1).max(32)), tool: z.string().min(1).max(200),
          arguments_json: opt(z.string().max(200_000)), timeout_seconds: opt(z.number().int().min(1).max(MAX_CALL_SECONDS)),
        }), args)
        let toolArgs: unknown = {}
        if (a.arguments_json !== undefined) {
          try { toolArgs = JSON.parse(a.arguments_json) } catch (error) { throw new Error(`arguments_json 不是有效的 JSON：${error instanceof Error ? error.message : String(error)}`) }
          if (typeof toolArgs !== 'object' || toolArgs === null || Array.isArray(toolArgs)) throw new Error('arguments_json 要是一个 JSON 对象（{…}）')
        }
        const endpoint = await integrations.endpoint(a.id, a.server)
        const result = await integrations.call(a.id, endpoint, a.tool, toolArgs as Record<string, unknown>, reason => approve(exec, reason), {
          signal: exec.signal, timeoutMs: (a.timeout_seconds ?? 300) * 1000,
        })
        return { server: endpoint.name, tool: a.tool, ...result, ...(result.isError ? { note: '工具报告了错误（isError），看 text 里的原因' } : {}) }
      },
    }),
    tool({
      name: MCP_TOOL_NAMES.skills,
      description: '列出脚本自己带的技能（脚本目录里 skills/、.claude/skills/、.agents/skills/ 等处的 SKILL.md），以及哪些已经放进了本软件的技能库（「技能」页，只在处理这个脚本时可见）。',
      properties: { id },
      required: ['id'],
      kind: 'read',
      title: a => `脚本的技能：${String(a['id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId }), args)
        const skills = await integrations.skills(a.id)
        return { skills, ...(skills.length === 0 ? { note: '这个脚本没有自带技能' } : skills.some(s => s.imported === undefined && s.problem === undefined) ? { next: '要用它们，调用 script_skills_import 放进技能库' } : {}) }
      },
    }),
    tool({
      name: MCP_TOOL_NAMES.importSkills,
      description: '把脚本自带的技能放进本软件的技能库（「技能」页）：复制整个技能文件夹，归到这个脚本下，只有处理这个脚本的会话能看到和调用。再次导入会用脚本里现在的版本替换；脚本更新后，技能文件夹有变化、且在这里没被改过的会自动重新导入。',
      properties: {
        id,
        names: { type: 'array', items: { type: 'string' }, description: '要导入的技能名或路径（script_skills 列出的）；省略导入全部。' },
      },
      required: ['id'],
      kind: 'edit',
      title: a => `导入脚本的技能：${String(a['id'] ?? '')}`,
      execute: async args => {
        const a = parse(z.object({ id: ScriptId, names: opt(z.array(z.string().min(1).max(200)).max(50)) }), args)
        const result = await integrations.importSkills(a.id, a.names)
        return { ...result, ...(result.imported.length > 0 ? { note: '已放进技能库：处理这个脚本时（skill_focus 选中它）就能看到和调用' } : {}) }
      },
    }),
  ]
}
