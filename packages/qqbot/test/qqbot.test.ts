import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { Requests, type QQSettings } from '@adg/protocol'
import { textReply } from '@adg/notify'
import { startFakeQQ } from '../../test-kit/src/fake-qqbot.ts'
import { httpApi } from '../src/api.ts'
import { DEFAULT_QQ, noticeText, plainText, QQBot, type NotifyPort, type QQState } from '../src/bot.ts'

const APP_ID = '102000001'
const log = { info() {}, warn() {} }

async function setup(settings: Partial<QQSettings> = {}, options: { secret?: string; notify?: NotifyPort } = {}) {
  const fake = await startFakeQQ({ appId: APP_ID, secret: 'secret-ok' })
  let saved: QQState | undefined
  const inbound: { text: string; userId: string; name: string | undefined }[] = []
  const bot = new QQBot({
    createApi: ({ appId, secret }) => httpApi({ appId, secret, base: fake.base, log }),
    secret: async () => options.secret ?? 'secret-ok',
    load: async () => ({ settings: { ...DEFAULT_QQ, enabled: true, appId: APP_ID, allowedUsers: [{ openId: 'AAAA1111BBBB2222', name: '我', addedAt: 0 }], ...settings }, pending: [] }),
    save: async state => { saved = state },
    notify: () => options.notify ?? ({ inbound: async m => { inbound.push({ text: m.text, userId: m.actor.userId, name: m.actor.name }); return textReply(`**收到**：${m.text}`) } }),
    changed: () => {},
    log,
    retryDelaysMs: [],
  })
  return { fake, bot, inbound, saved: () => saved }
}

