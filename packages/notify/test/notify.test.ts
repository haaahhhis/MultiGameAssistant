import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { ApprovalRequested, ChannelStatus } from '@adg/protocol'
import { Notify, type Channel, type Conversations, type Notice } from '../src/notify.ts'
import { replyMarkdown, replyPlain, type Reply } from '../src/reply.ts'

function fakeChannel(state: ChannelStatus['state'] = 'ready', options: { id?: string; others?: boolean } = {}) {
  const id = options.id ?? 'fake'
  const sent: Notice[] = []
  const asked: ApprovalRequested[] = []
  const owners: (string | undefined)[] = []
  const resolved: string[] = []
  const channel: Channel = {
    id, name: '假渠道',
    status: () => ({ id, name: '假渠道', state, recipients: 1, checks: [] }),
    send: async notice => { sent.push(notice) },
    approvals: {
      active: owner => state === 'ready' && (owner !== undefined || options.others !== false),
      ask: async (request, owner) => { asked.push(request); owners.push(owner) },
      resolved: async (approvalId, outcome) => { resolved.push(`${approvalId}:${outcome}`) },
    },
  }
  return { channel, sent, asked, owners, resolved }
}

function setup(conversations?: Conversations) {
  const answered: string[] = []
  const sessions = new Map<string, string>()
  const notify = new Notify({
    conversations: () => conversations,
    respondApproval: (id, decision) => { answered.push(`${id}:${decision}`); return true },
    sessions: { get: key => sessions.get(key), set: async (key, id) => { sessions.set(key, id) }, keyOf: id => [...sessions].find(([, s]) => s === id)?.[0] },
    changed: () => {},
    log: { info() {}, warn() {} },
  })
  return { notify, answered, sessions }
}

const actor = { channel: 'fake', userId: 'ou_1', name: '张三' }
const notice = (id: string): Notice => ({
  id, scope: 'monitor', title: 'MAA · 日常：出错', text: '重连失败', severity: 'error',
  actions: [{ id: 'stop', label: '停止' }, { id: 'retry', label: '重试' }, { id: 'resolve', label: '忽略' }],
})

test('notices go to ready channels; a reply naming a button acts on the notice', async () => {
  const { notify } = setup()
  const ready = fakeChannel()
  const off = fakeChannel('off')
  notify.registerChannel(ready.channel)
  notify.registerChannel({ ...off.channel, id: 'off' })
  const acted: string[] = []
  notify.onAction('monitor', async (id, action, who) => { acted.push(`${id}:${action}:${who.name}`); return '已停止' })

  assert.deepEqual(await notify.send(notice('inc-1')), ['假渠道'])
  assert.equal(off.sent.length, 0)
  assert.equal(replyMarkdown(await notify.inbound({ actor, text: '停止' })), '已停止', 'the only open notice with that button')
  assert.deepEqual(acted, ['inc-1:stop:张三'])

  await notify.send(notice('inc-2'))
  assert.equal(replyMarkdown(await notify.inbound({ actor, text: '重试！', replyTo: 'inc-1' })), '已停止', 'a reply names its notice')
  assert.deepEqual(acted.at(-1), 'inc-1:retry:张三')
})

test('with two open notices, a bare "停止" is a question for the agent, in the person\'s own session', async () => {
  const asked: string[] = []
  let created = 0
  const conversations: Conversations = {
    create: async title => { created++; return `s-${title}` },
    exists: async () => true,
    ask: async (sessionId, text) => { asked.push(`${sessionId}:${text}`); return '好的，已经停了 MAA' },
  }
  const { notify, sessions } = setup(conversations)
  notify.registerChannel(fakeChannel().channel)
  notify.onAction('monitor', async () => 'x')
  await notify.send(notice('a'))
  await notify.send(notice('b'))
  assert.equal(replyMarkdown(await notify.inbound({ actor, text: '停止' })), '好的，已经停了 MAA')
  assert.equal(replyMarkdown(await notify.inbound({ actor, text: '现在什么状态' })), '好的，已经停了 MAA')
  assert.equal(created, 1, 'one session per person')
  assert.deepEqual(asked, ['s-fake：张三:停止', 's-fake：张三:现在什么状态'])
  assert.equal(sessions.get('fake:ou_1'), 's-fake：张三')
  await notify.update('a', { done: '已忽略' })
  await notify.update('b', { done: '已忽略' })
  assert.equal(replyMarkdown(await notify.inbound({ actor, text: '停止' })), '好的，已经停了 MAA', 'handled notices take no replies')
})

