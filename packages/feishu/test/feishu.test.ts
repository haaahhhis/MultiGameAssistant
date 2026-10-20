import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import type { ApprovalRequested, FeishuSettings } from '@adg/protocol'
import { startFakeFeishu } from '../../test-kit/src/fake-feishu.ts'
import { parseCardAction, parseMessage, sdkApi, type CardAction, type CardActionResponse, type ConnectionState, type FeishuApi, type InboundMessage, type Target } from '../src/api.ts'
import { DEFAULT_FEISHU, FeishuBot, type FeishuState, type NotifyPort } from '../src/bot.ts'

interface Sent { to?: Target; replyTo?: string; card?: object; text?: string; id: string }

function fakeApi(options: { tokenError?: string } = {}) {
  const sent: Sent[] = []
  const patched: { id: string; card: object }[] = []
  let handlers: { message(event: InboundMessage): void; cardAction(event: CardAction): Promise<CardActionResponse | undefined> } | undefined
  let state: ConnectionState = 'idle'
  let seq = 0
  const api: FeishuApi = {
    token: async () => { if (options.tokenError !== undefined) throw new Error(options.tokenError) },
    botInfo: async () => ({ name: 'ADG', openId: 'ou_bot' }),
    sendCard: async (to, card) => { const id = `om_${++seq}`; sent.push({ to, card, id }); return id },
    patchCard: async (id, card) => { patched.push({ id, card }) },
    sendText: async (to, text) => { const id = `om_${++seq}`; sent.push({ to, text, id }); return id },
    replyText: async (replyTo, text) => { const id = `om_${++seq}`; sent.push({ replyTo, text, id }); return id },
    uploadImage: async () => 'img_1',
    connect: async (h, onState) => { handlers = h; state = 'connected'; onState('connected') },
    connectionState: () => state,
    close: () => { state = 'idle' },
  }
  return { api, sent, patched, events: () => handlers! }
}

function setup(settings: Partial<FeishuSettings> = {}, options: { tokenError?: string | undefined; secret?: string; retryDelaysMs?: number[] } = {}) {
  const fake = fakeApi(options)
  let saved: FeishuState | undefined
  const inbound: { text: string; replyTo?: string | undefined; userId: string }[] = []
  const acted: string[] = []
  const answered: string[] = []
  const port: NotifyPort = {
    act: async (id, action, actor) => { acted.push(`${id}:${action}:${actor.userId}`); if (action === 'stop') await delay(50); return '已停止' },
    inbound: async m => { inbound.push({ text: m.text, replyTo: m.replyTo, userId: m.actor.userId }); return `收到：${m.text}` },
    respondApproval: (id, decision) => { answered.push(`${id}:${decision}`); return answered.length === 1 },
  }
  const bot = new FeishuBot({
    createApi: () => fake.api,
    secret: async () => options.secret ?? 'secret',
    load: async () => ({ settings: { ...DEFAULT_FEISHU, enabled: true, appId: 'cli_a1b2c3d4e5f60718', allowedUsers: [{ openId: 'ou_me', name: '我', addedAt: 0 }], ...settings }, pending: [] }),
    save: async state => { saved = state },
    notify: () => port,
    changed: () => {},
    log: { info() {}, warn() {} },
    ackAfterMs: 20,
    clickBudgetMs: 1000,
    retryDelaysMs: options.retryDelaysMs ?? [],
  })
  return { bot, fake, inbound, acted, answered, saved: () => saved }
}

const message = (over: Partial<InboundMessage> = {}): InboundMessage => ({
  messageId: 'om_in', chatId: 'oc_p2p', chatType: 'p2p', senderOpenId: 'ou_me', text: '现在什么状态', messageType: 'text', mentionsBot: false, ...over,
})

