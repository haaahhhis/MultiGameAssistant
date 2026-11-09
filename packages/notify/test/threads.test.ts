import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseRelay, parseTask, parseThreadNote, type HandOff } from '@adg/protocol'
import { createHandOffDesk, MAX_CHAIN_MESSAGES, MAX_THREAD_MESSAGES, type HandOffDesk } from '../src/handoff.ts'
import type { HandOffInput } from '../src/notify.ts'
import type { Reply } from '../src/reply.ts'

const text = (t: string): Reply => ({ blocks: [{ kind: 'text', text: t }] })
const tick = async () => { for (let i = 0; i < 6; i++) await new Promise(resolve => setImmediate(resolve)) }

/** A desk whose agents answer by `script`: given a conversation and what was said there, what it does and says. */
function office(script: (sessionId: string, said: string, desk: HandOffDesk) => Reply | Promise<Reply>) {
  const said: { sessionId: string; text: string }[] = []
  const kept: HandOff[] = []
  const desk: HandOffDesk = createHandOffDesk({
    home: async agent => `s-${agent}`,
    converse: async (sessionId, message) => {
      said.push({ sessionId, text: message })
      return script(sessionId, message, desk)
    },
    record: async item => { kept.push(item) },
    now: () => 1000,
  })
  const threadOf = (message: string) => parseTask(message)?.thread ?? parseThreadNote(message)?.thread ?? ''
  return { desk, said, kept, threadOf, last: (id: string) => kept.filter(h => h.id === id).at(-1)! }
}

const handed = (over: Partial<HandOffInput> = {}): HandOffInput => ({
  to: { id: 'scripts', name: '脚本' }, by: '助手', title: '看 MAA', task: '看看 MAA 为什么报错',
  signal: new AbortController().signal, from: { sessionId: 's-main', callId: 'h1', asker: '助手', agent: 'main' }, relay: true, ...over,
})

test('the agent doing the work can ask, and the work goes on once it is answered', async () => {
  let id = ''
  const o = office(async (sessionId, message, desk) => {
    if (sessionId === 's-scripts' && parseTask(message) !== undefined) {
      id = parseTask(message)!.thread!
      const told = await desk.message({ thread: id, fromSession: 's-scripts', from: '脚本', kind: 'question', text: '现在迁移还是今晚迁？' })
      assert.match(told, /结束这一轮/)
      return text('我问了助手，等它回答')
    }
    if (sessionId === 's-main' && parseThreadNote(message)?.kind === 'question') {
      await desk.message({ thread: id, fromSession: 's-main', from: '助手', kind: 'answer', text: '今晚迁' })
      return text('已回答')
    }
    if (sessionId === 's-scripts' && parseThreadNote(message)?.kind === 'answer') return text('结论：今晚迁完了')
    return text('好的')
  })
  const reply = await o.desk.handOff(handed())
  await tick()
  assert.equal(id, 'h1', 'the work says which thread it is')
  assert.deepEqual(o.said.map(s => s.sessionId), ['s-scripts', 's-main', 's-scripts', 's-main'], 'there and back and there, then the conclusion back')
  assert.equal(parseThreadNote(o.said[1]!.text)?.text, '现在迁移还是今晚迁？')
  assert.equal(parseThreadNote(o.said[2]!.text)?.text, '今晚迁')
  assert.equal(parseRelay(o.said[3]!.text)?.reply, '结论：今晚迁完了')
  assert.equal(reply.blocks[0]!.kind === 'text' && reply.blocks[0]!.text, '结论：今晚迁完了')
  assert.deepEqual(o.kept.map(h => h.state), ['running', 'waiting', 'running', 'done'])
  assert.deepEqual(o.last('h1').messages!.map(m => `${m.from}:${m.kind}`), ['脚本:question', '助手:answer'])
})

test("a model that forgets the tool still answers: the asker's last words are its answer", async () => {
  const o = office(async (sessionId, message, desk) => {
    if (parseTask(message) !== undefined) {
      await desk.message({ thread: 'h1', fromSession: 's-scripts', from: '脚本', kind: 'question', text: '迁吗？' })
      return text('等回答')
    }
    if (sessionId === 's-main' && parseThreadNote(message) !== undefined) return text('今晚迁')
    if (parseThreadNote(message)?.kind === 'answer') return text('结论：迁好了')
    return text('好的')
  })
  await o.desk.handOff(handed())
  await tick()
  assert.equal(parseThreadNote(o.said[2]!.text)?.text, '今晚迁')
  assert.equal(o.last('h1').reply, '结论：迁好了')
})

