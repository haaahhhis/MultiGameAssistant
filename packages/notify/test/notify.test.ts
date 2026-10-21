import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { ApprovalRequested, ChannelStatus } from '@adg/protocol'
import { Notify, type Channel, type Conversations, type Notice } from '../src/notify.ts'

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
  assert.equal(await notify.inbound({ actor, text: '停止' }), '已停止', 'the only open notice with that button')
  assert.deepEqual(acted, ['inc-1:stop:张三'])

  await notify.send(notice('inc-2'))
  assert.equal(await notify.inbound({ actor, text: '重试！', replyTo: 'inc-1' }), '已停止', 'a reply names its notice')
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
  assert.equal(await notify.inbound({ actor, text: '停止' }), '好的，已经停了 MAA')
  assert.equal(await notify.inbound({ actor, text: '现在什么状态' }), '好的，已经停了 MAA')
  assert.equal(created, 1, 'one session per person')
  assert.deepEqual(asked, ['s-fake：张三:停止', 's-fake：张三:现在什么状态'])
  assert.equal(sessions.get('fake:ou_1'), 's-fake：张三')
  await notify.update('a', { done: '已忽略' })
  await notify.update('b', { done: '已忽略' })
  assert.equal(await notify.inbound({ actor, text: '停止' }), '好的，已经停了 MAA', 'handled notices take no replies')
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

test('test notices report channels that are not ready', async () => {
  const { notify } = setup()
  notify.registerChannel(fakeChannel().channel)
  notify.registerChannel({ ...fakeChannel('error').channel, id: 'broken', name: '坏渠道', status: () => ({ id: 'broken', name: '坏渠道', state: 'error', detail: '凭证不对', recipients: 0, checks: [] }) })
  const result = await notify.test()
  assert.deepEqual(result, { sent: ['假渠道'], failed: [{ channel: '坏渠道', error: '凭证不对' }] })
})
