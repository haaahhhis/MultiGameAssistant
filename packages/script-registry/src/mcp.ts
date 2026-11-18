/**
 * Scripts that speak MCP (Model Context Protocol): the agent drives them
 * through their own MCP server's tools instead of, or beside, starting tasks.
 *
 * - Discovery: the script directory's MCP config files are read as they are
 *   (`.mcp.json` / `mcp.json` with `mcpServers`, VS Code's `.vscode/mcp.json`
 *   with `servers`, Cursor's, …; JSON with comments). A script pack's `mcp`
 *   section names the servers to use, points at those entries (`from`, so a
 *   script update that changes its server is followed) or writes one out, and
 *   says how to use them; servers found but not named by the pack are offered
 *   too.
 * - Connections are made when the agent first needs a server and closed after
 *   a while unused, so nothing runs for scripts nobody is driving. A stdio
 *   server is a program in the script directory (or on PATH, `npx`, `uvx`…);
 *   an HTTP one is often served by the script's own window while it runs.
 * - Trust: starting a server runs the script's code, so one that no built-in
 *   pack describes is started only after the user approved it once; the
 *   approval holds for that exact command (or URL) in `<dataDir>/mcp-trust.json`.
 */
import { createHash } from 'node:crypto'
import { existsSync, mkdirSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { Client, SSEClientTransport, StreamableHTTPClientTransport, type CallToolResult, type Tool, type Transport } from '@modelcontextprotocol/client'
import { StdioClientTransport } from '@modelcontextprotocol/client/stdio'
import { MCP_SERVER_NAME, parseJsonc, type Mcp } from '@adg/pack-schema'
import { writeFileAtomic } from '@adg/protocol/node'

/** Where scripts keep MCP configuration, relative to the script directory, in the order read. */
export const MCP_CONFIG_FILES = [
  '.mcp.json', 'mcp.json', 'mcp_config.json', 'mcp-config.json', 'mcp_servers.json', 'mcp-servers.json',
  '.vscode/mcp.json', '.cursor/mcp.json', '.claude/mcp.json', '.roo/mcp.json', '.kiro/settings/mcp.json',
  'config/mcp.json', 'mcp/mcp.json', 'mcp/config.json',
] as const

/** An MCP config file bigger than this is not configuration. */
const MAX_CONFIG_BYTES = 512 * 1024
const CONNECT_TIMEOUT_MS = 60_000
/** A server unused this long is closed (its program stops). */
const IDLE_MS = 10 * 60_000
const STDERR_LINES = 30

/** One server entry as a script's config file writes it. */
export interface DiscoveredMcpServer {
  /** The config file, relative to the script directory (forward slashes). */
  readonly file: string
  /** Its key in the file. */
  readonly server: string
  readonly transport?: 'stdio' | 'http' | 'sse'
  readonly command?: string
  readonly args?: readonly string[]
  readonly env?: Readonly<Record<string, string>>
  readonly cwd?: string
  readonly url?: string
  readonly headers?: Readonly<Record<string, string>>
  readonly description?: string
  /** Marked disabled in the file. */
  readonly disabled?: boolean
}

/** A server ready to connect to: what the pack says over what the script's file says, placeholders filled. */
export interface McpEndpoint {
  readonly name: string
  readonly transport: 'stdio' | 'http' | 'sse'
  readonly command?: string
  readonly args: readonly string[]
  readonly env: Readonly<Record<string, string>>
  readonly cwd: string
  readonly url?: string
  readonly headers: Readonly<Record<string, string>>
  /** Served by the script's own program while it runs. */
  readonly needsRunning: boolean
  readonly description?: string
  /** `pack`: named by the script's pack; `discovered`: only in the script's config file. */
  readonly source: 'pack' | 'discovered'
  /** The script's config file it was read from, and its key there. */
  readonly file?: string
  readonly server?: string
  /** A built-in pack describes it: started without asking. */
  readonly builtin: boolean
  /** Why it cannot be used as written (a missing entry, an `${input:…}` to fill in). */
  readonly problem?: string
}

/** The entries in one MCP config file's text. */
export function parseMcpConfig(text: string, file: string): DiscoveredMcpServer[] {
  let root: unknown
  try { root = parseJsonc(text) } catch { return [] }
  if (!isRecord(root)) return []
  const nested = isRecord(root['mcp']) ? root['mcp'] : undefined
  const table = [root['mcpServers'], root['servers'], root['mcp_servers'], nested?.['servers'], nested?.['mcpServers']].find(isRecord)
  if (table === undefined) return []
  const out: DiscoveredMcpServer[] = []
  for (const [server, raw] of Object.entries(table)) {
    if (!isRecord(raw)) continue
    const type = str(raw['type']) ?? str(raw['transport'])
    const command = str(raw['command'])
    const url = str(raw['url']) ?? str(raw['serverUrl']) ?? str(raw['httpUrl'])
    const transport = type === undefined
      ? command !== undefined ? 'stdio' : url !== undefined ? (/\/sse\/?$/i.test(url) ? 'sse' : 'http') : undefined
      : /^stdio$/i.test(type) ? 'stdio' : /^sse$/i.test(type) ? 'sse' : /http/i.test(type) ? 'http' : undefined
    const args = Array.isArray(raw['args']) ? raw['args'].filter((a): a is string => typeof a === 'string') : undefined
    out.push({
      file, server,
      ...(transport === undefined ? {} : { transport }),
      ...(command === undefined ? {} : { command }),
      ...(args === undefined ? {} : { args }),
      ...(isRecord(raw['env']) ? { env: strings(raw['env']) } : {}),
      ...(str(raw['cwd']) === undefined ? {} : { cwd: str(raw['cwd'])! }),
      ...(url === undefined ? {} : { url }),
      ...(isRecord(raw['headers']) ? { headers: strings(raw['headers']) } : {}),
      ...(str(raw['description']) === undefined ? {} : { description: str(raw['description'])! }),
      ...(raw['disabled'] === true || raw['enabled'] === false ? { disabled: true } : {}),
    })
  }
  return out
}

/** Every MCP server entry in a script directory's config files. */
export async function discoverMcp(dir: string): Promise<DiscoveredMcpServer[]> {
  const out: DiscoveredMcpServer[] = []
  for (const file of MCP_CONFIG_FILES) {
    const text = await readFile(join(dir, file)).then(b => b.length > MAX_CONFIG_BYTES ? undefined : b.toString('utf8'), () => undefined)
    if (text !== undefined) out.push(...parseMcpConfig(text, file))
  }
  return out
}

/**
 * The servers to connect to for a script: the pack's (`from` entries filled
 * from the script's files), then those only in the files.
 */
export function mcpEndpoints(dir: string, found: readonly DiscoveredMcpServer[], mcp: Mcp | undefined, builtin: boolean): McpEndpoint[] {
  const out: McpEndpoint[] = []
  const used = new Set<DiscoveredMcpServer>()
  const sameFile = (a: string, b: string) => a.replace(/\\/g, '/').toLowerCase() === b.replace(/\\/g, '/').toLowerCase()
  for (const server of mcp?.servers ?? []) {
    let base: DiscoveredMcpServer | undefined
    let problem: string | undefined
    if (server.from !== undefined) {
      const key = server.from.server ?? server.name
      base = found.find(f => sameFile(f.file, server.from!.file) && f.server === key)
      if (base === undefined) problem = `脚本的 MCP 配置 ${server.from.file} 里没有 ${key}（脚本可能改了配置，检查脚本包的 mcp 一节）`
      else used.add(base)
    }
    out.push(resolveEndpoint(dir, {
      name: server.name,
      transport: server.transport ?? base?.transport,
      command: server.command ?? base?.command,
      args: server.args ?? base?.args ?? [],
      env: { ...base?.env, ...server.env },
      cwd: server.cwd ?? base?.cwd,
      url: server.url ?? base?.url,
      headers: { ...base?.headers, ...server.headers },
      needsRunning: server.needsRunning,
      description: server.description ?? base?.description,
      source: 'pack',
      file: server.from?.file ?? base?.file,
      server: base?.server,
      builtin,
      problem,
    }))
  }
  const names = new Set(out.map(e => e.name))
  for (const entry of found) {
    if (used.has(entry) || entry.disabled === true) continue
    let name = toServerName(entry.server)
    for (let n = 2; names.has(name); n++) name = `${toServerName(entry.server).slice(0, 29)}-${n}`
    names.add(name)
    out.push(resolveEndpoint(dir, {
      name, transport: entry.transport, command: entry.command, args: entry.args ?? [], env: { ...entry.env }, cwd: entry.cwd,
      url: entry.url, headers: { ...entry.headers }, needsRunning: false, description: entry.description,
      source: 'discovered', file: entry.file, server: entry.server, builtin: false, problem: undefined,
    }))
  }
  return out
}

interface Draft {
  name: string; transport: McpEndpoint['transport'] | undefined; command: string | undefined; args: readonly string[]
  env: Record<string, string>; cwd: string | undefined; url: string | undefined; headers: Record<string, string>
  needsRunning: boolean; description: string | undefined; source: McpEndpoint['source']; file: string | undefined; server: string | undefined
  builtin: boolean; problem: string | undefined
}

function resolveEndpoint(dir: string, d: Draft): McpEndpoint {
  const inputs = new Set<string>()
  const fill = (value: string) => expandPlaceholders(value, dir, inputs)
  const transport = d.transport ?? (d.command !== undefined ? 'stdio' : 'http')
  let problem = d.problem
  if (problem === undefined && transport === 'stdio' && d.command === undefined) problem = '没有写要启动的程序（command）'
  if (problem === undefined && transport !== 'stdio' && d.url === undefined) problem = '没有写服务地址（url）'
  const cwd = resolve(dir, d.cwd === undefined ? '.' : fill(d.cwd))
  const command = d.command === undefined ? undefined : locateCommand(fill(d.command), dir)
  const endpoint: McpEndpoint = {
    name: d.name, transport,
    ...(command === undefined ? {} : { command }),
    args: d.args.map(fill),
    env: Object.fromEntries(Object.entries(d.env).map(([k, v]) => [k, fill(v)])),
    cwd,
    ...(d.url === undefined ? {} : { url: fill(d.url) }),
    headers: Object.fromEntries(Object.entries(d.headers).map(([k, v]) => [k, fill(v)])),
    needsRunning: d.needsRunning,
    ...(d.description === undefined ? {} : { description: d.description }),
    source: d.source,
    ...(d.file === undefined ? {} : { file: d.file }),
    ...(d.server === undefined ? {} : { server: d.server }),
    builtin: d.builtin,
  }
  if (problem === undefined && inputs.size > 0) problem = `配置里要先填的值：${[...inputs].join('、')}（脚本的 MCP 配置用了 \${input:…}，在脚本包的 mcp 一节里写明它们）`
  return problem === undefined ? endpoint : { ...endpoint, problem }
}

/**
 * `${workspaceFolder}`, `${CLAUDE_PROJECT_DIR}`, `{dir}` … are the script
 * directory; `${env:NAME}` and `${NAME}` the app's environment. `${input:…}`
 * (VS Code asks the user) cannot be filled: collected in `inputs`.
 */
export function expandPlaceholders(value: string, dir: string, inputs: Set<string> = new Set()): string {
  return value
    .replace(/\$\{(workspaceFolder|workspaceRoot|CLAUDE_PROJECT_DIR|projectDir|projectRoot|dir|scriptDir)\}|\{dir\}/g, dir)
    .replace(/\$\{input:([^}]+)\}/g, (whole, id: string) => { inputs.add(id); return whole })
    .replace(/\$\{env:([A-Za-z_][A-Za-z0-9_]*)\}|\$\{([A-Z_][A-Z0-9_]*)\}/g, (_, a: string | undefined, b: string | undefined) => process.env[(a ?? b)!] ?? '')
}