test('approvals go to channels that can show them; the answer goes back to the gateway', () => {
  const { notify, answered } = setup()
  const ready = fakeChannel()
  notify.registerChannel(ready.channel)
  assert.equal(notify.approvalsActive(), true)
  const request: ApprovalRequested = { approvalId: 'ap-1', sessionId: 's', toolName: 'pwsh', reason: '安装依赖' }
  notify.askApproval(request)
  assert.deepEqual(ready.asked, [request])
  assert.equal(notify.respondApproval('ap-1', 'allow-once', actor), true)
  assert.deepEqual(answered, ['ap-1:allow-once'])
  notify.approvalResolved('ap-1', 'allowed-once')
  assert.deepEqual(ready.resolved, ['ap-1:allowed-once'])
})

test('a chat conversation’s approvals go to its person only; other sessions’ only where channels take them', async () => {
  const { notify, sessions } = setup()
  const feishu = fakeChannel('ready', { id: 'feishu', others: false })
  const other = fakeChannel('ready', { id: 'qq' })
  notify.registerChannel(feishu.channel)
  notify.registerChannel(other.channel)
  sessions.set('feishu:ou_1', 'chat-1')

  const fromChat: ApprovalRequested = { approvalId: 'ap-chat', sessionId: 'chat-1', toolName: 'pwsh' }
  assert.equal(notify.approvalsActive('chat-1'), true)
  notify.askApproval(fromChat)
  assert.deepEqual(feishu.asked, [fromChat])
  assert.deepEqual(feishu.owners, ['ou_1'], 'sent to the person whose conversation it is')
  assert.deepEqual(other.asked, [], 'and to no other channel')

  const fromUi: ApprovalRequested = { approvalId: 'ap-ui', sessionId: 'ui-1', toolName: 'pwsh' }
  notify.askApproval(fromUi)
  assert.deepEqual(feishu.asked, [fromChat], 'a channel that does not take other sessions’ questions gets none')
  assert.deepEqual(other.asked, [fromUi])
  assert.deepEqual(other.owners, [undefined])

  const lone = setup()
  lone.notify.registerChannel(fakeChannel('ready', { id: 'feishu', others: false }).channel)
  assert.equal(lone.notify.approvalsActive('ui-1'), false, 'nothing can answer a UI session’s question: the UI asks alone')
})

test('the agent’s questions: routed like approvals, answered by buttons or by a plain reply', async () => {
  const answered: string[] = []
  const sessions = new Map<string, string>([['feishu:ou_1', 'chat-1']])
  const prompts: string[] = []
  const notify = new Notify({
    conversations: () => ({ ask: async (_s, text) => { prompts.push(text); return '好的' }, create: async () => 'new', exists: async () => true }),
    respondApproval: () => true,
    respondQuestion: (id, answers) => { answered.push(`${id}:${JSON.stringify(answers)}`); return true },
    sessions: { get: key => sessions.get(key), set: async (key, id) => { sessions.set(key, id) }, keyOf: id => [...sessions].find(([, s]) => s === id)?.[0] },
    changed: () => {},
    log: { info() {}, warn() {} },
  })
  const asked: { id: string; owner: string | undefined }[] = []
  notify.registerChannel({
    id: 'feishu', name: '飞书',
    status: () => ({ id: 'feishu', name: '飞书', state: 'ready', recipients: 1, checks: [] }),
    send: async () => {},
    questions: { active: owner => owner !== undefined, ask: async (r, owner) => { asked.push({ id: r.questionId, owner }) }, resolved: async () => {} },
  })
  const feishuActor = { channel: 'feishu', userId: 'ou_1', name: '张三' }

  // a UI session's question stays in the UI here (the channel takes only its own conversations')
  assert.equal(notify.questionsActive('ui-1'), false)
  notify.askQuestion({ questionId: 'q-ui', sessionId: 'ui-1', questions: [{ id: 'a', question: '?' }] })
  assert.deepEqual(asked, [])
  assert.equal(replyMarkdown(await notify.inbound({ actor: feishuActor, text: '在吗' })), '好的', 'with nothing asked, a message goes to the agent')

  // the Feishu conversation's: two questions, the first answered by number, the second by text
  notify.askQuestion({
    questionId: 'q-1', sessionId: 'chat-1',
    questions: [
      { id: 'close', question: '要不要把游戏关掉？', options: [{ label: '关掉游戏 (Recommended)' }, { label: '先开着' }] },
      { id: 'when', question: '明天几点再看？' },
    ],
  })
  assert.deepEqual(asked, [{ id: 'q-1', owner: 'ou_1' }])
  assert.match(replyMarkdown(await notify.inbound({ actor: feishuActor, text: '1' })), /还有一个问题：明天几点再看？/)
  assert.deepEqual(answered, [], 'not sent until every question has an answer')
  assert.match(replyMarkdown(await notify.inbound({ actor: feishuActor, text: '早上九点' })), /已经告诉 agent：早上九点/)
  assert.deepEqual(answered, [`q-1:${JSON.stringify([{ id: 'close', selected: ['关掉游戏 (Recommended)'] }, { id: 'when', selected: [], custom: '早上九点' }])}`])
  assert.deepEqual(prompts, ['在吗'], 'answers never become new prompts')
  notify.questionResolved('q-1', 'answered')

  // a label without "(Recommended)" picks it too; a button answers through answerQuestion
  notify.askQuestion({ questionId: 'q-2', sessionId: 'chat-1', questions: [{ id: 'close', question: '关掉吗？', options: [{ label: '关掉游戏 (Recommended)' }, { label: '先开着' }] }] })
  assert.match(replyMarkdown(await notify.inbound({ actor: feishuActor, text: '关掉游戏' })), /已经告诉 agent：关掉游戏 \(Recommended\)/)
  notify.questionResolved('q-2', 'answered')
  notify.askQuestion({ questionId: 'q-3', sessionId: 'chat-1', questions: [{ id: 'close', question: '关掉吗？', options: [{ label: '关掉' }, { label: '先开着' }] }] })
  assert.deepEqual(notify.answerQuestion('q-3', { id: 'close', selected: ['先开着'] }, feishuActor), { done: true })
  notify.questionResolved('q-3', 'answered')
  assert.equal(notify.answerQuestion('q-3', { id: 'close', selected: ['关掉'] }, feishuActor), undefined, 'answered already')
})

