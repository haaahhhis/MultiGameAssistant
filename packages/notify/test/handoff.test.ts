import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseRelay, parseTask, type HandOff } from '@adg/protocol'
import { handOff, type HandOffDeps } from '../src/handoff.ts'
import type { Reply } from '../src/reply.ts'

/** Agents' conversations by agent; what was said in each; what was kept. */
function fake(answer: (sessionId: string, text: string) => Reply | Promise<Reply>) {
  const said: { sessionId: string; text: string }[] = []
  const kept: HandOff[] = []
  const relayed: Reply[] = []
  const deps: HandOffDeps = {
    home: async agent => `s-${agent}`,
    converse: async (sessionId, text) => { said.push({ sessionId, text }); return answer(sessionId, text) },
    record: async item => { kept.push(item) },
    now: () => 1000,
  }
  return { deps, said, kept, relayed }
}
const text = (t: string): Reply => ({ blocks: [{ kind: 'steps', steps: [{ name: 'game_activities', summary: '', status: 'ok' }] }, { kind: 'text', text: t }] })
const settle = () => new Promise(resolve => setImmediate(resolve))

test("助手's work goes into the agent's one conversation as 助手's; the reply comes back into 助手's, words only", async () => {
  const f = fake(sessionId => (sessionId === 's-games' ? text('今天结束的活动：无') : text('游戏读完了：今天没有要结束的活动')))
  const relayed: Reply[] = []
  const reply = await handOff(f.deps, {
    to: { id: 'games', name: '游戏' }, by: '助手', title: '读明日方舟的活动', task: '读明日方舟今天的活动', expecting: '今天结束的活动',
    signal: new AbortController().signal, from: { sessionId: 's-chat', callId: 'call-1', asker: '助手' }, relay: true, relayed: r => relayed.push(r),
  })
  await settle()
  assert.equal(f.said[0]!.sessionId, 's-games')
  const task = parseTask(f.said[0]!.text)!
  assert.deepEqual({ by: task.by, title: task.title, returns: task.returns }, { by: '助手', title: '读明日方舟的活动', returns: true })
  assert.equal(task.body, '读明日方舟今天的活动\n\n要交回的：今天结束的活动')
  assert.equal(f.said[1]!.sessionId, 's-chat', 'back to the conversation that asked')
  const back = parseRelay(f.said[1]!.text)!
  assert.deepEqual(back, { agent: '游戏', ok: true, asker: '你', title: '读明日方舟的活动', reply: '今天结束的活动：无' }, 'its words, not its steps')
  assert.equal(relayed.length, 1, "助手's turn on it goes on to whoever it was answering")
  assert.equal(reply.blocks.length, 2)
  assert.deepEqual(f.kept.map(h => [h.id, h.state, h.reply]), [['call-1', 'running', undefined], ['call-1', 'done', '今天结束的活动：无']])
  assert.deepEqual({ from: f.kept[1]!.fromSession, to: f.kept[1]!.toSession, callId: f.kept[1]!.callId }, { from: 's-chat', to: 's-games', callId: 'call-1' })
})

test("the app's own hand-off (监控 → 干预) reports to 助手's conversation, and a failure is said as one", async () => {
  const f = fake(sessionId => (sessionId === 's-intervene' ? Promise.reject(new Error('用户接管')) : text('好')))
  await assert.rejects(handOff(f.deps, {
    to: { id: 'intervene', name: '干预' }, by: '监控', title: 'MAA · 日常：出错', task: '处理这个异常', signal: new AbortController().signal, relay: true,
  }), /用户接管/)
  await settle()
  assert.equal(f.said[1]!.sessionId, 's-main', "助手's conversation")
  assert.deepEqual(parseRelay(f.said[1]!.text), { agent: '干预', ok: false, asker: '监控', title: 'MAA · 日常：出错', reply: '用户接管' })
  assert.equal(f.kept.at(-1)!.state, 'failed')
  assert.equal(f.kept.at(-1)!.callId, undefined)
})

test('a turn that ended early, or left no words, did not finish', async () => {
  const cut = fake(() => ({ blocks: [{ kind: 'text', text: '装到一半' }], ended: '（这一轮没有完成：被打断了）' }))
  await handOff(cut.deps, { to: { id: 'scripts', name: '脚本' }, by: '助手', title: '装 MAA', task: '装 MAA', signal: new AbortController().signal, from: { sessionId: 's-chat', asker: '助手' }, relay: true })
  await settle()
  assert.equal(parseRelay(cut.said[1]!.text)?.reply, '这一轮没有完成：被打断了。它最后说：装到一半')
  const silent = fake(() => ({ blocks: [] }))
  await handOff(silent.deps, { to: { id: 'scripts', name: '脚本' }, by: '助手', title: '装 MAA', task: '装 MAA', signal: new AbortController().signal, from: { sessionId: 's-chat', asker: '助手' }, relay: true })
  await settle()
  assert.equal(silent.kept.at(-1)!.reply, '它没有留下回复')
})

test('without relay, nothing goes back: the work is noted as from whoever asked, and that is all', async () => {
  const f = fake(() => text('日报正文'))
  await handOff(f.deps, { to: { id: 'games', name: '游戏' }, by: '定时', title: '日报', task: '写日报', signal: new AbortController().signal })
  await settle()
  assert.equal(f.said.length, 1)
  assert.equal(parseTask(f.said[0]!.text)?.returns, false)
})
