import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { QUIET, relayMessage, taskMessage, type HandOff } from '@adg/protocol'
import type { ConversationEvent } from '../src/conversations.ts'
import { HomeMirror } from '../src/mirror.ts'
import { channelNote, type Actor, type MirrorPost } from '../src/notify.ts'

const zhang: Actor = { channel: 'feishu', userId: 'ou_1', name: '张三' }

function setup(origins: Record<string, Actor> = {}) {
  const posts: { text: string; markdown: boolean; except: string | undefined }[] = []
  const mirror = new HomeMirror({
    sessions: () => undefined,
    home: async () => 's-main',
    originOf: text => origins[text],
    channelName: id => (id === 'feishu' ? '飞书' : id),
    agentName: id => ({ games: '游戏' })[id] ?? id,
    post: (post: MirrorPost, except?: Actor) => { posts.push({ text: post.text, markdown: post.markdown === true, except: except?.userId }) },
    log: { warn() {} },
  })
  return { mirror, posts }
}

const said = (text: string, human = true): ConversationEvent => ({ type: 'user/message', content: [{ type: 'text', text }], origin: { kind: human ? 'user' : 'time-context', human } }) as unknown as ConversationEvent
const answer = (text: string): ConversationEvent => ({ type: 'assistant/message', content: [{ type: 'text', text }] }) as unknown as ConversationEvent
const call = (callId: string): ConversationEvent => ({ type: 'tool/call', callId, name: 'game_read', arguments: '{}' }) as unknown as ConversationEvent
const result = (callId: string): ConversationEvent => ({ type: 'tool/result', callId, isError: false }) as unknown as ConversationEvent
const end: ConversationEvent = { type: 'turn/end', reason: { kind: 'completed' } } as unknown as ConversationEvent

test('what is typed in the app and 助手\'s reply go to the chat apps as text; a chat person\'s own message and answer do not come back to them; notes for the model never go', () => {
  const fromFeishu = `${channelNote('feishu')}\n今天有什么活动`
  const { mirror, posts } = setup({ [fromFeishu]: zhang })
  for (const event of [said('Time sampled while preparing turn 8', false), said('（提醒）距上一条消息过去了 9 小时', false), said('看看日常跑了没'), call('c1'), result('c1'), answer('**跑完了**'), end]) mirror.event(event)
  for (const event of [said('Time sampled while preparing turn 9', false), said(fromFeishu), answer('没有快结束的'), end]) mirror.event(event)
  assert.deepEqual(posts, [
    { text: '你（软件）：看看日常跑了没', markdown: false, except: undefined },
    { text: '**跑完了**\n\n（执行了 1 个步骤；完整过程在软件的对话记录里）', markdown: true, except: undefined },
    { text: '张三（飞书）：今天有什么活动', markdown: false, except: 'ou_1' },
    { text: '没有快结束的', markdown: true, except: 'ou_1' },
  ])
})

test('messages between 助手 and the other agents are lines; a reply with nothing to tell is not sent', async () => {
  const handOff: HandOff = { id: 'h1', fromSession: 's-main', callId: 'c1', by: '助手', to: 'games', toSession: 's-games', title: '看今天结束的活动', task: '…', state: 'running', startedAt: 1 }
  const early = setup()
  early.mirror.handOff(handOff)
  assert.deepEqual(early.posts, [], "before the mirror knows 助手's conversation, no hand-off is 助手's")

  const { mirror, posts, ready } = setupWithHome()
  await ready
  mirror.handOff(handOff)
  mirror.handOff(handOff)
  mirror.handOff({ ...handOff, state: 'done', reply: '没有' })
  mirror.handOff({ ...handOff, id: 'h2', fromSession: 's-other' })
  for (const event of [said(relayMessage({ agent: '游戏', asker: '你', title: '看今天结束的活动', ok: true, reply: '没有' })), answer(QUIET), end]) mirror.event(event)
  for (const event of [said(taskMessage('定时任务', '晚上看日报', '读一下日报')), answer('日报没有新东西'), end]) mirror.event(event)
  mirror.stop()
  assert.deepEqual(posts.map(p => p.text), [
    '助手 → 游戏：看今天结束的活动',
    '游戏 → 助手：看今天结束的活动（交回了）',
    '定时任务 → 助手：晚上看日报',
    '日报没有新东西',
  ])
})

test('every reply 助手 gives goes out, whatever started the turn: a reminder it set itself, or a turn already going', () => {
  const fromFeishu = `${channelNote('feishu')}\n提醒我一下`
  const { mirror, posts } = setup({ [fromFeishu]: zhang })
  // Mid-turn when the mirror starts following: no start seen.
  for (const event of [answer('刚才那件事做完了'), end]) mirror.event(event)
  // A reminder 助手 set (dsh's schedule): its text is for the model; its reply is for everyone.
  for (const event of [said('[SCHEDULE REMINDER]\nreminder_prompt_json: "提醒主人看活动"', false), answer('主人，到点啦：记得看活动喵～'), end]) mirror.event(event)
  // The time note comes first; the turn is still the Feishu person's.
  for (const event of [said('Time sampled while preparing turn 3', false), said(fromFeishu), answer('好的'), end]) mirror.event(event)
  assert.deepEqual(posts, [
    { text: '刚才那件事做完了', markdown: true, except: undefined },
    { text: '定时提醒：提醒主人看活动', markdown: false, except: undefined },
    { text: '主人，到点啦：记得看活动喵～', markdown: true, except: undefined },
    { text: '张三（飞书）：提醒我一下', markdown: false, except: 'ou_1' },
    { text: '好的', markdown: true, except: 'ou_1' },
  ])
})

/** A mirror that has started following 助手's conversation (`s-main`): its follow ends at once. */
function setupWithHome() {
  const posts: { text: string }[] = []
  const mirror = new HomeMirror({
    sessions: () => ({ follow: () => ({ async *[Symbol.asyncIterator]() {} }) }) as never,
    home: async () => 's-main',
    originOf: () => undefined,
    channelName: id => id,
    agentName: id => ({ games: '游戏' })[id] ?? id,
    post: post => { posts.push({ text: post.text }) },
    log: { warn() {} },
    retryMs: 60_000,
  })
  mirror.start()
  return { mirror, posts, ready: new Promise(resolve => setImmediate(resolve)) }
}