test('connects, passes the self-check, and sends notices as cards to every allowed person', async () => {
  const { bot, fake } = setup({ chatId: 'oc_group' })
  await bot.start()
  assert.equal(bot.status().state, 'ready')
  assert.deepEqual(bot.status().checks.map(c => [c.id, c.ok]), [['config', true], ['token', true], ['bot', true], ['ws', true], ['users', true]])
  await bot.send({ id: 'inc-1', scope: 'monitor', title: 'MAA · 日常：出错', text: '重连失败', severity: 'error', image: Buffer.from('png'), actions: [{ id: 'stop', label: '停止', style: 'danger' }] })
  assert.deepEqual(fake.sent.map(s => s.to), [{ openId: 'ou_me' }, { chatId: 'oc_group' }])
  const card = JSON.stringify(fake.sent[0]!.card)
  assert.match(card, /"img_key":"img_1"/)
  assert.match(card, /"value":\{"kind":"notice","id":"inc-1","action":"stop"\}/)
  await bot.update('inc-1', { done: '已停止（我）' })
  assert.equal(fake.patched.length, 2)
  assert.match(JSON.stringify(fake.patched[0]!.card), /已处理：已停止（我）/)
  assert.doesNotMatch(JSON.stringify(fake.patched[0]!.card), /"tag":"action"/, 'the buttons go away')
})

test('strangers are told their open_id and wait for the user to allow them', async () => {
  const { bot, fake, inbound, saved } = setup()
  await bot.start()
  fake.events().message(message({ senderOpenId: 'ou_stranger', text: '你好' }))
  await delay(20)
  assert.equal(inbound.length, 0)
  assert.match(fake.sent.at(-1)!.text!, /你的 open_id：ou_stranger/)
  assert.deepEqual(saved()?.pending.map(p => p.openId), ['ou_stranger'])
  await bot.allow('ou_stranger', '朋友')
  assert.deepEqual(bot.state.settings.allowedUsers.map(u => u.openId), ['ou_me', 'ou_stranger'])
  assert.deepEqual(bot.state.pending, [])
  assert.match(fake.sent.at(-1)!.text!, /你已被允许/)
})

test('messages from allowed people go to notify, replies to a notice card carry its id, group chats need an @', async () => {
  const { bot, fake, inbound } = setup()
  await bot.start()
  await bot.send({ id: 'inc-9', scope: 'monitor', title: 't', text: 'x', severity: 'error', actions: [{ id: 'stop', label: '停止' }] })
  const cardId = fake.sent.at(-1)!.id
  fake.events().message(message({ text: '停止', parentId: cardId }))
  fake.events().message(message({ chatType: 'group', text: '没有 @ 我' }))
  fake.events().message(message({ chatType: 'group', text: '状态', mentionsBot: true }))
  await delay(100)
  assert.deepEqual(inbound, [{ text: '停止', replyTo: 'inc-9', userId: 'ou_me' }, { text: '状态', replyTo: undefined, userId: 'ou_me' }])
  assert.deepEqual(fake.sent.filter(s => s.replyTo !== undefined).map(s => s.text), ['收到：停止', '收到：状态'])
})

test('card buttons: notice actions answer with a toast; approvals answer once', async () => {
  const { bot, fake, acted, answered } = setup()
  await bot.start()
  const click = (value: Record<string, unknown>, operator = 'ou_me') => fake.events().cardAction({ operatorOpenId: operator, value })
  assert.deepEqual(await click({ kind: 'notice', id: 'inc-1', action: 'stop' }), { toast: { type: 'success', content: '已停止' } })
  assert.deepEqual(acted, ['inc-1:stop:ou_me'])
  assert.equal((await click({ kind: 'notice', id: 'inc-1', action: 'stop' }, 'ou_other'))?.toast?.type, 'error', 'strangers cannot press buttons')

  const request: ApprovalRequested = { approvalId: 'ap-1', sessionId: 'sess', toolName: 'pwsh', reason: '安装 VC++ 运行库' }
  assert.equal(bot.approvals.active(), true)
  await bot.approvals.ask(request)
  assert.match(JSON.stringify(fake.sent.at(-1)!.card), /agent 想要执行：pwsh/)
  const first = await click({ kind: 'approval', id: 'ap-1', decision: 'allow-once' })
  assert.equal(first?.toast?.type, 'success')
  assert.match(JSON.stringify(first?.card), /已允许这一次（我）/)
  assert.equal((await click({ kind: 'approval', id: 'ap-1', decision: 'reject' }))?.toast?.content, '这个请求已经在别处回答过了')
  assert.deepEqual(answered, ['ap-1:allow-once', 'ap-1:reject'])
  await bot.approvals.resolved('ap-1', 'allowed-once')
  assert.match(JSON.stringify(fake.patched.at(-1)!.card), /已允许这一次/)
})

