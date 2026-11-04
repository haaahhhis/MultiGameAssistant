import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { BY_YOU, QUIET, isQuiet, parseRelay, parseTask, relayMessage, taskMessage } from '../src/handoff-notes.ts'

test('work handed to an agent says who asked and what, and reads back the same', () => {
  const text = taskMessage('监控', 'MAA · 日常：出错', '先截图看看\n再决定', true)
  assert.match(text, /^（监控交给你的事：MAA · 日常：出错）\n（做完后你这一轮的最后一段回复会原样交回去/)
  assert.deepEqual(parseTask(text), { by: '监控', title: 'MAA · 日常：出错', returns: true, body: '先截图看看\n再决定' })
  assert.deepEqual(parseTask(taskMessage(BY_YOU, '安装脚本：MAA', '装好它')), { by: BY_YOU, title: '安装脚本：MAA', returns: false, body: '装好它' })
  assert.equal(parseTask('帮我看看（监控交给你的事：x）'), undefined, "the person's own words are theirs")
})

test('a title is kept to one line, its brackets made plain, so the note stays one line', () => {
  const note = parseTask(taskMessage('助手', '读（国服）\n活动', 'x'))
  assert.equal(note?.title, '读(国服) 活动')
})

test('a reply sent back says who did it, for whom, how it went, and reads back without the closing advice', () => {
  const ok = relayMessage({ agent: '游戏', asker: '你', title: '读活动', ok: true, reply: '今天没有结束的活动\n\n（截图见上）' })
  assert.match(ok, /^（「游戏」交回了你交给它的事：读活动）\n\n今天没有结束的活动/)
  assert.deepEqual(parseRelay(ok), { agent: '游戏', asker: '你', title: '读活动', ok: true, reply: '今天没有结束的活动\n\n（截图见上）' })
  const failed = relayMessage({ agent: '干预', asker: '监控', title: 'MAA 出错', ok: false, reply: '用户接管' })
  assert.deepEqual(parseRelay(failed), { agent: '干预', asker: '监控', title: 'MAA 出错', ok: false, reply: '用户接管' })
  assert.equal(parseRelay('（「游戏」说了点别的）'), undefined)
})

test('助手 may leave the person out of a reply that came back by answering only QUIET', () => {
  assert.match(relayMessage({ agent: '游戏', asker: '你', title: 'x', ok: true, reply: 'y' }), new RegExp(QUIET))
  assert.equal(isQuiet(`${QUIET}。`), true)
  assert.equal(isQuiet(`${QUIET}，不过活动快结束了`), false)
})