/** A command in the script directory as a full path; `npx`, `python`… stay for PATH. */
function locateCommand(command: string, dir: string): string {
  if (isAbsolute(command)) return command
  if (/[\\/]/.test(command) || command.startsWith('.')) return resolve(dir, command)
  for (const candidate of [command, `${command}.exe`, `${command}.cmd`, `${command}.bat`]) {
    if (existsSync(join(dir, candidate))) return join(dir, candidate)
  }
  return command
}

function toServerName(raw: string): string {
  const name = raw.replace(/[^A-Za-z0-9_-]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 32)
  return MCP_SERVER_NAME.test(name) ? name : 'mcp'
}

/** What identifies a server for trust and for reusing a connection: what it starts or where it connects. */
export function fingerprint(scriptId: string, e: McpEndpoint): string {
  return createHash('sha256').update(JSON.stringify([scriptId, e.name, e.transport, e.command ?? null, e.args, e.cwd, e.url ?? null, Object.keys(e.env).sort()])).digest('hex').slice(0, 32)
}

/** A connected server's tool, as the agent is shown it. */
export interface McpToolInfo {
  readonly name: string
  readonly title?: string
  readonly description?: string
  readonly inputSchema: unknown
  readonly readOnly?: boolean
}

/** A tool call's result, as text the agent reads. */
export interface McpCallOutcome {
  readonly isError: boolean
  readonly text: string
  readonly structured?: unknown
  /** Images, audio, resources the server sent, by kind (not shown). */
  readonly other: readonly string[]
}

