import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { setTimeout as delay } from 'node:timers/promises'
import { WinHelper } from '../src/winhelper.ts'

// Compiles and runs the real helper. Clicking and capturing need an interactive
// desktop, so they are checked on a real machine (docs/testing/M5.md).
test('the Windows helper compiles, answers, keeps Unicode, lists windows, and suspends and resumes a process tree', { skip: process.platform !== 'win32', timeout: 120_000 }, async () => {
  const helper = new WinHelper()
  try {
    assert.equal(await helper.call('ping'), 'pong')
    assert.equal(await helper.call('echo', { text: '任务出错：更新弹窗 ✓' }), '任务出错：更新弹窗 ✓')
    assert.ok(Array.isArray(await helper.windows()))
    await assert.rejects(helper.call('keys', { keys: 'ctrl+nope' }), /不认识的按键：nope/)

    // A child that prints a tick every 50 ms stops ticking while suspended.
    const child = spawn(process.execPath, ['-e', 'setInterval(() => process.stdout.write("."), 50)'], { stdio: ['ignore', 'pipe', 'ignore'] })
    let ticks = 0
    child.stdout.on('data', chunk => { ticks += String(chunk).length })
    await delay(600)
    assert.ok(ticks > 0)
    assert.ok((await helper.call<number>('suspend', { pid: child.pid, resume: false })) >= 1)
    await delay(300)
    const frozen = ticks
    await delay(700)
    assert.ok(ticks - frozen <= 1, `ticked ${ticks - frozen} times while suspended`)
    await helper.call('suspend', { pid: child.pid, resume: true })
    await delay(600)
    assert.ok(ticks > frozen + 3, 'ticks again after resume')
    child.kill()
  } finally {
    helper.dispose()
  }
})
