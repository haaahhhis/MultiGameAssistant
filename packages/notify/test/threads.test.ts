import { strict as assert } from 'node:assert'
import { test } from 'node:test'
import { parseRelay, parseTask, parseThreadNote, reminderPrompts, type HandOff } from '@adg/protocol'
import { createHandOffDesk, MAX_CHAIN_MESSAGES, MAX_THREAD_MESSAGES, pastBetween, type HandOffDesk } from '../src/handoff.ts'
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
      assert.equal(desk.waitingOn('s-main'), true, '助手 waits for this to come back')
      assert.equal(desk.waitingOn('s-scripts'), false, 'the one doing it is not waiting on anybody')
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
  assert.equal(o.desk.waitingOn('s-main'), false, 'back: nothing to wait for')
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
  assert.equal(parseThreadNote(o.said.filter(s => s.sessionId === 's-scripts').at(-1)!.text)?.kind, 'update', 'the worker is told to hold on, and that is not the answer')
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
})

test('what the agent doing the work says reaches the asker as it is said, as often as it says it', async () => {
  let atSecond = 0
  const o = office(async (_sessionId, message, desk) => {
    if (parseTask(message) !== undefined) {
      await desk.message({ thread: 'h1', fromSession: 's-scripts', from: '脚本', kind: 'update', text: '34154' })
      await tick()
      atSecond = o.said.length
      await desk.message({ thread: 'h1', fromSession: 's-scripts', from: '脚本', kind: 'update', text: '114514' })
      return text('结论：两条都发了')
    }
    return text('（不用告诉用户）')
  })
  await o.desk.handOff(handed())
  await tick()
  assert.equal(atSecond, 2, 'the first arrived before the work went on')
  const toAsker = o.said.filter(s => s.sessionId === 's-main')
  assert.deepEqual(toAsker.slice(0, 2).map(s => parseThreadNote(s.text)?.text), ['34154', '114514'])
  assert.equal(parseThreadNote(toAsker[0]!.text)?.kind, 'update')
  assert.match(toAsker[0]!.text, /告诉用户/, '助手 is told what to do with it')
  assert.equal(parseRelay(toAsker[2]!.text)?.reply, '结论：两条都发了')
  assert.deepEqual(o.last('h1').messages!.map(m => m.text), ['34154', '114514'])
})

test('a lead that asked is told to go on with its own, not to tell the person', async () => {
  const o = office(async (_sessionId, message, desk) => {
    if (parseTask(message) !== undefined) {
      await desk.message({ thread: 'h1', fromSession: 's-games', from: '游戏', kind: 'update', text: '读到一半' })
      return text('结论')
    }
    return text('好的')
  })
  await o.desk.handOff(handed({ to: { id: 'games', name: '游戏' }, by: '脚本', from: { sessionId: 's-scripts', callId: 'h1', asker: '脚本', agent: 'scripts' } }))
  await tick()
  const told = o.said.find(s => s.sessionId === 's-scripts' && parseThreadNote(s.text) !== undefined)!.text
  assert.match(told, /接着做你手上的事/)
  assert.doesNotMatch(told, /告诉用户/)
})

test('the asker can add to the work while it goes on, and it reaches the agent doing it', async () => {
  const o = office(async (sessionId, message, desk) => {
    if (parseTask(message) !== undefined) {
      await desk.message({ thread: 'h1', fromSession: 's-main', from: '助手', kind: 'update', text: '只看今天的' })
      return text('结论：今天的看了')
    }
    return text('好的')
  })
  await o.desk.handOff(handed())
  await tick()
  assert.equal(parseThreadNote(o.said.filter(s => s.sessionId === 's-scripts').at(-1)!.text)?.text, '只看今天的')
})