test('bad credentials, missing secret and a disabled channel are reported, not thrown', async () => {
  const wrong = setup({}, { tokenError: 'App Secret 不对（10014）' })
  await wrong.bot.start()
  assert.equal(wrong.bot.status().state, 'error')
  assert.match(wrong.bot.status().checks.find(c => c.id === 'token')!.detail ?? '', /App Secret 不对/)

  const noSecret = setup({}, { secret: '' })
  await noSecret.bot.start()
  assert.equal(noSecret.bot.status().state, 'off')
  assert.match(noSecret.bot.status().detail ?? '', /App Secret/)
  await assert.rejects(noSecret.bot.send({ id: 'x', scope: 's', title: 't', text: 'x', severity: 'info' }), /App Secret/)

  const off = setup({ enabled: false })
  await off.bot.start()
  assert.equal(off.bot.status().state, 'off')
  assert.equal(off.bot.approvals.active(), false)
})

test('a start that could not connect tries again by itself until it does', async () => {
  const options: { tokenError?: string | undefined; retryDelaysMs: number[] } = { tokenError: 'getaddrinfo ENOTFOUND open.feishu.cn', retryDelaysMs: [30, 60] }
  const { bot } = setup({}, options)
  await bot.start()
  assert.equal(bot.status().state, 'error', 'no network yet at logon')
  await delay(50)
  assert.equal(bot.status().state, 'error', 'still no network on the first retry')
  options.tokenError = undefined
  for (let i = 0; i < 40 && bot.status().state !== 'ready'; i++) await delay(10)
  assert.equal(bot.status().state, 'ready', 'connected on a later retry, no 重新检查 needed')
  bot.stop()
})

test('the SDK-backed API talks to the platform the way Feishu expects', async () => {
  const server = await startFakeFeishu({ appSecret: 'secret-ok' })
  try {
    const api = sdkApi({ appId: 'cli_a1b2c3d4e5f60718', appSecret: 'secret-ok', domain: server.url, log: { info() {}, warn() {} } })
    await api.token()
    assert.deepEqual(await api.botInfo(), { name: 'ADG 测试机器人', openId: 'ou_bot' })
    const id = await api.sendCard({ openId: 'ou_me' }, { header: { title: { tag: 'plain_text', content: 't' } } })
    assert.match(id, /^om_/)
    const create = server.requests.find(r => r.path === '/open-apis/im/v1/messages')!
    assert.equal(create.query['receive_id_type'], 'open_id')
    assert.equal((create.body as { msg_type: string }).msg_type, 'interactive')
    assert.equal(create.authorization, 'Bearer t-fake')
    await api.patchCard(id, { elements: [] })
    assert.ok(server.requests.some(r => r.method === 'PATCH' && r.path === `/open-apis/im/v1/messages/${id}`))
    await api.replyText(id, '好的')
    assert.match(await api.uploadImage(Buffer.from([0x89, 0x50, 0x4e, 0x47])), /^img_/)
    assert.ok(server.requests.find(r => r.path === '/open-apis/im/v1/images')?.body)

    server.deny.add('/open-apis/im/v1/messages')
    await assert.rejects(api.sendText({ chatId: 'oc_1' }, 'x'), /应用缺少权限.*发布一个新版本/)
    await assert.rejects(sdkApi({ appId: 'cli_a1b2c3d4e5f60718', appSecret: 'wrong', domain: server.url, log: { info() {}, warn() {} } }).token(), /App Secret 不对/)
  } finally {
    await server.close()
  }
})

