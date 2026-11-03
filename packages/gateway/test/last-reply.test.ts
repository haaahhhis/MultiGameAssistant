import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { lastReply, plain } from '../src/last-reply.ts'

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
