// A minimal MCP server over stdio (newline-delimited JSON-RPC), standing in for a script's own:
// tools `status` and `start_task`; `fail` reports an error result.
import { createInterface } from 'node:readline'

const send = message => process.stdout.write(`${JSON.stringify(message)}\n`)
const tools = [
  { name: 'status', description: 'What the script is doing', inputSchema: { type: 'object', properties: {} }, annotations: { readOnlyHint: true } },
  { name: 'start_task', description: 'Start one task', inputSchema: { type: 'object', properties: { task: { type: 'string' } }, required: ['task'] } },
  { name: 'fail', description: 'Always fails', inputSchema: { type: 'object', properties: {} } },
]
let running = 'idle'
process.stderr.write(`fake server up in ${process.cwd()}\n`)

createInterface({ input: process.stdin }).on('line', line => {
  if (line.trim() === '') return
  const message = JSON.parse(line)
  if (message.id === undefined) return // notifications
  const reply = result => send({ jsonrpc: '2.0', id: message.id, result })
  switch (message.method) {
    case 'initialize':
      reply({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: {} }, serverInfo: { name: 'fake-script', version: '1.2.3' }, instructions: 'Call status first.' })
      break
    case 'tools/list':
      reply({ tools })
      break
    case 'tools/call': {
      const { name, arguments: args } = message.params
      if (name === 'status') reply({ content: [{ type: 'text', text: `running: ${running}; env FAKE_MODE=${process.env.FAKE_MODE ?? ''}` }] })
      else if (name === 'start_task') { running = args.task; reply({ content: [{ type: 'text', text: `started ${args.task}` }], structuredContent: { started: args.task } }) }
      else if (name === 'fail') reply({ isError: true, content: [{ type: 'text', text: 'no emulator connected' }] })
      else send({ jsonrpc: '2.0', id: message.id, error: { code: -32602, message: `unknown tool ${name}` } })
      break
    }
    case 'ping':
      reply({})
      break
    default:
      send({ jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `no method ${message.method}` } })
  }
})
