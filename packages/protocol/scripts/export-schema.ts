/** Write schema/protocol.schema.json from the zod source of truth. */
import { mkdirSync, writeFileSync } from 'node:fs'
import { z } from 'zod'
import { LiveFrame, Notifications, PROTOCOL_VERSION, Requests, SessionEvent } from '../src/index.ts'

const defs: Record<string, unknown> = {}
const add = (key: string, schema: z.ZodType) => {
  defs[key] = z.toJSONSchema(schema, { target: 'draft-2020-12', unrepresentable: 'any' })
}
add('SessionEvent', SessionEvent)
add('LiveFrame', LiveFrame)
for (const [method, spec] of Object.entries(Requests)) {
  add(`${method}.params`, spec.params)
  add(`${method}.result`, spec.result)
}
for (const [method, schema] of Object.entries(Notifications)) add(`${method}.notification`, schema)

const document = {
  $schema: 'https://json-schema.org/draft/2020-12/schema',
  title: 'dsh custom UI protocol',
  version: PROTOCOL_VERSION,
  methods: Object.fromEntries(Object.entries(Requests).map(([m, s]) => [m, { capability: s.capability }])),
  notifications: Object.keys(Notifications),
  $defs: defs,
}
mkdirSync(new URL('../schema/', import.meta.url), { recursive: true })
writeFileSync(new URL('../schema/protocol.schema.json', import.meta.url), `${JSON.stringify(document, null, 2)}\n`)
console.log(`protocol v${PROTOCOL_VERSION}: ${Object.keys(defs).length} schemas written`)
