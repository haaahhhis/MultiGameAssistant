import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { BY_YOU, QUIET, isQuiet, parseRelay, parseTask, parseThreadNote, relayMessage, reminderLine, reminderPrompts, taskMessage, threadMessage } from '../src/handoff-notes.ts'

test('work handed to an agent says who asked and what, and reads back the same', () => {
  const text = taskMessage('监控', 'MAA · 日常：出错', '先截图看看\n再决定', true)
  assert.match(text, /^（监控交给你的事：MAA · 日常：出错）\n（你这一轮的最后一段回复会作为结论交回去/)
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
  assert.equal(isQuiet(`${QUIET}～ ✨ (｡•̀ᴗ•́｡)`), true, 'a reply style may dress it up')
  assert.equal(isQuiet('不用告诉用户！'), true)
})

test('a reminder 助手 set, as dsh delivers it, reads as what it was for; a batch of recurring ones too', () => {
  const one = ['[SCHEDULE REMINDER]', 'This is a scheduled message from the user', 'schedule_id_json: "schedule-1"', 'occurrence_at: 2026-11-05T00:36:37Z', `reminder_prompt_json: ${JSON.stringify('提醒主人\n看活动')}`].join('\n')
  assert.deepEqual(reminderPrompts(one), ['提醒主人\n看活动'])
  assert.equal(reminderLine(reminderPrompts(one)!), '定时提醒：提醒主人 看活动')
  const batch = ['[SCHEDULE REMINDER BATCH]', 'This is a scheduled message from the user', `reminders_json: ${JSON.stringify([{ schedule_id: 'a', occurrence_at: 'x', reminder_prompt: '喝水' }, { schedule_id: 'b', occurrence_at: 'x', reminder_prompt: '看日报' }])}`].join('\n')
  assert.equal(reminderLine(reminderPrompts(batch)!), '定时提醒：喝水；看日报')
  assert.equal(reminderPrompts('你好'), undefined)
})

test('a thread says where to go on talking, and what is said in it reads back', () => {
  const task = parseTask(taskMessage('助手', '装 MAA', '把 MAA 装好', true, 'h-1'))!
  assert.deepEqual({ thread: task.thread, returns: task.returns, body: task.body }, { thread: 'h-1', returns: true, body: '把 MAA 装好' })
  assert.equal(parseTask(taskMessage('助手', '装 MAA', '把 MAA 装好'))?.thread, undefined, 'older messages have none')
  const question = threadMessage({ from: '脚本', kind: 'question', thread: 'h-1', title: '装 MAA', text: '今晚装吗？' })
  assert.deepEqual(parseThreadNote(question), { from: '脚本', kind: 'question', thread: 'h-1', title: '装 MAA', text: '今晚装吗？' })
  assert.match(question, /agent_message/)
  assert.equal(parseThreadNote(threadMessage({ from: '助手', kind: 'answer', thread: 'h-1', title: '装 MAA', text: '今晚' }))?.kind, 'answer')
  assert.equal(parseThreadNote('（「脚本」交回了你交给它的事：装 MAA）'), undefined)
  assert.equal(parseTask(question), undefined, 'not mistaken for work handed over')
  assert.equal(parseRelay(question), undefined)
})

test('what comes back to a lead working on something is for that, not for telling the person', () => {
  const toLead = relayMessage({ agent: '游戏', asker: '你', title: '哪个服', ok: true, reply: '国服', toLead: true })
  assert.match(toLead, /接着做你手上的事/)
  assert.doesNotMatch(toLead, /告诉用户/)
  assert.equal(parseRelay(toLead)?.reply, '国服')
  const toMain = relayMessage({ agent: '脚本', asker: '你', title: '装 MAA', ok: true, reply: '装好了', consulted: ['游戏'] })
  assert.match(toMain, /还问了：游戏/)
  assert.match(parseRelay(toMain)?.reply ?? '', /^装好了/)
})

test('a task can carry what the two said before, and still reads back as the task', () => {
  const message = taskMessage('助手', '装 MAA', '把 MAA 装好', true, 't1', { who: '「助手」', lines: ['- 11-9 助手交给脚本「看日志」：第 212 行（线索 t0）', '- 11-9 脚本交给助手「选服」：国服（线索 t00）'] })
  assert.match(message, /你和「助手」之前的来往/)
  assert.match(message, /第 212 行/)
  const note = parseTask(message)
  assert.equal(note?.body, '把 MAA 装好')
  assert.equal(note?.thread, 't1')
  assert.equal(note?.returns, true)
  assert.doesNotMatch(taskMessage('助手', 'x', 'y', true, 't1', { who: '「助手」', lines: [] }), /之前的来往/)
})
