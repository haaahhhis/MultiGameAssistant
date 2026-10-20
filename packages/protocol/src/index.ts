/**
 * @adg/protocol — the only contract between the dsh host and any UI.
 *
 * Zod schemas are the single source: TypeScript types come from `z.infer`,
 * other languages generate from the exported JSON Schema
 * (`pnpm --filter @adg/protocol run schema`).
 */
export * from './events.ts'
export * from './methods.ts'
export * from './jsonrpc.ts'
export * from './scripts.ts'
export * from './runs.ts'
export * from './guard.ts'
export * from './emulators.ts'
export * from './packs.ts'
export * from './monitor.ts'
export * from './notify.ts'
export * from './pipelines.ts'
export * from './intervene.ts'
export * from './games.ts'