test('events from the long connection are read into plain messages and clicks', () => {
  const event = parseMessage({
    sender: { sender_id: { open_id: 'ou_me' }, sender_type: 'user' },
    message: { message_id: 'om_1', chat_id: 'oc_1', chat_type: 'group', message_type: 'text', content: JSON.stringify({ text: '@_user_1 停止' }), parent_id: 'om_card', mentions: [{ key: '@_user_1', name: 'ADG' }] },
  })
  assert.deepEqual(event, { messageId: 'om_1', chatId: 'oc_1', chatType: 'group', senderOpenId: 'ou_me', text: '停止', messageType: 'text', parentId: 'om_card', mentionsBot: true })
  assert.equal(parseMessage({ sender: { sender_id: { open_id: 'ou_bot' }, sender_type: 'app' }, message: { message_id: 'x' } }), undefined, 'the bot\'s own messages are ignored')
  const post = parseMessage({ sender: { sender_id: { open_id: 'ou_me' } }, message: { message_id: 'om_2', message_type: 'post', content: JSON.stringify({ content: [[{ tag: 'text', text: '跑一下' }, { tag: 'text', text: '日常' }]] }) } })
  assert.equal(post?.text, '跑一下日常')
  assert.deepEqual(parseCardAction({ operator: { open_id: 'ou_me' }, action: { value: { kind: 'notice', id: 'inc-1', action: 'stop' } }, context: { open_message_id: 'om_card' } }), {
    operatorOpenId: 'ou_me', messageId: 'om_card', value: { kind: 'notice', id: 'inc-1', action: 'stop' },
  })
})

test('the real SDK over the long connection: messages in, replies out, a card click answered with a toast', async () => {
  const server = await startFakeFeishu({ appSecret: 'secret-ok' })
  const inbound: string[] = []
  const bot = new FeishuBot({
    createApi: ({ appId, appSecret }) => sdkApi({ appId, appSecret, domain: server.url, log: { info() {}, warn() {} } }),
    secret: async () => 'secret-ok',
    load: async () => ({ settings: { ...DEFAULT_FEISHU, enabled: true, appId: 'cli_a1b2c3d4e5f60718', allowedUsers: [{ openId: 'ou_me', addedAt: 0 }] }, pending: [] }),
    save: async () => {},
    notify: () => ({
      act: async (_id, action) => `已${action === 'stop' ? '停止' : '处理'}`,
      inbound: async m => { inbound.push(m.text); return `收到：${m.text}` },
      respondApproval: () => true,
    }),
    changed: () => {},
    log: { info() {}, warn() {} },
  })
  try {
    await bot.start()
    for (let i = 0; i < 50 && bot.status().state !== 'ready'; i++) await delay(100)
    assert.equal(bot.status().state, 'ready', bot.status().detail)
    assert.ok(server.connected())

    await server.sendMessage({ openId: 'ou_me', text: '现在什么状态' })
    const reply = await server.waitForMessage(m => m.kind === 'reply' && m.text === '收到：现在什么状态')
    assert.match(reply.parentId ?? '', /^om_user_/)
    assert.deepEqual(inbound, ['现在什么状态'])

    await bot.send({ id: 'inc-1', scope: 'monitor', title: 'MAA · 日常：出错', text: '重连失败', severity: 'error', actions: [{ id: 'stop', label: '停止', style: 'danger' }] })
    const card = await server.waitForMessage(m => m.kind === 'create' && m.msgType === 'interactive')
    assert.equal(card.to, 'ou_me')
    assert.match(card.text, /MAA · 日常：出错/)
    assert.deepEqual(await server.clickCard({ openId: 'ou_me', value: { kind: 'notice', id: 'inc-1', action: 'stop' }, messageId: card.id }), { toast: { type: 'success', content: '已停止' } })
    assert.equal((await server.clickCard({ openId: 'ou_stranger', value: { kind: 'notice', id: 'inc-1', action: 'stop' } }) as { toast: { type: string } }).toast.type, 'error')
  } finally {
    bot.stop()
    await server.close()
  }
})