test('test notices report channels that are not ready', async () => {
  const { notify } = setup()
  notify.registerChannel(fakeChannel().channel)
  notify.registerChannel({ ...fakeChannel('error').channel, id: 'broken', name: '坏渠道', status: () => ({ id: 'broken', name: '坏渠道', state: 'error', detail: '凭证不对', recipients: 0, checks: [] }) })
  const result = await notify.test()
  assert.deepEqual(result, { sent: ['假渠道'], failed: [{ channel: '坏渠道', error: '凭证不对' }] })
})

test('a conversation that cannot go on (its folder was renamed) is replaced, with its last messages carried over', async () => {
  const prompts: string[] = []
  const conversations: Conversations = {
    create: async () => 'new-session',
    exists: async id => id !== 'old-session',
    recent: async id => (id === 'old-session' ? '用户：帮我看看活动\nagent：还有两个活动没做' : undefined),
    ask: async () => 'unused',
    converse: async (_id, text) => {
      prompts.push(text)
      return { blocks: [{ kind: 'steps', steps: [{ name: 'game_events', summary: '明日方舟', status: 'ok' }] }, { kind: 'text', text: '**两个**活动还没做' }] }
    },
  }
  const { notify, sessions } = setup(conversations)
  await sessions.set('fake:ou_1', 'old-session')
  const reply = await notify.inbound({ actor, text: '那第一个呢' })
  assert.equal(sessions.get('fake:ou_1'), 'new-session')
  assert.match(prompts[0]!, /之前最后几条消息[\s\S]*agent：还有两个活动没做[\s\S]*那第一个呢$/)
  assert.match(replyMarkdown(reply), /^（之前的对话没法继续了/)
  assert.match(replyMarkdown(reply), /\*\*执行了 1 个步骤\*\*\n- ✓ game_events：明日方舟\n\n\*\*两个\*\*活动还没做$/)
  await notify.inbound({ actor, text: '好' })
  assert.equal(prompts[1], '好', 'the new one is used as it is')
})

test('replies render the same content as markdown or plain text; long step lists keep their ends', () => {
  const steps = Array.from({ length: 9 }, (_, i) => ({ name: `tool_${i}`, summary: i === 4 ? 'x'.repeat(100) : '', status: i === 8 ? 'error' as const : 'ok' as const }))
  const reply: Reply = { blocks: [{ kind: 'text', text: '好的' }, { kind: 'steps', steps }, { kind: 'text', text: '做完了' }] }
  const md = replyMarkdown(reply)
  assert.match(md, /^好的\n\n\*\*执行了 9 个步骤（1 个失败）\*\*\n- ✓ tool_0\n- ✓ tool_1\n- ✓ tool_2\n- …另外 4 个\n- ✓ tool_7\n- ✗ tool_8\n\n做完了$/)
  assert.match(replyPlain(reply), /【执行了 9 个步骤（1 个失败）】\n· ✓ tool_0/)
  assert.equal(replyMarkdown({ blocks: [] }), '（agent 没有回复文字）')
})
