import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { ApprovalRequested } from '@adg/protocol'
import { ApprovalBroker } from '../src/approvals.ts'

test('answerers get questions while active, and every answerer hears how each one ended', async () => {
  const broadcast: string[] = []
  const broker = new ApprovalBroker({ broadcastRequested: r => broadcast.push(`asked:${r.toolName}`), broadcastResolved: (_id, outcome) => broadcast.push(`resolved:${outcome}`) })
  const asked: ApprovalRequested[] = []
  const resolved: string[] = []
  let active = true
  broker.addAnswerer({ active: () => active, asked: r => asked.push(r), resolved: (id, outcome) => resolved.push(`${id}:${outcome}`) })
  assert.equal(broker.hasActiveAnswerer(), true)

  const answer = broker.ask({ sessionId: 's', toolName: 'pwsh', reason: '安装依赖' })
  assert.equal(asked.length, 1)
  assert.equal(broker.respond(asked[0]!.approvalId, 'allow-once'), true, 'a card answers like a UI client')
  assert.equal(await answer, 'allowed-once')
  assert.equal(broker.respond(asked[0]!.approvalId, 'reject'), false, 'first answer wins')
  assert.deepEqual(resolved, [`${asked[0]!.approvalId}:allowed-once`])
  assert.deepEqual(broadcast, ['asked:pwsh', 'resolved:allowed-once'])

  active = false
  assert.equal(broker.hasActiveAnswerer(), false)
  const withdrawn = new AbortController()
  const second = broker.ask({ sessionId: 's', toolName: 'write', signal: withdrawn.signal })
  assert.equal(asked.length, 1, 'an inactive answerer is not asked')
  withdrawn.abort()
  assert.equal(await second, 'cancelled')
  assert.equal(resolved.length, 2, 'but still hears that it ended')
})
