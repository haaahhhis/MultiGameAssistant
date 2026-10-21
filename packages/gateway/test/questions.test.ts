import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { QuestionRequested } from '@adg/protocol'
import { QuestionBroker, QuestionClosed } from '../src/questions.ts'

test('questions reach clients and answerers; the first answer wins and covers every question', async () => {
  const broadcast: string[] = []
  const broker = new QuestionBroker({
    broadcastRequested: r => broadcast.push(`asked:${r.questions.length}`),
    broadcastResolved: (_id, outcome, answers) => broadcast.push(`resolved:${outcome}:${JSON.stringify(answers ?? null)}`),
  })
  const asked: QuestionRequested[] = []
  const resolved: string[] = []
  let active = true
  broker.addAnswerer({ active: () => active, asked: r => asked.push(r), resolved: (id, outcome) => resolved.push(`${id}:${outcome}`) })
  assert.equal(broker.hasActiveAnswerer('s'), true)

  const answer = broker.ask({
    sessionId: 's', callId: 'call-1',
    questions: [
      { id: 'close', question: '要不要把游戏关掉？', options: [{ label: '关掉游戏 (Recommended)' }, { label: '先开着' }] },
      { id: 'note', question: '还有别的吗？' },
    ],
  })
  assert.equal(asked.length, 1)
  assert.equal(asked[0]!.callId, 'call-1')
  assert.equal(broker.open().length, 1, 'replayed to clients that connect later')
  assert.equal(broker.respond(asked[0]!.questionId, [{ id: 'close', selected: ['关掉游戏 (Recommended)'] }, { id: 'other', selected: ['x'] }]), true)
  assert.deepEqual(await answer, { answers: [{ id: 'close', selected: ['关掉游戏 (Recommended)'] }, { id: 'note', selected: [] }] }, 'unknown ids dropped, missing ones skipped')
  assert.equal(broker.respond(asked[0]!.questionId, []), false, 'first answer wins')
  assert.deepEqual(resolved, [`${asked[0]!.questionId}:answered`])
  assert.equal(broker.open().length, 0)

  active = false
  const withdrawn = new AbortController()
  const second = broker.ask({ sessionId: 's', questions: [{ id: 'q', question: '?' }], signal: withdrawn.signal })
  assert.equal(asked.length, 1, 'an inactive answerer is not asked')
  withdrawn.abort()
  await assert.rejects(second, (error: unknown) => error instanceof QuestionClosed && error.outcome === 'cancelled')

  const third = broker.ask({ sessionId: 's', questions: [{ id: 'q', question: '?', options: [{ label: '好' }] }] })
  broker.dispose()
  await assert.rejects(third, (error: unknown) => error instanceof QuestionClosed && error.outcome === 'unavailable')
  assert.deepEqual(broadcast.filter(b => b.startsWith('resolved:')).map(b => b.split(':')[1]), ['answered', 'cancelled', 'unavailable'])
})

test('typed text is kept and trimmed; blank text counts as no text', async () => {
  const broker = new QuestionBroker({ broadcastRequested: () => {}, broadcastResolved: () => {} })
  let id = ''
  broker.addAnswerer({ active: () => true, asked: r => { id = r.questionId }, resolved: () => {} })
  const answer = broker.ask({ sessionId: 's', questions: [{ id: 'a', question: '怎么称呼你？' }, { id: 'b', question: '?' }] })
  broker.respond(id, [{ id: 'a', selected: [], custom: '  小明 ' }, { id: 'b', selected: [], custom: '   ' }])
  assert.deepEqual(await answer, { answers: [{ id: 'a', selected: [], custom: '小明' }, { id: 'b', selected: [] }] })
})
