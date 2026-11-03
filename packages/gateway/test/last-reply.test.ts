import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { LastReplies, lastReply, plain } from '../src/last-reply.ts'

const said = (text: string) => ({ type: 'assistant/message', content: [{ type: 'text', text }] })

test("a session's last reply is its last agent message that says something", () => {
  assert.equal(lastReply([said('先截个图'), { type: 'tool/call' }, said('已经恢复，脚本继续运行。'), { type: 'turn/end' }]), '已经恢复，脚本继续运行。')
  assert.equal(lastReply([said('看完了'), said('  ')]), '看完了', 'a message with only tool calls says nothing')
  assert.equal(lastReply([{ type: 'user/message', content: [{ type: 'text', text: '你好' }] }]), null, 'the person speaking is not a reply')
  assert.equal(lastReply([]), null)
})

test('a reply is shown as plain words on one line, shortened', () => {
  assert.equal(plain('## 结论\n\n**MAA 版本太旧**，见 [日志](C:/x/gui.log)：\n- 更新到 v6.21\n- 然后重跑'), '结论 MAA 版本太旧，见 日志： 更新到 v6.21 然后重跑')
  assert.equal(plain('| 时间 | 事件 |\n|---|---|\n| 09:33 | 启动 |'), '时间 事件 09:33 启动')
  assert.equal(plain('看这里 ![截图](a.png)\n```\ncode\n```\n完'), '看这里 完')
  const long = plain('啊'.repeat(400))
  assert.equal(long.length, 281)
  assert.ok(long.endsWith('…'))
})

test("a running session's reply is read each time; a finished one is kept until it changes", async () => {
  let reply: string | null = null
  let reads = 0
  // A session whose snapshot ends in `reply`, as dsh's follow gives it.
  const sessions = {
    follow: () => ({
      async *[Symbol.asyncIterator]() {
        reads++
        yield { type: 'snapshot', records: reply === null ? [] : [{ type: 'event', event: { type: 'assistant/message', seq: 1, time: 1, data: { turn: 1, step: 1, message: { role: 'assistant', content: [{ type: 'text', text: reply }] } } } }] }
      },
    }),
  }
  const replies = new LastReplies(sessions as never)
  const signal = new AbortController().signal
  assert.equal(await replies.of('s1', 100, signal, true), null, 'still working: nothing said yet')
  reply = '装好了'
  assert.equal(await replies.of('s1', 100, signal, false), '装好了', 'the reply landed without updatedAt moving')
  const before = reads
  assert.equal(await replies.of('s1', 100, signal, false), '装好了')
  assert.equal(reads, before, 'kept')
})
