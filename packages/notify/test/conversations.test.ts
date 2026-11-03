import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { sessionConversations } from '../src/conversations.ts'

/** A session controller that only creates sessions: what it was asked, in order. */
function fakeSessions(lastUsed: { provider: string; model: string } | undefined) {
  const calls: string[] = []
  let n = 0
  const sessions = {
    list: async () => ({ items: lastUsed === undefined ? [] : [{ sessionId: 'old', updatedAt: 1, projections: { values: { title: '今天跑什么', modelSelection: { lastUsed } } } }] }),
    create: async () => { calls.push('create'); return { sessionId: `s${++n}` } },
    rename: async ({ title }: { title: string }) => { calls.push(`rename ${title}`); return { title } },
    selectModel: async (p: { model: string }) => { calls.push(`model ${p.model}`); return {} },
    follow: () => { throw new Error('not used') },
    prompt: async () => { throw new Error('not used') },
    projections: async () => null,
  }
  return { sessions: sessions as never, calls }
}

const gateway = (roleModel: { provider: string; model: string } | undefined, tagged: string[]) => () => ({
  sessionPreset: () => ({}),
  adopt: async () => {},
  tagSession: async (sessionId: string, role: string) => { tagged.push(`${sessionId}:${role}`) },
  roleModel: (role: string) => role === 'intervene' ? roleModel : undefined,
})

test("a role agent's session is put under its role and gets the role agents' model", async () => {
  const { sessions, calls } = fakeSessions({ provider: 'deepseek', model: 'deepseek-pro' })
  const tagged: string[] = []
  const conversations = sessionConversations(sessions, () => undefined, undefined, gateway({ provider: 'deepseek', model: 'deepseek-flash' }, tagged))
  await conversations.create('干预：MAA 出错', { defaultModel: true, role: 'intervene' })
  assert.deepEqual(tagged, ['s1:intervene'])
  assert.deepEqual(calls, ['create', 'rename 干预：MAA 出错', 'model deepseek-flash'])
})

test('with no role agents model chosen, sessions keep the model they always got', async () => {
  const { sessions, calls } = fakeSessions({ provider: 'deepseek', model: 'deepseek-pro' })
  const conversations = sessionConversations(sessions, () => undefined, undefined, gateway(undefined, []))
  await conversations.create('干预：MAA 出错', { defaultModel: true, role: 'intervene' })
  assert.deepEqual(calls, ['create', 'rename 干预：MAA 出错'], 'an intervention: the default model, as before')
  calls.length = 0
  await conversations.create('飞书：张三')
  assert.deepEqual(calls, ['create', 'rename 飞书：张三', 'model deepseek-pro'], 'the main agent: the model last used in the app')
})