async function until(what: string, ok: () => boolean, timeoutMs = 5000): Promise<void> {
  const end = Date.now() + timeoutMs
  while (!ok()) {
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`)
    await delay(20)
  }
}

test('connects over the gateway with direct-message intents and passes the self-check', async () => {
  const { fake, bot } = await setup()
  try {
    await bot.start()
    await until('ready', () => bot.status().state === 'ready')
    assert.deepEqual(fake.identified, [{ intents: 1 << 25 }])
    assert.deepEqual(bot.status().checks.map(c => [c.id, c.ok]), [['config', true], ['token', true], ['ws', true], ['users', true]])
  } finally {
    bot.stop()
    await fake.close()
  }
})

test('an allowed person\'s message goes to 助手 once (QQ may send it twice); the answer is a reply to it, in markdown', async () => {
  const { fake, bot, inbound } = await setup()
  try {
    await bot.start()
    await until('ready', () => bot.status().state === 'ready')
    const id = fake.sendMessage({ openId: 'AAAA1111BBBB2222', text: '现在什么状态', repeat: true })
    const answer = await fake.waitForMessage(m => m.text.startsWith('**收到**'))
    assert.deepEqual(answer, { openId: 'AAAA1111BBBB2222', text: '**收到**：现在什么状态', markdown: true, msgId: id, seq: 1 })
    assert.deepEqual(inbound, [{ text: '现在什么状态', userId: 'AAAA1111BBBB2222', name: '我' }])
  } finally {
    bot.stop()
    await fake.close()
  }
})

test('strangers are told their user_openid and wait to be allowed; allowing them says hello', async () => {
  const { fake, bot, inbound, saved } = await setup()
  try {
    await bot.start()
    await until('ready', () => bot.status().state === 'ready')
    fake.sendMessage({ openId: 'CCCC3333DDDD4444', text: '你好' })
    await fake.waitForMessage(m => m.text.includes('user_openid：CCCC3333DDDD4444'))
    await until('pending', () => bot.state.pending.length === 1)
    assert.equal(inbound.length, 0)
    await bot.allow('CCCC3333DDDD4444', '朋友')
    assert.deepEqual(saved()?.settings.allowedUsers.map(u => u.openId), ['AAAA1111BBBB2222', 'CCCC3333DDDD4444'])
    assert.deepEqual(saved()?.pending, [])
    await fake.waitForMessage(m => m.openId === 'CCCC3333DDDD4444' && m.text.includes('你已被允许'))
  } finally {
    bot.stop()
    await fake.close()
  }
})

test("notices and 助手's conversation go to each allowed person in markdown, a notice's actions as buttons, not back to whoever it came from", async () => {
  const { fake, bot } = await setup({ allowedUsers: [{ openId: 'AAAA1111BBBB2222', addedAt: 0 }, { openId: 'EEEE5555FFFF6666', addedAt: 0 }] })
  try {
    await bot.start()
    await until('ready', () => bot.status().state === 'ready')
    await bot.send({ id: 'inc-1', scope: 'monitor', title: 'MAA · 日常：出错', text: '重连失败', severity: 'error', actions: [{ id: 'stop', label: '停止' }, { id: 'retry', label: '重试' }] })
    await bot.mirror({ text: '**跑完了**', markdown: true }, 'AAAA1111BBBB2222')
    const buttons = [[{ label: '停止', data: '停止' }, { label: '重试', data: '重试' }]]
    assert.deepEqual(fake.sent.map(m => [m.openId, m.text, m.markdown, m.buttons]), [
      ['AAAA1111BBBB2222', '**MAA · 日常：出错**\n重连失败', true, buttons],
      ['EEEE5555FFFF6666', '**MAA · 日常：出错**\n重连失败', true, buttons],
      ['EEEE5555FFFF6666', '**跑完了**', true, undefined],
    ])
  } finally {
    bot.stop()
    await fake.close()
  }
})

test('after the gateway drops the connection, it resumes the session', async () => {
  const { fake, bot } = await setup()
  try {
    await bot.start()
    await until('ready', () => bot.status().state === 'ready')
    fake.drop(4009)
    await until('resumed', () => fake.resumed.length === 1, 8000)
    assert.deepEqual(fake.resumed, ['sess-1'])
    await until('ready again', () => bot.status().state === 'ready')
  } finally {
    bot.stop()
    await fake.close()
  }
})

test('buttons or markdown QQ refuses are dropped — the text then says what to reply — and not tried again', async () => {
  const { fake, bot } = await setup()
  try {
    await bot.start()
    await until('ready', () => bot.status().state === 'ready')
    fake.refuse.keyboard = true
    const notice = { id: 'inc-1', scope: 'monitor', title: '出错', text: '重连失败', severity: 'error' as const, actions: [{ id: 'stop', label: '停止' }, { id: 'retry', label: '重试' }] }
    await bot.send(notice)
    await bot.send({ ...notice, id: 'inc-2' })
    assert.deepEqual(fake.sent.map(m => [m.text, m.markdown, m.buttons]), [
      ['**出错**\n重连失败\n\n回复「停止」「重试」', true, undefined],
      ['**出错**\n重连失败\n\n回复「停止」「重试」', true, undefined],
    ])
    fake.refuse.markdown = true
    await bot.mirror({ text: '**跑完了**', markdown: true }, undefined)
    await bot.send({ ...notice, id: 'inc-3' })
    assert.deepEqual(fake.sent.slice(2).map(m => [m.text, m.markdown]), [['跑完了', undefined], ['【出错】\n重连失败\n回复「停止」「重试」', undefined]])
  } finally {
    bot.stop()
    await fake.close()
  }
})

test('a wrong AppSecret is reported, not thrown', async () => {
  const { fake, bot } = await setup({}, { secret: 'wrong' })
  try {
    await bot.start()
    assert.equal(bot.status().state, 'error')
    assert.match(bot.status().detail ?? '', /AppID 或 AppSecret 不对（100016）/)
  } finally {
    bot.stop()
    await fake.close()
  }
})

test('text for QQ: notices list what to reply; markdown loses its marks but keeps link addresses', () => {
  assert.equal(noticeText({ id: 'n', scope: 's', title: '日报', text: '没有新活动', severity: 'info', image: Buffer.from('x') }), '【日报】\n没有新活动\n（截图在软件里）')
  assert.equal(plainText('## 结论\n**MAA** 已更新，见 [日志](https://x.y/log) 和 [编排页](#/p/pipelines)，`v5.1`'), '结论\nMAA 已更新，见 日志（https://x.y/log） 和 编排页，v5.1')
})

test('the settings take a numeric AppID and a user_openid as QQ gives them', () => {
  assert.equal(Requests['qqbot/settings/set'].params.parse({ appId: ' 102000001 ' }).appId, '102000001')
  assert.throws(() => Requests['qqbot/settings/set'].params.parse({ appId: 'cli_abc' }), /AppID 是一串数字/)
  assert.equal(Requests['qqbot/users/allow'].params.parse({ openId: 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4' }).openId, 'A1B2C3D4E5F6A1B2C3D4E5F6A1B2C3D4')
})

test("助手's question reaches the person whose conversation asks, as text; their answer goes past the message waiting for it", async () => {
  let waiting = false
  let answered: (() => void) | undefined
  let bot!: QQBot
  const notify: NotifyPort = {
    inbound: async m => {
      if (m.text === '2') { waiting = false; answered?.(); return textReply('收到，已经告诉 agent：明天') }
      waiting = true
      await bot.questions.ask({ questionId: 'q1', sessionId: 's-main', questions: [{ id: 'when', question: '什么时候提醒？', options: [{ label: '今天' }, { label: '明天' }] }] } as never, m.actor.userId)
      await new Promise<void>(resolve => { answered = resolve })
      return textReply('好的，明天提醒你')
    },
    waiting: () => waiting,
  }
  const ready = await setup({}, { notify })
  bot = ready.bot
  const { fake } = ready
  try {
    await bot.start()
    await until('ready', () => bot.status().state === 'ready')
    assert.equal(bot.questions.active('AAAA1111BBBB2222'), true)
    assert.equal(bot.questions.active(undefined), false, "other sessions' questions stay in the app")
    fake.sendMessage({ openId: 'AAAA1111BBBB2222', text: '提醒我换赤金' })
    const asked = await fake.waitForMessage(m => m.text.startsWith('**助手问你**'))
    assert.match(asked.text, /什么时候提醒？\n1\. 今天\n2\. 明天\n回复选项的数字/)
    assert.deepEqual(asked.buttons, [[{ label: '1. 今天', data: '1' }, { label: '2. 明天', data: '2' }]], 'a button sends its number, answered like a typed one')
    fake.sendMessage({ openId: 'AAAA1111BBBB2222', text: '2' })
    await fake.waitForMessage(m => m.text === '收到，已经告诉 agent：明天')
    await fake.waitForMessage(m => m.text === '好的，明天提醒你')
  } finally {
    bot.stop()
    await fake.close()
  }
})