interface Connection {
  readonly key: string
  readonly client: Client
  readonly stderr: string[]
  readonly endpoint: McpEndpoint
  tools?: Tool[]
  lastUsed: number
  timer?: ReturnType<typeof setTimeout>
}

export interface ScriptMcpOptions {
  readonly dataDir: string
  readonly version?: string
  readonly log?: { info(message: string): void; warn(message: string): void }
  readonly idleMs?: number
}

/** The script MCP connections this app holds, and the servers the user trusted. */
export class ScriptMcp {
  readonly #options: ScriptMcpOptions
  readonly #connections = new Map<string, Connection>()
  readonly #connecting = new Map<string, Promise<Connection>>()
  readonly #trustFile: string
  #trusted: Set<string> | undefined

  constructor(options: ScriptMcpOptions) {
    this.#options = options
    this.#trustFile = join(options.dataDir, 'mcp-trust.json')
  }

  /** The servers of a script installed in `dir`, with its pack's `mcp` section. */
  async endpoints(dir: string, pack: { readonly mcp?: Mcp | undefined; readonly builtin: boolean } | undefined): Promise<McpEndpoint[]> {
    return mcpEndpoints(dir, await discoverMcp(dir), pack?.mcp, pack?.builtin === true)
  }

  connected(scriptId: string, name: string): boolean {
    return this.#connections.has(`${scriptId}/${name}`)
  }

