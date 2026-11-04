import { strict as assert } from 'node:assert'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import type { AgentTask } from '@adg/protocol'
import { AgentTasks, taskTools } from '../src/index.ts'

const SCHEDULE = { enabled: true, times: ['09:00'], days: [], catchUpMinutes: 10 }
const quiet = { warn: () => {} }

async function folder(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'adg-tasks-'))
}

test('a timed task is handed to its agent; the run ends with what it said, and is kept', async t => {
  const dir = await folder()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const handed: AgentTask[] = []
  let answer!: (text: string) => void
  const tasks = new AgentTasks({
    file: join(dir, '_tasks.json'),
    hand: task => { handed.push(task); return new Promise(resolve => { answer = resolve }) },
    changed: () => {},
    log: quiet,
  })
  const task = await tasks.save({ agent: 'games', title: '看活动', prompt: '看看今天结束的活动', schedule: SCHEDULE })
  assert.match(task.id, /^task-/)
  const run = tasks.run(task.id, { kind: 'schedule' })
  assert.equal(run.state, 'running')
  assert.equal(tasks.isRunning(task.id), true)
  assert.throws(() => tasks.run(task.id, { kind: 'manual' }), /还没做完/, 'one at a time')
  answer('没有今天结束的活动')
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(tasks.list('games')[0]?.lastRun?.state, 'done')
  assert.equal(tasks.list('games')[0]?.lastRun?.outcome, '没有今天结束的活动')
  assert.equal(tasks.list('main').length, 0, 'listed by agent')
  assert.ok(tasks.lastSuccessDay(task.id) !== undefined)
  assert.equal(handed[0]?.prompt, '看看今天结束的活动')
})

test('a run still going when the app stopped reads back as not finished', async t => {
  const dir = await folder()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const file = join(dir, '_tasks.json')
  await writeFile(file, JSON.stringify({
    tasks: [{ id: 'task-abcd1234', agent: 'main', title: 'x', prompt: 'y', schedule: SCHEDULE }],
    runs: [{ id: 'r1', taskId: 'task-abcd1234', trigger: { kind: 'schedule' }, state: 'running', startedAt: 1 }],
  }))
  const tasks = new AgentTasks({ file, hand: async () => '', changed: () => {}, log: quiet })
  await tasks.load()
  assert.equal(tasks.list()[0]?.lastRun?.state, 'failed')
  assert.equal(tasks.isRunning('task-abcd1234'), false)
  await tasks.remove('task-abcd1234')
  assert.deepEqual(JSON.parse(await readFile(file, 'utf8')), { tasks: [], runs: [] })
})

test('the agent sets a timed task by the agent\'s name, and is told the names it can use', async t => {
  const dir = await folder()
  t.after(() => rm(dir, { recursive: true, force: true }))
  const tasks = new AgentTasks({ file: join(dir, '_tasks.json'), hand: async () => '', changed: () => {}, log: quiet })
  const save = taskTools(tasks, () => [{ id: 'games', name: '游戏' }]).find(tool => tool.name === 'schedule_task_save')!
  const exec = { signal: new AbortController().signal } as Parameters<typeof save.execute>[1]
  const result = await save.execute({ agent: '游戏', title: '看活动', prompt: '看看', times: ['09:00'] }, exec) as { task: AgentTask; link: string }
  assert.equal(result.task.agent, 'games')
  assert.equal(result.link, '#/a/games/schedule')
  await assert.rejects(Promise.resolve(save.execute({ agent: '天气', title: 'x', prompt: 'y', times: ['09:00'] }, exec)), /助手、游戏/)
})
