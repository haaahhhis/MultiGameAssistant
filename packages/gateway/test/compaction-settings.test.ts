import { strict as assert } from 'node:assert'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { CompactionStore, DEFAULT_COMPACTION, readSettings } from '../src/compaction-settings.ts'
import { declaredMaxTokens, type ProvidersDeps } from '../src/providers.ts'

const dir = () => mkdtempSync(join(tmpdir(), 'adg-compaction-'))

test('a file from before the summarizer existed reads as the conversation\'s own model', () => {
  const home = dir()
  writeFileSync(join(home, 'compaction.json'), JSON.stringify({ auto: true, threshold: 60, lowContext: false, archiveDays: null, ptcSubagents: true }))
  const read = readSettings(join(home, 'compaction.json'))
  assert.equal(read.summarizer, null)
  assert.equal(read.threshold, 60)
})

test('the summarizer is saved with its own output limit when that is below dsh\'s default; it waits for a restart', async () => {
  const home = dir()
  const store = new CompactionStore(home)
  const limits: Record<string, number> = { 'relay/small': 8192, 'relay/big': 200_000 }
  const limit = (provider: string, model: string) => limits[`${provider}/${model}`]

  const small = await store.set({ ...DEFAULT_COMPACTION, summarizer: { provider: 'relay', model: 'small' } }, limit)
  assert.deepEqual(small.settings.summarizer, { provider: 'relay', model: 'small', maxTokens: 8192 })
  assert.equal(small.applied.summarizer, null, 'dsh still runs with what it read at start')
  assert.deepEqual(JSON.parse(readFileSync(join(home, 'compaction.json'), 'utf8')).summarizer, { provider: 'relay', model: 'small', maxTokens: 8192 })

  const big = await store.set({ ...DEFAULT_COMPACTION, summarizer: { provider: 'relay', model: 'big' } }, limit)
  assert.deepEqual(big.settings.summarizer, { provider: 'relay', model: 'big' }, 'dsh\'s default is lower: no cap of its own')

  // A cap the page sends is not taken: the host says what the model can write.
  const sent = await store.set({ ...DEFAULT_COMPACTION, summarizer: { provider: 'deepseek-official', model: 'deepseek-flash', maxTokens: 10 } }, limit)
  assert.deepEqual(sent.settings.summarizer, { provider: 'deepseek-official', model: 'deepseek-flash' })
  const without = await store.set({ ...DEFAULT_COMPACTION, summarizer: { provider: 'relay', model: 'small' } })
  assert.deepEqual(without.settings.summarizer, { provider: 'relay', model: 'small' }, 'no routes to ask: dsh\'s default')

  assert.equal((await store.set({ ...DEFAULT_COMPACTION, summarizer: null }, limit)).settings.summarizer, null)
  assert.deepEqual(new CompactionStore(home).applied, { ...DEFAULT_COMPACTION, summarizer: null }, 'what the next start reads')
  await assert.rejects(store.set({ ...DEFAULT_COMPACTION, summarizer: { provider: '', model: 'x' } }))
})

test('a route\'s declared output limit is read from its saved models', () => {
  const user = { providers: { relay: { api: 'openai-completions', models: [{ id: 'small', maxTokens: 8192 }, { id: 'open' }] } } }
  const settings = { describe: () => [{ ns: 'llm-pi-ai', value: user, user, revision: 1 }] } as unknown as ProvidersDeps['settings']
  assert.equal(declaredMaxTokens(settings, 'llm-pi-ai', 'relay', 'small'), 8192)
  assert.equal(declaredMaxTokens(settings, 'llm-pi-ai', 'relay', 'open'), undefined, 'none declared')
  assert.equal(declaredMaxTokens(settings, 'llm-pi-ai', 'relay', 'gone'), undefined)
  assert.equal(declaredMaxTokens(settings, 'llm-pi-ai', 'deepseek-official', 'deepseek-flash'), undefined, 'not one of these routes')
  assert.equal(declaredMaxTokens(settings, 'other', 'relay', 'small'), undefined)
})