  /** Can it be started without asking: a built-in pack's, or approved before (this exact command or URL). */
  async trusted(scriptId: string, endpoint: McpEndpoint): Promise<boolean> {
    if (endpoint.builtin) return true
    return (await this.#trust()).has(fingerprint(scriptId, endpoint))
  }

  async trust(scriptId: string, endpoint: McpEndpoint): Promise<void> {
    const trusted = await this.#trust()
    trusted.add(fingerprint(scriptId, endpoint))
    mkdirSync(dirname(this.#trustFile), { recursive: true })
    await writeFileAtomic(this.#trustFile, `${JSON.stringify([...trusted], null, 1)}\n`)
  }

  /** The server's tools (connecting first). */
  async tools(scriptId: string, endpoint: McpEndpoint, signal?: AbortSignal): Promise<{ tools: McpToolInfo[]; server?: { name: string; version: string }; instructions?: string }> {
    const connection = await this.#connection(scriptId, endpoint, signal)
    const caps = connection.client.getServerCapabilities()
    if (connection.tools === undefined) connection.tools = caps?.tools === undefined ? [] : (await connection.client.listTools(undefined, signal === undefined ? {} : { signal })).tools
    this.#touch(connection)
    const info = connection.client.getServerVersion()
    const instructions = connection.client.getInstructions()
    return {
      tools: connection.tools.map(t => ({
        name: t.name,
        ...(t.title === undefined ? {} : { title: t.title }),
        ...(t.description === undefined ? {} : { description: t.description.slice(0, 2000) }),
        inputSchema: t.inputSchema,
        ...(t.annotations?.readOnlyHint === undefined ? {} : { readOnly: t.annotations.readOnlyHint }),
      })),
      ...(info === undefined ? {} : { server: { name: info.name, version: info.version } }),
      ...(instructions === undefined || instructions.trim() === '' ? {} : { instructions: instructions.slice(0, 8000) }),
    }
  }

  /** Call one of the server's tools. */
  async call(scriptId: string, endpoint: McpEndpoint, tool: string, args: Record<string, unknown>, options: { signal?: AbortSignal; timeoutMs?: number } = {}): Promise<McpCallOutcome> {
    const connection = await this.#connection(scriptId, endpoint, options.signal)
    if (connection.tools === undefined) await this.tools(scriptId, endpoint, options.signal)
    const definition = connection.tools?.find(t => t.name === tool)
    if (definition === undefined) throw new Error(`${endpoint.name} 没有工具 ${tool}；有：${(connection.tools ?? []).map(t => t.name).join('、') || '（没有工具）'}`)
    connection.lastUsed = Date.now()
    if (connection.timer !== undefined) clearTimeout(connection.timer)
    try {
      const result = await connection.client.callTool({ name: tool, arguments: args }, {
        ...(options.signal === undefined ? {} : { signal: options.signal }),
        timeout: options.timeoutMs ?? 5 * 60_000,
        resetTimeoutOnProgress: true,
      })
      return outcome(result)
    } catch (error) {
      throw new Error(`${endpoint.name}.${tool} 调用失败：${message(error)}${tail(connection.stderr)}`)
    } finally {
      this.#touch(connection)
    }
  }

  /** Close a script's connections (all of them without `scriptId`). */
  async close(scriptId?: string, name?: string): Promise<void> {
    const closing: Promise<void>[] = []
    for (const [key, connection] of this.#connections) {
      if (scriptId !== undefined && !key.startsWith(`${scriptId}/`)) continue
      if (name !== undefined && key !== `${scriptId}/${name}`) continue
      closing.push(this.#drop(connection))
    }
    await Promise.all(closing)
  }

  dispose(): Promise<void> {
    return this.close()
  }

  async #trust(): Promise<Set<string>> {
    if (this.#trusted === undefined) {
      const saved = await readFile(this.#trustFile, 'utf8').then(text => JSON.parse(text) as unknown, () => [])
      this.#trusted = new Set(Array.isArray(saved) ? saved.filter((v): v is string => typeof v === 'string') : [])
    }
    return this.#trusted
  }

  async #connection(scriptId: string, endpoint: McpEndpoint, signal?: AbortSignal): Promise<Connection> {
    if (endpoint.problem !== undefined) throw new Error(`MCP 服务 ${endpoint.name} 用不了：${endpoint.problem}`)
    const slot = `${scriptId}/${endpoint.name}`
    const key = fingerprint(scriptId, endpoint)
    const held = this.#connections.get(slot)
    if (held !== undefined && held.key === key) return held
    if (held !== undefined) await this.#drop(held) // the script changed its server (an update): start the new one
    const pending = this.#connecting.get(slot)
    if (pending !== undefined) return pending
    const started = this.#connect(slot, key, endpoint, signal).finally(() => this.#connecting.delete(slot))
    this.#connecting.set(slot, started)
    return started
  }

  async #connect(slot: string, key: string, endpoint: McpEndpoint, signal?: AbortSignal): Promise<Connection> {
    const stderr: string[] = []
    const client = new Client({ name: 'MultiGameAssistant', version: this.#options.version ?? '0.0.0' }, { capabilities: {}, versionNegotiation: { mode: 'auto' } })
    const attempt = async (transport: Transport) => {
      const timeout = AbortSignal.timeout(CONNECT_TIMEOUT_MS)
      await client.connect(transport, { signal: signal === undefined ? timeout : AbortSignal.any([signal, timeout]) } as never)
    }
    try {
      if (endpoint.transport === 'stdio') {
        const transport = new StdioClientTransport({ command: endpoint.command!, args: [...endpoint.args], env: { ...endpoint.env }, cwd: endpoint.cwd, stderr: 'pipe' })
        transport.stderr?.on('data', (chunk: Buffer) => {
          for (const line of chunk.toString('utf8').split(/\r?\n/)) if (line.trim() !== '') stderr.push(line.slice(0, 400))
          if (stderr.length > STDERR_LINES) stderr.splice(0, stderr.length - STDERR_LINES)
        })
        await attempt(transport)
      } else {
        const url = new URL(endpoint.url!)
        const init = { requestInit: { headers: { ...endpoint.headers } } }
        if (endpoint.transport === 'sse') await attempt(new SSEClientTransport(url, init))
        else {
          try {
            await attempt(new StreamableHTTPClientTransport(url, init))
          } catch (error) {
            // Older servers serve only the SSE transport at the same address.
            if (signal?.aborted === true) throw error
            await attempt(new SSEClientTransport(url, init))
          }
        }
      }
    } catch (error) {
      await client.close().catch(() => {})
      const running = endpoint.needsRunning || endpoint.transport !== 'stdio'
        ? `。这个 MCP 服务由脚本自己的程序提供，要先启动脚本（打开它的窗口或运行一个任务），并在脚本设置里打开 MCP 服务`
        : ''
      throw new Error(`连不上 MCP 服务 ${endpoint.name}（${endpoint.transport === 'stdio' ? `${endpoint.command} ${endpoint.args.join(' ')}` : endpoint.url}）：${message(error)}${running}${tail(stderr)}`)
    }
    const connection: Connection = { key, client, stderr, endpoint, lastUsed: Date.now() }
    client.onclose = () => {
      if (this.#connections.get(slot) === connection) this.#connections.delete(slot)
      if (connection.timer !== undefined) clearTimeout(connection.timer)
    }
    this.#connections.set(slot, connection)
    this.#options.log?.info(`MCP server ${slot} connected (${endpoint.transport})`)
    this.#touch(connection)
    return connection
  }

  #touch(connection: Connection): void {
    connection.lastUsed = Date.now()
    if (connection.timer !== undefined) clearTimeout(connection.timer)
    connection.timer = setTimeout(() => void this.#drop(connection), this.#options.idleMs ?? IDLE_MS)
    connection.timer.unref?.()
  }

  async #drop(connection: Connection): Promise<void> {
    if (connection.timer !== undefined) clearTimeout(connection.timer)
    for (const [slot, held] of this.#connections) if (held === connection) this.#connections.delete(slot)
    await connection.client.close().catch(error => this.#options.log?.warn(`MCP server ${connection.endpoint.name} did not close cleanly: ${message(error)}`))
  }
}

const MAX_TEXT = 40_000

function outcome(result: CallToolResult): McpCallOutcome {
  const texts: string[] = []
  const other: string[] = []
  for (const block of (result.content ?? []) as Array<Record<string, unknown>>) {
    switch (block['type']) {
      case 'text': texts.push(String(block['text'] ?? '')); break
      case 'image': other.push(`图片（${String(block['mimeType'] ?? 'image')}）`); break
      case 'audio': other.push(`音频（${String(block['mimeType'] ?? 'audio')}）`); break
      case 'resource_link': texts.push(`[${String(block['name'] ?? '资源')}](${String(block['uri'] ?? '')})`); break
      case 'resource': {
        const resource = block['resource'] as Record<string, unknown> | undefined
        if (typeof resource?.['text'] === 'string') texts.push(resource['text'])
        else other.push(`资源 ${String(resource?.['uri'] ?? '')}`)
        break
      }
      default: other.push(String(block['type'] ?? '未知内容'))
    }
  }
  let text = texts.join('\n')
  if (text.length > MAX_TEXT) text = `${text.slice(0, MAX_TEXT)}\n…（还有 ${text.length - MAX_TEXT} 个字符没有显示）`
  return {
    isError: result.isError === true,
    text,
    ...(result.structuredContent === undefined ? {} : { structured: result.structuredContent }),
    other,
  }
}

function tail(stderr: readonly string[]): string {
  return stderr.length === 0 ? '' : `\n它的输出（stderr）最后几行：\n${stderr.slice(-12).join('\n')}`
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() !== '' ? value : undefined
}

function strings(value: Record<string, unknown>): Record<string, string> {
  return Object.fromEntries(Object.entries(value).filter((e): e is [string, string | number | boolean] => ['string', 'number', 'boolean'].includes(typeof e[1])).map(([k, v]) => [k, String(v)]))
}
