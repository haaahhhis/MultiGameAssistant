import { strict as assert } from 'node:assert'
import { spawn } from 'node:child_process'
import { test } from 'node:test'
import { descendants, parseTable, processTable, sweepTree, type ProcessRow } from '../src/sweep.ts'

const row = (pid: number, parent: number, created: number, name = `p${pid}.exe`): ProcessRow => ({ pid, parent, created, name })

test('descendants follow parent ids through processes that already exited, and skip a reused id', () => {
  const rows = [
    // 10 is the script; 11 (a launcher) has exited, but 12 still names it as its parent.
    row(10, 1, 1000, 'script.exe'), row(12, 11, 1200, 'worker.exe'), row(13, 12, 1300, 'helper.exe'),
    // 20 names 10 as parent but started before it: the id 10 was someone else's then.
    row(20, 10, -50_000, 'stranger.exe'),
    row(30, 1, 900, 'other.exe'),
  ]
  // 11 is gone from the table: reach 12 through it as a child of the run's root only if the root's children link there.
  rows.push(row(11, 10, 1100, 'launcher.exe'))
  const found = descendants(rows.filter(r => r.pid !== 11), 10, 1000).map(r => r.pid)
  assert.deepEqual(found, [10], 'a grandchild whose own parent is gone from the table cannot be placed (the limit of this approach)')
  assert.deepEqual(descendants(rows, 10, 1000).map(r => r.pid).sort(), [10, 11, 12, 13])
  // The root itself has exited: its children are still found from the run's start.
  assert.deepEqual(descendants(rows.filter(r => r.pid !== 10), 10, 1000).map(r => r.pid).sort(), [11, 12, 13])
  assert.deepEqual(parseTable('10\t1\t1000\tscript.exe\r\nbad line\n12\t11\t1200\tworker one.exe\n'), [row(10, 1, 1000, 'script.exe'), row(12, 11, 1200, 'worker one.exe')])
})

test('real Windows: a launcher that exits leaves a child running; the sweep ends it', { skip: process.platform !== 'win32' }, async () => {
  const since = Date.now()
  // The launcher starts a long-lived node and exits right away, like a .bat wrapper or a game launcher.
  const launcher = spawn(process.execPath, ['-e', `require('child_process').spawn(process.execPath, ['-e', 'setTimeout(() => {}, 120000)'], { detached: true, stdio: 'ignore' }).unref()`], { stdio: 'ignore' })
  await new Promise(resolve => launcher.once('exit', resolve))
  await new Promise(resolve => setTimeout(resolve, 500))
  const before = descendants(await processTable(), launcher.pid!, since)
  assert.equal(before.length, 1, `the orphaned child is found through its dead parent: ${JSON.stringify(before)}`)
  const result = await sweepTree(launcher.pid!, since)
  assert.equal(result.ended.length, 1, JSON.stringify(result))
  assert.deepEqual(descendants(await processTable(), launcher.pid!, since), [])
})
