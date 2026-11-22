import assert from 'node:assert/strict'
import { test } from 'node:test'
import { sessionConversations } from '../src/conversations.ts'

test('each app instruction runs in a native child of the stable role home with its own focus', async () => {
  const calls: string[][] = []
  const gateway = {
    home: async (role: string) => role + '-home',
    handOffs: { put: async () => {}, all: () => [] },
    runChild: async (owner: string, id: string, title: string, instruction: string) => {
      calls.push([owner, id, title, instruction])
      return '完成'
    },
  }
  const focused: string[] = []
  const conversations = sessionConversations({} as never, undefined, async id => focused.push(id), () => gateway)
  const a = await conversations.prepareTask('games', '查活动', { games: ['a'] })
  const b = await conversations.prepareTask('games', '查公告', { games: ['b'] })
  assert.deepEqual(focused, [a.id, b.id])
  assert.notEqual(a.id, b.id)
  await b.run('读官网', new AbortController().signal)
  assert.deepEqual(calls, [['games-home', b.id, '查公告', '读官网']])
})
