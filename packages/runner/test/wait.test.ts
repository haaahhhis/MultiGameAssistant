import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import type { ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { RunInfo } from '@adg/protocol'
import type { Runner } from '../src/runs.ts'
import { MAX_WAIT_SECONDS, runnerTools, TOOL_NAMES, waitForRun, type RunWaiter } from '../src/tools.ts'

/** Runs that end, are held or replaced when the test says so. */
function fakeRuns() {
  const runs = new Map<string, { info: RunInfo; end: () => void; finished: Promise<RunInfo>; next?: Promise<RunInfo | undefined>; held: boolean }>()
  const add = (id: string, ended = false) => {
    let end!: () => void
    const info = { id, scriptId: 'tool', taskId: 'daily', state: ended ? 'failed' : 'running', startedAt: 0, ...(ended ? { endedAt: 1 } : {}) } as unknown as RunInfo
    const finished = new Promise<RunInfo>(resolve => { end = () => { (info as { endedAt?: number }).endedAt = 2; (info as { state: string }).state = 'succeeded'; resolve(info) } })
    if (ended) end()
    runs.set(id, { info, end, finished, held: false })
    return runs.get(id)!
  }
  const waiter: RunWaiter = {
    get: id => runs.get(id)!.info,
    finished: async id => runs.get(id)!.finished,
    successor: async id => runs.get(id)!.next,
    held: id => runs.get(id)!.held,
  }
  return { add, runs, waiter }
}

test('a run that is over already: no wait', async () => {
  const { add, waiter } = fakeRuns()
  add('r1', true)
  const waited = await waitForRun(waiter, 'r1', 1000)
  assert.deepEqual({ ...waited, ms: 0 }, { runId: 'r1', followed: [], timedOut: false, paused: false, ms: 0 })
})

test('a running run is waited for until it ends', async () => {
  const { add, waiter } = fakeRuns()
  const r1 = add('r1')
  setTimeout(r1.end, 30)
  const waited = await waitForRun(waiter, 'r1', 5000)
  assert.equal(waited.runId, 'r1')
  assert.equal(waited.timedOut, false)
  assert.ok(waited.ms >= 20)
})

test('a run that was run again is followed to the last one, also through a rerun that had failed already (as on 11-16)', async () => {
  const { add, waiter } = fakeRuns()
  const r1 = add('r1', true)
  const r2 = add('r2', true)
  const r3 = add('r3')
  r1.next = Promise.resolve(r2.info)
  r2.next = Promise.resolve(r3.info)
  setTimeout(r3.end, 20)
  const waited = await waitForRun(waiter, 'r1', 5000)
  assert.equal(waited.runId, 'r3')
  assert.deepEqual(waited.followed, ['r2', 'r3'])
  assert.equal(waited.timedOut, false)
})

test('a run paused while its problem is handled is answered at once: it would not end while the asker handles it', async () => {
  const { add, waiter } = fakeRuns()
  add('r1').held = true
  const waited = await waitForRun(waiter, 'r1', 60_000)
  assert.equal(waited.paused, true)
  assert.equal(waited.timedOut, false)
  assert.ok(waited.ms < 1000)
})

test('the wait stops when the time is up or the call is cancelled, also while someone still decides whether it runs again', async () => {
  const { add, waiter } = fakeRuns()
  add('r1')
  const late = await waitForRun(waiter, 'r1', 40)
  assert.equal(late.timedOut, true)
  assert.equal(late.runId, 'r1')
  const r2 = add('r2', true)
  r2.next = new Promise(() => {})
  assert.equal((await waitForRun(waiter, 'r2', 40)).timedOut, true, 'ended, but a hold is not released')
  const abort = new AbortController()
  setTimeout(() => abort.abort(), 20)
  const started = Date.now()
  assert.equal((await waitForRun(waiter, 'r1', 60_000, abort.signal)).timedOut, true)
  assert.ok(Date.now() - started < 1000, 'cancelled, not left waiting')
})

test('script_runs waits with run_id and wait_seconds, says what it waited for, and its time limit covers the longest wait', async () => {
  const { add, waiter } = fakeRuns()
  const r1 = add('r1', true)
  const r2 = add('r2')
  r1.next = Promise.resolve(r2.info)
  setTimeout(r2.end, 20)
  const runner = { ...waiter, logs: () => [{ source: 'stdout', text: '完成' }], list: () => [] } as unknown as Runner
  const runs = runnerTools(runner, { library: { get: () => { throw new Error('unused') }, packOf: () => undefined } as never, dataDir: '' }).find(t => t.name === TOOL_NAMES.runs)!
  assert.ok(runs.timeoutMs! > MAX_WAIT_SECONDS * 1000)
  const exec = { signal: new AbortController().signal } as ToolRunContext
  const result = await runs.execute({ run_id: 'r1', wait_seconds: 10 }, exec) as { run_id: string; state: string; last_lines: string[]; waited: { restarted_as: string[]; timed_out: boolean; note: string } }
  assert.equal(result.run_id, 'r2')
  assert.equal(result.state, 'succeeded')
  assert.deepEqual(result.waited.restarted_as, ['r2'])
  assert.equal(result.waited.timed_out, false)
  assert.match(result.waited.note, /重新运行过 1 次/)
  await assert.rejects(Promise.resolve(runs.execute({ wait_seconds: 10 }, exec)), /要和 run_id 一起用/)
  const plain = await runs.execute({ run_id: 'r1' }, exec) as Record<string, unknown>
  assert.equal(plain['waited'], undefined, 'without wait_seconds it answers at once, as before')
})