test('after the work is handed back the two can still talk on the thread', async () => {
  const kept: HandOff[] = []
  const said: { sessionId: string; text: string }[] = []
  const homes: Record<string, string> = { main: 's-main', scripts: 's-scripts' }
  const desk = createHandOffDesk({
    home: async agent => homes[agent]!,
    converse: async (sessionId, message) => { said.push({ sessionId, text: message }); return text(parseTask(message) === undefined ? '好的' : '34154') },
    record: async item => { kept.push(item) },
    threads: () => [...new Map(kept.map(h => [h.id, h])).values()],
    now: () => (kept.length === 0 ? 1000 : 2000),
  })
  await desk.handOff(handed())
  await tick()
  said.length = 0
  // The reminder it set comes: a turn nobody follows, so only the tool can carry its words back.
  assert.match(await desk.message({ thread: 'h1', fromSession: 's-scripts', from: '脚本', kind: 'update', text: '114514' }), /送到/)
  await tick()
  assert.equal(said.length, 1)
  assert.equal(said[0]!.sessionId, 's-main')
  const note = parseThreadNote(said[0]!.text)!
  assert.equal(note.text, '114514')
  assert.match(said[0]!.text, /交回了/, 'it says the work was handed back already')
  const last = kept.at(-1)!
  assert.equal(last.state, 'done', 'the thread stays as it ended')
  assert.equal(last.reply, '34154', 'what was concluded stays what was concluded')
  assert.deepEqual(last.messages!.map(m => `${m.from}:${m.kind}:${m.text}`), ['脚本:update:114514'])

  // 助手 answers back the same way; a conversation replaced since is still the agent's.
  homes.scripts = 's-scripts-new'
  said.length = 0
  await desk.message({ thread: 'h1', fromSession: 's-main', from: '助手', kind: 'question', text: '几点发的？' })
  await tick()
  assert.equal(said[0]!.sessionId, 's-scripts-new')
  assert.match(said[0]!.text, /kind 填 answer/, 'a reply goes nowhere by itself, so it is told to use the tool')
  await desk.message({ thread: 'h1', fromSession: 's-scripts-new', from: '脚本', kind: 'done', text: '20 点' })
  assert.equal(kept.at(-1)!.messages!.at(-1)!.kind, 'update', 'a conclusion after the conclusion is only something said')

  await assert.rejects(desk.message({ thread: 'h1', fromSession: 's-games', from: '游戏', kind: 'update', text: 'x' }), /不是你和对方之间的/)
  await assert.rejects(desk.message({ thread: 'nope', fromSession: 's-main', from: '助手', kind: 'update', text: 'x' }), /没有线索/)
  for (let i = kept.at(-1)!.messages!.length; i < MAX_THREAD_MESSAGES; i++) await desk.message({ thread: 'h1', fromSession: 's-main', from: '助手', kind: 'update', text: `${i}` })
  await assert.rejects(desk.message({ thread: 'h1', fromSession: 's-main', from: '助手', kind: 'update', text: 'x' }), /够多了/, 'two agents cannot wake each other for ever')
})

test('a reminder set on a thread says where its words go, and one set off it says nothing', async () => {
  let noted: string | undefined
  const o = office(async (sessionId, message, desk) => {
    if (parseTask(message) !== undefined) noted = desk.reminderNote(sessionId, '只回 114514')
    return text('34154')
  })
  await o.desk.handOff(handed())
  assert.match(noted!, /^只回 114514\n\n.*线索 h1.*agent_message/su)
  assert.equal(o.desk.reminderNote('s-scripts', '别的提醒'), undefined, 'the thread is over: nothing to say it belongs to')
  assert.equal(reminderPrompts(`[SCHEDULE REMINDER]\nreminder_prompt_json: ${JSON.stringify(noted)}`)![0], '只回 114514', 'the person sees what was asked for, not the note')
})

