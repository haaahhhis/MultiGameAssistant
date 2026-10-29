import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { compactOutcome } from '../src/compact.ts'

test('dsh-command-compact results read in Chinese', () => {
  assert.deepEqual(compactOutcome({ kind: 'success', text: 'Compacted 42 history items (~18500 tokens).' }), { compacted: true, message: '已压缩：42 条较早的记录（约 18,500 tokens）换成了一份摘要。' })
  assert.deepEqual(compactOutcome({ kind: 'success', text: 'No compactable history yet.' }), { compacted: false, message: '对话还很短，没有可以压缩的内容。' })
  assert.throws(() => compactOutcome({ kind: 'error', text: 'Compaction is unavailable because this process has an active compaction, or the agent is not idle.' }), /等它停下再试/)
  assert.throws(() => compactOutcome({ kind: 'error', text: 'Compaction could not produce a useful summary. The attempt is recorded in the session log.' }), /对话没有改动/)
  assert.throws(() => compactOutcome({ kind: 'error', text: 'Something new' }), /压缩没有完成：Something new/)
})
