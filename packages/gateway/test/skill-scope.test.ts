import { strict as assert } from 'node:assert'
import { mkdtempSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { invokedSkills, SkillScope } from '../src/skill-scope.ts'

const quiet = { warn() {} }
const agentOf = (sessionId: string) => ({ session: { id: sessionId } })
const names = async (scope: SkillScope, invalidate: () => void, scopeKey?: unknown) =>
  ((await scope.provider(invalidate).list(scopeKey === undefined ? {} : { scope: scopeKey })) as { name: string }[]).map(s => s.name).sort()

function skills(scope: SkillScope) {
  scope.register({ name: 'general-tips', description: 'd', content: 'c', source: 'custom' })
  scope.register({ name: 'maa-daily', description: 'd', content: 'c', source: 'custom', owner: { scripts: ['maa'] } })
  scope.register({ name: 'm7-daily', description: 'd', content: 'c', source: 'custom', owner: { scripts: ['march7th'] } })
  scope.register({ name: 'game-arknights', description: 'd', content: 'c', source: 'custom', owner: { games: ['arknights', '明日方舟'] } })
}

test('a session sees the general skills and those of its focus; a script brings its pack and game; a list without a session sees all', async () => {
  const scope = new SkillScope(undefined, quiet)
  let invalidated = 0
  const invalidate = () => { invalidated += 1 }
  scope.provider(invalidate)
  skills(scope)
  // The local import "my-maa" uses pack "maa", which plays 明日方舟.
  scope.resolveScripts(id => (id === 'my-maa' ? { aliases: ['maa'], games: ['明日方舟'] } : { aliases: [], games: [] }))

  assert.deepEqual(await names(scope, invalidate), ['game-arknights', 'general-tips', 'm7-daily', 'maa-daily'])
  assert.deepEqual(await names(scope, invalidate, agentOf('s1')), ['general-tips'], 'never focused: general only')

  const before = invalidated
  await scope.setFocus('s1', { scripts: ['my-maa'] })
  assert.ok(invalidated > before, 'a focus change invalidates the catalog')
  assert.deepEqual(await names(scope, invalidate, agentOf('s1')), ['game-arknights', 'general-tips', 'maa-daily'])

  await scope.setFocus('s1', { scripts: ['march7th'] })
  assert.deepEqual(await names(scope, invalidate, agentOf('s1')), ['general-tips', 'm7-daily'], 'replaced: MAA’s skills are gone')
  await scope.setFocus('s1', { games: ['ARKNIGHTS'] }, 'add')
  assert.deepEqual(await names(scope, invalidate, agentOf('s1')), ['game-arknights', 'general-tips', 'm7-daily'], 'added, game ids case-insensitive')
  assert.deepEqual(await names(scope, invalidate, agentOf('s2')), ['general-tips'], 'other sessions are untouched')
})

test('focus survives a restart; the first skill of a name wins and its disposer only removes itself', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-scope-'))
  const first = new SkillScope(dir, quiet)
  await first.setFocus('s1', { scripts: ['maa'] })
  await new Promise(resolve => setTimeout(resolve, 50))
  const second = new SkillScope(dir, quiet)
  skills(second)
  assert.deepEqual(await names(second, () => {}, agentOf('s1')), ['general-tips', 'maa-daily'])

  const dispose = second.register({ name: 'maa-daily', description: 'other', content: 'x', source: 'hub' })
  dispose()
  assert.equal(second.ownerOf('maa-daily')?.scripts?.[0], 'maa', 'the duplicate did not replace or remove the first')
})

test('skills a user invokes by name are read like dsh reads them', () => {
  const user = (text: string) => ({ source: { kind: 'user' }, content: [{ type: 'text', text }] })
  assert.deepEqual(invokedSkills([user('/maa-daily 跑一下'), user('再用 /game-arknights'), { source: { kind: 'assistant' }, content: [{ type: 'text', text: '/m7-daily' }] }, user('a/b not-a-skill')]), ['maa-daily', 'game-arknights'])
})