test('work the app handed on has nobody to tell, and is told so', async () => {
  const told: string[] = []
  const o = office(async (_sessionId, message, desk) => {
    if (parseTask(message) !== undefined) told.push(await desk.message({ thread: parseTask(message)!.thread ?? '', fromSession: 's-scripts', from: '脚本', kind: 'update', text: '读了一半' }).catch(e => e.message as string))
    return text('结论')
  })
  await o.desk.handOff(handed({ from: { sessionId: '', callId: 'h1', asker: '定时' }, by: '定时', relay: false }))
  await tick()
  assert.match(told[0]!, /记下了/)
  assert.equal(o.said.length, 1, 'only the task')
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

test('what is said in a thread goes into the work under way; the work itself waits its turn', async () => {
  const sent: { sessionId: string; insert: boolean; text: string }[] = []
  const desk: HandOffDesk = createHandOffDesk({
    home: async agent => `s-${agent}`,
    converse: async (sessionId, message, _signal, _images, options) => {
      sent.push({ sessionId, insert: options?.insert === true, text: message })
      if (sessionId === 's-scripts' && parseTask(message) !== undefined) {
        await desk.message({ thread: parseTask(message)!.thread!, fromSession: 's-scripts', from: '脚本', kind: 'question', text: '装哪个？' })
        return text('问了')
      }
      if (sessionId === 's-scripts') return text('结论')
      return text('MAA')
    },
    record: async () => {},
    now: () => 1000,
  })
  await desk.handOff(handed())
  await tick()
  assert.equal(sent.find(m => parseTask(m.text) !== undefined)?.insert, false, 'new work does not cut in')
  assert.equal(sent.find(m => parseThreadNote(m.text)?.kind === 'question')?.insert, true, 'a question does: someone waits')
  assert.equal(sent.find(m => parseThreadNote(m.text)?.kind === 'answer')?.insert, true)
})

test('an agent handed work by another asks that agent, not the person; what the app hands on has only the person to ask', async () => {
  let during: string | undefined
  const desk: HandOffDesk = createHandOffDesk({
    home: async agent => `s-${agent}`,
    converse: async sessionId => {
      if (sessionId === 's-scripts') during = desk.askRefusal('s-scripts')
      return text('好了')
    },
    record: async () => {},
    now: () => 1000,
  })
  await desk.handOff(handed())
  assert.match(during ?? '', /助手/)
  assert.match(during ?? '', /agent_message/)
  assert.match(during ?? '', /h1/)
  assert.equal(desk.askRefusal('s-scripts'), undefined, 'the work is over: the person may be asked again')
  during = 'unset'
  await desk.handOff(handed({ from: undefined, by: '监控', relay: false }))
  assert.equal(during, undefined)
})

test('a new thread comes with what those two said before, kept outside their conversations; not what others said', async () => {
  const kept: HandOff[] = []
  const handed_: string[] = []
  const desk: HandOffDesk = createHandOffDesk({
    home: async agent => `s-${agent}`,
    converse: async (sessionId, message) => {
      if (parseTask(message) !== undefined) handed_.push(message)
      return text(`结论 ${handed_.length}`)
    },
    record: async item => { kept.splice(kept.findIndex(h => h.id === item.id) >>> 0, 1, item) },
    threads: () => kept,
    now: () => 1000,
  })
  await desk.handOff(handed({ title: '看日志', from: { sessionId: 's-main', callId: 't1', asker: '助手', agent: 'main' } }))
  assert.doesNotMatch(handed_[0]!, /之前的来往/, 'nothing yet')
  await desk.handOff(handed({ title: '装 MAA', from: { sessionId: 's-main', callId: 't2', asker: '助手', agent: 'main' } }))
  assert.match(handed_[1]!, /你和「助手」之前的来往/)
  assert.match(handed_[1]!, /「看日志」：结论 1（线索 t1）/)
  await desk.handOff(handed({ title: '问游戏', by: '脚本', to: { id: 'games', name: '游戏' }, from: { sessionId: 's-scripts', callId: 't3', asker: '脚本', agent: 'scripts' } }))
  assert.doesNotMatch(handed_[2]!, /之前的来往/, 'between 助手 and 脚本, not 游戏\'s')
  // The other way round is the same two agents.
  await desk.handOff(handed({ title: '回问脚本', by: '游戏', to: { id: 'scripts', name: '脚本' }, from: { sessionId: 's-games', callId: 't4', asker: '游戏', agent: 'games' } }))
  assert.match(handed_[3]!, /「问游戏」/)
  assert.doesNotMatch(handed_[3]!, /看日志/)
})

test('only the latest few come along, and what the app handed on is no exchange between agents', () => {
  const thread = (id: string, chain: string[], over: Partial<HandOff> = {}): HandOff => ({ id, fromSession: 's', by: '助手', to: chain.at(-1)!, toSession: 't', title: id, task: 'x', chain, state: 'done', startedAt: 1, reply: 'r', ...over })
  const name = (id: string) => id
  const lines = pastBetween([...Array.from({ length: 7 }, (_, i) => thread(`t${i}`, ['main', 'scripts'])), thread('app', ['scripts']), thread('now', ['main', 'scripts'], { state: 'running' })], 'main', 'scripts', name)
  assert.equal(lines.length, 5)
  assert.match(lines[0]!, /t2/)
  assert.match(lines[4]!, /t6/)
  assert.equal(lines.some(l => l.includes('app') || l.includes('now')), false)
  assert.match(pastBetween([thread('long', ['main', 'scripts'], { reply: 'a'.repeat(400) })], 'main', 'scripts', name)[0]!, /a{120}…/)
  assert.match(pastBetween([thread('bad', ['main', 'scripts'], { state: 'failed' })], 'main', 'scripts', name)[0]!, /没做成/)
})