test('an asker that needs time says so, and its words are not taken for the answer', async () => {
  let answer = () => {}
  const o = office(async (sessionId, message, desk) => {
    if (parseTask(message) !== undefined) {
      await desk.message({ thread: 'h1', fromSession: 's-scripts', from: '脚本', kind: 'question', text: '迁吗？' })
      return text('等回答')
    }
    if (sessionId === 's-main' && parseThreadNote(message) !== undefined) {
      await desk.message({ thread: 'h1', fromSession: 's-main', from: '助手', kind: 'update', text: '我去问用户' })
      answer = () => { void desk.message({ thread: 'h1', fromSession: 's-main', from: '助手', kind: 'answer', text: '用户说今晚' }) }
      return text('我去问用户')
    }
    if (parseThreadNote(message)?.kind === 'answer') return text('结论：今晚')
    return text('好的')
  })
  const done = o.desk.handOff(handed())
  await tick()
  assert.equal(o.last('h1').state, 'waiting', 'still waiting')
  assert.equal(o.said.filter(s => s.sessionId === 's-scripts').length, 1, 'the worker is not told yet')
  answer()
  await done
  assert.equal(o.last('h1').reply, '结论：今晚')
})

test('`done` is the conclusion, whatever else it says in that turn, and closes the thread', async () => {
  const o = office(async (sessionId, message, desk) => {
    if (parseTask(message) !== undefined) {
      await desk.message({ thread: 'h1', fromSession: 's-scripts', from: '脚本', kind: 'done', text: '结论：配置格式变了' })
      return text('好了，收工')
    }
    return text('好的')
  })
  await o.desk.handOff(handed())
  await tick()
  assert.equal(o.last('h1').state, 'done')
  assert.equal(o.last('h1').reply, '结论：配置格式变了')
  await assert.rejects(o.desk.message({ thread: 'h1', fromSession: 's-scripts', from: '脚本', kind: 'question', text: '还有' }), /已经结束/)
})

test('an update is kept but wakes nobody', async () => {
  const o = office(async (_sessionId, message, desk) => {
    if (parseTask(message) !== undefined) {
      await desk.message({ thread: 'h1', fromSession: 's-scripts', from: '脚本', kind: 'update', text: '读了一半' })
      return text('结论：好了')
    }
    return text('好的')
  })
  await o.desk.handOff(handed())
  await tick()
  assert.equal(o.said.length, 2, 'the task and the conclusion')
  assert.equal(o.last('h1').messages![0]!.text, '读了一半')
})

test('someone outside the thread cannot speak in it, and only the worker concludes', async () => {
  let refused: string[] = []
  const o = office(async (_sessionId, message, desk) => {
    if (parseTask(message) !== undefined) {
      refused = await Promise.all([
        desk.message({ thread: 'h1', fromSession: 's-games', from: '游戏', kind: 'answer', text: 'x' }).catch(e => e.message as string),
        desk.message({ thread: 'h1', fromSession: 's-main', from: '助手', kind: 'done', text: 'x' }).catch(e => e.message as string),
      ])
      return text('结论')
    }
    return text('好的')
  })
  await o.desk.handOff(handed())
  assert.match(refused[0]!, /不是你和对方之间的/)
  assert.match(refused[1]!, /只有做这件事的一方/)
})

test('work with nobody waiting on it has nobody to ask', async () => {
  let refused = ''
  const o = office(async (_sessionId, message, desk) => {
    if (parseTask(message) !== undefined) refused = await desk.message({ thread: parseTask(message)!.thread!, fromSession: 's-games', from: '游戏', kind: 'question', text: 'x' }).catch(e => e.message as string)
    return text('写好了')
  })
  await o.desk.handOff({ to: { id: 'games', name: '游戏' }, by: '定时', title: '日报', task: '写日报', signal: new AbortController().signal })
  assert.match(refused, /没有人等着回答/)
})

test('a thread has a budget of messages: past it, conclude', async () => {
  let refused = ''
  const o = office(async (_sessionId, message, desk) => {
    if (parseTask(message) !== undefined) {
      for (let i = 0; i < MAX_THREAD_MESSAGES; i++) await desk.message({ thread: 'h1', fromSession: 's-scripts', from: '脚本', kind: 'update', text: `${i}` })
      refused = await desk.message({ thread: 'h1', fromSession: 's-scripts', from: '脚本', kind: 'question', text: '再问一句' }).catch(e => e.message as string)
      return text('结论')
    }
    return text('好的')
  })
  await o.desk.handOff(handed())
  assert.match(refused, /做个结论/)
})

