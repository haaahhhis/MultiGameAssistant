/**
 * Fake OpenAI-compatible model endpoint on loopback.
 *
 * Serves `GET /v1/models` and `POST /v1/chat/completions` (streaming and not).
 * Each completion request takes the next scripted reply: plain text or tool
 * calls. Lets the agent loop, approvals and tool flows run end to end with no
 * API key and no network. Register it in dsh as a custom provider with the
 * `openai-completions` protocol and base URL `${url}/v1`.
 */
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http'
import type { AddressInfo } from 'node:net'

export type FakeReply =
  | { readonly text: string }
  | { readonly toolCalls: readonly { readonly name: string; readonly arguments: Readonly<Record<string, unknown>> }[] }

export interface FakeLlmOptions {
  /** Model ids listed by `/v1/models`. */
  readonly models?: readonly string[]
  /** Replies in order; once used up, every request gets `fallback`. */
  readonly replies?: readonly FakeReply[]
  readonly fallback?: FakeReply
  /**
   * Which requests consume the script; others get `fallback`. Use it to keep
   * side requests (dsh's session-title request, which offers no tools) from
   * eating replies meant for the agent loop. Default: every request.
   */
  readonly scripted?: (body: Readonly<Record<string, unknown>>) => boolean
  /** Decide a reply from the request itself; returning undefined falls back to the script. */
  readonly respond?: (body: Readonly<Record<string, unknown>>) => FakeReply | undefined
  /** The prompt tokens reported for a request (default 100); what dsh's token meter, and so its compaction, goes by. */
  readonly promptTokens?: (body: Readonly<Record<string, unknown>>) => number
}

export interface FakeLlm {
  /** e.g. `http://127.0.0.1:54321`; the OpenAI base URL is `${url}/v1`. */
  readonly url: string
  /** Parsed bodies of every completion request, in order. */
  readonly requests: readonly Record<string, unknown>[]
  /** Append replies to the script. */
  push(...replies: FakeReply[]): void
  close(): Promise<void>
}

export async function startFakeLlm(options: FakeLlmOptions = {}): Promise<FakeLlm> {
  const models = options.models ?? ['fake-model']
  const queue: FakeReply[] = [...(options.replies ?? [])]
  const fallback = options.fallback ?? { text: '好的。' }
  const requests: Record<string, unknown>[] = []
  let sequence = 0

  const server = createServer((req, res) => {
    void handle(req, res).catch(error => {
      if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: String(error) } }))
    })
  })

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const path = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method === 'GET' && path === '/v1/models') {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ object: 'list', data: models.map(id => ({ id, object: 'model', owned_by: 'adg-test-kit' })) }))
      return
    }
    if (req.method !== 'POST' || path !== '/v1/chat/completions') {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { message: 'not found' } }))
      return
    }
    const body = JSON.parse(await readBody(req)) as Record<string, unknown>
    requests.push(body)
    const reply = options.respond?.(body) ?? ((options.scripted?.(body) ?? true) ? queue.shift() ?? fallback : fallback)
    const id = `chatcmpl-fake-${++sequence}`
    const model = typeof body['model'] === 'string' ? body['model'] : models[0]!
    const toolCalls = 'toolCalls' in reply
      ? reply.toolCalls.map((call, index) => ({ index, id: `call_${sequence}_${index}`, type: 'function', function: { name: call.name, arguments: JSON.stringify(call.arguments) } }))
      : undefined
    const finish = toolCalls === undefined ? 'stop' : 'tool_calls'
    const prompt = options.promptTokens?.(body) ?? 100
    const usage = { prompt_tokens: prompt, completion_tokens: 20, total_tokens: prompt + 20 }

    if (body['stream'] !== true) {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({
        id, object: 'chat.completion', created: Math.floor(Date.now() / 1000), model,
        choices: [{ index: 0, finish_reason: finish, message: { role: 'assistant', content: 'text' in reply ? reply.text : null, ...(toolCalls === undefined ? {} : { tool_calls: toolCalls }) } }],
        usage,
      }))
      return
    }

    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', connection: 'keep-alive' })
    const send = (chunk: unknown) => res.write(`data: ${JSON.stringify(chunk)}\n\n`)
    const base = { id, object: 'chat.completion.chunk', created: Math.floor(Date.now() / 1000), model }
    send({ ...base, choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }] })
    if ('text' in reply) {
      for (const piece of chunks(reply.text, 8)) send({ ...base, choices: [{ index: 0, delta: { content: piece }, finish_reason: null }] })
    } else {
      send({ ...base, choices: [{ index: 0, delta: { tool_calls: toolCalls }, finish_reason: null }] })
    }
    send({ ...base, choices: [{ index: 0, delta: {}, finish_reason: finish }] })
    send({ ...base, choices: [], usage })
    res.end('data: [DONE]\n\n')
  }

  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
  return {
    url,
    requests,
    push: (...replies) => { queue.push(...replies) },
    close: () => new Promise((resolve, reject) => {
      server.closeAllConnections()
      server.close(error => (error === undefined ? resolve() : reject(error)))
    }),
  }
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = []
    req.on('data', (part: Buffer) => parts.push(part))
    req.on('end', () => resolve(Buffer.concat(parts).toString('utf8')))
    req.on('error', reject)
  })
}

function chunks(text: string, size: number): string[] {
  const out: string[] = []
  for (let i = 0; i < text.length; i += size) out.push(text.slice(i, i + size))
  return out.length === 0 ? [''] : out
}