test('a lead asks a colleague directly: its thread waits, and takes in what came back', async () => {
  const o = office(async (sessionId, message, desk) => {
    if (sessionId === 's-scripts' && parseTask(message) !== undefined) {
      void desk.handOff({ to: { id: 'games', name: '游戏' }, by: '脚本', title: '哪个服', task: '用户玩哪个服？', signal: new AbortController().signal, from: { sessionId: 's-scripts', callId: 'h2', asker: '脚本', agent: 'scripts' }, relay: true })
      return text('问了游戏，等它回来')
    }
    if (sessionId === 's-games') return text('国服')
    if (sessionId === 's-scripts' && parseRelay(message) !== undefined) return text(`结论：按${parseRelay(message)!.reply}装`)
    return text('好的')
  })
  await o.desk.handOff(handed())
  await tick()
  const inner = o.last('h2')
  assert.deepEqual({ by: inner.by, to: inner.to, parent: inner.parent, chain: inner.chain }, { by: '脚本', to: 'games', parent: 'h1', chain: ['main', 'scripts', 'games'] })
  assert.equal(o.last('h1').reply, '结论：按国服装', 'the first thread ends on what came of it')
  const backToLead = o.said.find(s => s.sessionId === 's-scripts' && parseRelay(s.text) !== undefined)!
  assert.match(backToLead.text, /接着做你手上的事/, 'not told to tell the person')
  assert.doesNotMatch(backToLead.text, /告诉用户/)
  const backToMain = o.said.find(s => s.sessionId === 's-main')!
  assert.match(backToMain.text, /还问了：游戏/, '助手 hears who it asked, without being woken for it')
  assert.match(backToMain.text, /告诉用户/)
})

test('a chain does not come back on itself, goes only so deep, and has a budget', async () => {
  const refusals: (string | undefined)[] = []
  const o = office(async (sessionId, message, desk) => {
    if (sessionId === 's-scripts' && parseTask(message) !== undefined) {
      refusals.push(desk.refusal('s-scripts', 'scripts', 'scripts'), desk.refusal('s-scripts', 'main', 'scripts'), desk.refusal('s-scripts', 'games', 'scripts'))
      return text('结论')
    }
    return text('好的')
  })
  await o.desk.handOff(handed())
  assert.match(refusals[0]!, /不能交给自己/)
  assert.match(refusals[1]!, /绕回去了.*agent_message/)
  assert.equal(refusals[2], undefined, 'a colleague not on the chain')
  assert.equal(o.desk.refusal('s-idle', 'games', 'scripts'), undefined, 'not working on anything: nothing to come back to')

  // Three below the first asker, and no further.
  const deep = office(async (sessionId, message, desk) => {
    const next: Record<string, [string, string]> = { 's-a': ['b', 'B'], 's-b': ['c', 'C'] }
    if (parseTask(message) !== undefined && next[sessionId] !== undefined) {
      const [id, name] = next[sessionId]!
      void desk.handOff({ to: { id, name }, by: sessionId, title: id, task: id, signal: new AbortController().signal, from: { sessionId, callId: `h-${id}`, agent: sessionId.slice(2) }, relay: true })
      return text('问了')
    }
    if (sessionId === 's-c' && parseTask(message) !== undefined) {
      refusals.push(desk.refusal('s-c', 'd', 'c'))
      return text('到底了')
    }
    return text('好的')
  })
  await deep.desk.handOff({ to: { id: 'a', name: 'A' }, by: '助手', title: 'a', task: 'a', signal: new AbortController().signal, from: { sessionId: 's-main', callId: 'h-a', agent: 'main' }, relay: true })
  assert.match(refusals.at(-1)!, /转了 3 手/)
  assert.ok(MAX_CHAIN_MESSAGES > MAX_THREAD_MESSAGES)
})

test('calling off the first thread stops what was opened from inside it', async () => {
  const controller = new AbortController()
  let innerSignal: AbortSignal | undefined
  const desk: HandOffDesk = createHandOffDesk({
    home: async agent => `s-${agent}`,
    converse: (sessionId, message, signal) => {
      if (sessionId === 's-scripts' && parseTask(message) !== undefined) {
        void desk.handOff({ to: { id: 'games', name: '游戏' }, by: '脚本', title: 'x', task: 'x', signal: new AbortController().signal, from: { sessionId: 's-scripts', callId: 'h2', agent: 'scripts' } }).catch(() => {})
        return Promise.resolve(text('等它'))
      }
      if (sessionId === 's-games') {
        innerSignal = signal
        return new Promise((_, reject) => { signal.addEventListener('abort', () => reject(new Error('被叫停了')), { once: true }) })
      }
      return Promise.resolve(text('好的'))
    },
    record: async () => {},
  })
  const outer = desk.handOff(handed({ signal: controller.signal, relay: false, from: { sessionId: 's-main', callId: 'h1', agent: 'main' } }))
  await tick()
  controller.abort(new Error('超时了'))
  await assert.rejects(outer, /超时了/)
  assert.equal(innerSignal?.aborted, true)
})
