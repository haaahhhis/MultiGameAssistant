import { strict as assert } from 'node:assert'
import { appendFileSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { test } from 'node:test'
import { ARCHIVE_MARK } from '@adg/protocol'
import type { GenerateOptions } from '@deepseek-ai/dsh-llm'
import { apply, archiveRange, assemble, coverOf, isMessage, isPointer, keepSummaries, lowContextRange, MIN_SPAN_TOKENS, ownSummaries, parseArchiveDays, parseLowContext, pointerStep, pointerText, Refusals, refusedForSize, settingsReader, spanChars, spanTokens, summariesReader, summarizeSpan, summaryBudget, summaryInstruction, SummaryError, summaryTarget, taskOver, type StoppingAgent, type SurfaceEvent, type SurfaceView } from '../src/low-context.ts'

const HOUR = 60 * 60_000
const NOW = Date.parse('2026-11-13T12:00:00Z')

/** A surface: the system prompt, then each turn as a message, the harness's notes, a reply with a tool call, its result, a reply. */
function session(turns: readonly { at: number; summary?: boolean }[]): SurfaceView & { id: string; seqOf: (turn: number) => number } {
  const events: SurfaceEvent[] = [{ type: 'system/message', time: NOW - 100 * HOUR }]
  const starts: number[] = []
  for (const turn of turns) {
    starts.push(events.length)
    if (turn.summary === true) { events.push({ type: 'user/message', time: turn.at, data: { source: { kind: 'compact-checkpoint' } }, surfaceOp: { op: 'replace', startSeq: 1, endSeq: 2 } }); continue }
    events.push({ type: 'user/message', time: turn.at, data: { source: { kind: 'user' } }, surfaceOp: 'append' })
    events.push({ type: 'user/message', time: turn.at, data: { source: { kind: 'runtime-context', form: 'instructions' } }, surfaceOp: 'append' })
    events.push({ type: 'user/message', time: turn.at, data: { source: { kind: 'time-context', form: 'snapshot' } }, surfaceOp: 'append' })
    events.push({ type: 'assistant/message', time: turn.at + 1, surfaceOp: 'append' })
    events.push({ type: 'tool/result', time: turn.at + 2, surfaceOp: 'append' })
    events.push({ type: 'assistant/message', time: turn.at + 3, surfaceOp: 'append' })
  }
  // Seqs are not positions: the surface skips some (stream chunks, markers).
  const seqs = events.map((_, i) => i * 3 + 10)
  return {
    id: 's1',
    surface: { nodes: seqs },
    eventAt: seq => events[seqs.indexOf(seq)],
    seqOf: turn => seqs[starts[turn]!]!,
  }
}

test("a message is what someone said: not a summary, not the harness's notes on a turn", () => {
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'user' } }, surfaceOp: 'append' }), true)
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'user-rpc' } }, surfaceOp: 'append' }), true, 'from Feishu or QQ')
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'notice', form: 'notice' } }, surfaceOp: 'append' }), true, "the app's and other agents' messages count")
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'adg-time', form: 'snapshot' } }, surfaceOp: 'append' }), false)
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'runtime-context', form: 'instructions' } }, surfaceOp: 'append' }), false)
  assert.equal(isMessage({ type: 'user/message', time: 0, data: { source: { kind: 'skill-catalog', form: 'catalog' } }, surfaceOp: 'append' }), false)
  assert.equal(isMessage({ type: 'user/message', time: 0, surfaceOp: { op: 'replace', startSeq: 0, endSeq: 1 } }), false)
  assert.equal(isMessage({ type: 'assistant/message', time: 0, surfaceOp: 'append' }), false)
})

test('the last 12 hours stay, however many messages; what is older goes, whole turns', () => {
  const busy = session(Array.from({ length: 40 }, (_, i) => ({ at: NOW - 11 * HOUR + i * 60_000 })))
  assert.equal(lowContextRange(busy, { now: NOW }), null, '40 messages, all within 12 hours: no sliding window')
  const s = session([{ at: NOW - 20 * HOUR }, { at: NOW - 13 * HOUR }, { at: NOW - 6 * HOUR }, { at: NOW - HOUR }])
  assert.deepEqual(lowContextRange(s, { now: NOW }), { start: s.surface.nodes[1], end: s.seqOf(2) - 3 }, 'up to just before the first message of the window')
})

test('a summary alone is not compacted again; with more that aged, it goes in with them', () => {
  assert.equal(lowContextRange(session([{ at: NOW - 20 * HOUR, summary: true }, { at: NOW - HOUR }]), { now: NOW }), null)
  const s = session([{ at: NOW - 20 * HOUR, summary: true }, { at: NOW - 13 * HOUR }, { at: NOW - HOUR }])
  assert.deepEqual(lowContextRange(s, { now: NOW }), { start: s.surface.nodes[1], end: s.seqOf(2) - 3 })
})

test('when every message is old the latest stays; one message or none is left alone', () => {
  const old = session([{ at: NOW - 50 * HOUR }, { at: NOW - 30 * HOUR }])
  assert.deepEqual(lowContextRange(old, { now: NOW }), { start: old.surface.nodes[1], end: old.seqOf(1) - 3 })
  assert.equal(lowContextRange(session([{ at: NOW - 50 * HOUR }]), { now: NOW }), null)
  assert.equal(lowContextRange(session([]), { now: NOW }), null)
})

test('it compacts only once the task is over: nothing queued, no sub-agent working, no hand-off waiting', () => {
  const agent = { session: session([]), inbox: { nextTurn: [], nextStep: [] } }
  assert.equal(taskOver(agent, { workPending: () => false }), true)
  assert.equal(taskOver(agent, undefined), true, 'no gateway to ask: the turn is all there is')
  assert.equal(taskOver({ ...agent, inbox: { nextTurn: ['又来一条'], nextStep: [] } }, undefined), false)
  assert.equal(taskOver(agent, { workPending: id => id === 's1' }), false)
})

test('the switch comes from compaction.json, off when it is missing or broken, and is read again when it changes', () => {
  assert.equal(parseLowContext(undefined), false)
  assert.equal(parseLowContext({ lowContext: true }), true)
  assert.equal(parseLowContext({ lowContext: 'yes' }), false)
  assert.equal(parseArchiveDays({ archiveDays: 7 }), 7)
  assert.equal(parseArchiveDays({ archiveDays: 0 }), null, 'out of range: off')
  assert.equal(parseArchiveDays({ archiveDays: '7' }), null)
  assert.equal(parseArchiveDays({}), null, 'older files have none: off')
  const file = join(mkdtempSync(join(tmpdir(), 'adg-low-context-')), 'compaction.json')
  const read = settingsReader(file)
  assert.deepEqual(read(), { lowContext: false, archiveDays: null }, 'no file yet')
  writeFileSync(file, JSON.stringify({ auto: true, threshold: 80, lowContext: true }))
  assert.deepEqual(read(), { lowContext: true, archiveDays: null })
  writeFileSync(file, JSON.stringify({ auto: true, threshold: 80, lowContext: true, archiveDays: 14 }))
  assert.deepEqual(read(), { lowContext: true, archiveDays: 14 })
  writeFileSync(file, 'not json at all, and longer than before')
  assert.deepEqual(read(), { lowContext: false, archiveDays: null })
})

const DAY = 24 * HOUR

/**
 * A log for archiving: every record by its seq (shadowed ones too, as dsh keeps
 * them), and a surface of the seqs still in view.
 */
function log() {
  const events = new Map<number, SurfaceEvent>()
  let next = 1
  const add = (event: SurfaceEvent) => { const seq = next++; events.set(seq, event); return seq }
  const say = (at: number) => [add({ type: 'user/message', time: at, data: { source: { kind: 'user' } }, surfaceOp: 'append' }), add({ type: 'assistant/message', time: at + 1, surfaceOp: 'append' })]
  const summary = (written: number, replaced: readonly number[], text = '要点：装好了 MAA') => {
    const start = add({ type: 'compaction/start', time: written })
    const record = add({ type: 'compaction/summary', time: written })
    return add({ type: 'user/message', time: written, data: { content: [{ type: 'text', text: '这是检查点。\n\n<compacted-summary>' }, { type: 'text', text }, { type: 'text', text: '</compacted-summary>' }] }, surfaceOp: { op: 'replace' }, sourceEventSeqs: [start, record, ...replaced] })
  }
  const system = add({ type: 'system/message', time: NOW - 100 * DAY })
  return { events, add, say, summary, system, view: (nodes: number[]): SurfaceView & { id: string } => ({ id: 's1', surface: { nodes }, eventAt: seq => events.get(seq) }) }
}

test('with archiving, the summaries at the start stay and only what follows is compacted, a day or so at a time', () => {
  const l = log()
  const old = l.say(NOW - 3 * DAY)
  const s1 = l.summary(NOW - 3 * DAY + HOUR, old)
  const day2 = l.say(NOW - 30 * HOUR)
  const day3 = l.say(NOW - 20 * HOUR)
  const today = l.say(NOW - HOUR)
  const session = l.view([l.system, s1, ...day2, ...day3, ...today])
  assert.deepEqual(lowContextRange(session, { now: NOW }), { start: s1, end: day3[1] }, 'without archiving: the summary goes in again')
  assert.deepEqual(lowContextRange(session, { now: NOW, separate: true, batchMs: 12 * HOUR }), { start: day2[0], end: day3[1] }, 'with it: from after the summary')
  const young = l.view([l.system, s1, ...day3, ...today])
  assert.equal(lowContextRange(young, { now: NOW, separate: true, batchMs: 12 * HOUR }), null, 'its oldest message is not a day old yet: it waits')
})

test("a summary's span is the messages it replaced, through a summary inside it; its compaction's own records do not count", () => {
  const l = log()
  const first = l.say(NOW - 10 * DAY)
  const s1 = l.summary(NOW - 9 * DAY, first)
  const second = l.say(NOW - 8 * DAY)
  const s2 = l.summary(NOW - 2 * DAY, [s1, ...second])
  assert.deepEqual(coverOf(l.view([]), l.events.get(s2)!), { from: NOW - 10 * DAY, to: NOW - 8 * DAY + 1, firstSeq: first[0], lastSeq: second[1] })
})

test('old summaries at the start are archived together; a recent one, and what follows it, stay', () => {
  const l = log()
  const a = l.say(NOW - 20 * DAY)
  const sa = l.summary(NOW - 19 * DAY, a, '要点 A')
  const b = l.say(NOW - 10 * DAY)
  const sb = l.summary(NOW - 9 * DAY, b, '要点 B')
  const c = l.say(NOW - 2 * DAY)
  const sc = l.summary(NOW - DAY, c, '要点 C')
  const today = l.say(NOW - HOUR)
  const session = l.view([l.system, sa, sb, sc, ...today])
  const range = archiveRange(session, { now: NOW, archiveDays: 7 })
  assert.equal(range?.start, sa)
  assert.equal(range?.end, sb)
  assert.deepEqual(range?.cover, { from: NOW - 20 * DAY, to: NOW - 10 * DAY + 1, firstSeq: a[0], lastSeq: b[1] })
  assert.deepEqual(range?.summaries.map(s => [s.seq, s.text]), [[sa, '要点 A'], [sb, '要点 B']], "each one's own words, without dsh's framing")
  assert.equal(archiveRange(session, { now: NOW, archiveDays: 30 }), null, 'none old enough')

  // The pointer they leave is archived again with the next old summary, and alone is nothing to do.
  const text = pointerText(range!.cover)
  assert.ok(text.startsWith(ARCHIVE_MARK))
  assert.match(text, new RegExp(`#${a[0]}–#${b[1]}`))
  assert.match(text, /history_search/)
  const start = l.add({ type: 'compaction/start', time: NOW })
  const pointer = l.add({ type: 'user/message', time: NOW, data: { content: [{ type: 'text', text }] }, surfaceOp: { op: 'replace' }, sourceEventSeqs: [start, sa, sb] })
  assert.equal(isPointer(l.events.get(pointer)!), true)
  assert.equal(isPointer(l.events.get(sc)!), false)
  assert.equal(archiveRange(l.view([l.system, pointer, sc, ...today]), { now: NOW, archiveDays: 7 }), null, 'only the pointer is old')
  const later = archiveRange(l.view([l.system, pointer, sc, ...today]), { now: NOW + 7 * DAY, archiveDays: 7 })
  assert.equal(later?.start, pointer)
  assert.equal(later?.end, sc)
  assert.deepEqual(later?.summaries.map(s => s.text), ['要点 C'], 'the pointer is not kept as a summary')
  assert.equal(later?.cover.firstSeq, a[0], 'the new pointer stands for all of it')
})

test("the plugin's own summary step answers only its own compaction of that session, and lets go of the engine when done", async () => {
  const calls: string[] = []
  const engine = {
    async summarize(_input: unknown, agent: unknown) { calls.push(`model:${(agent as StoppingAgent).session.id}`); return { summary: [{ type: 'text', text: 'model' }] } },
    async compactRegion(start: number, end: number, agent: unknown) {
      const result = await (this as unknown as { summarize(input: unknown, agent: unknown): Promise<{ summary: { text: string }[] }> }).summarize({}, agent)
      calls.push(`${start}-${end}:${result.summary[0]!.text}`)
      return { shadowedSeqs: [start, end] }
    },
  }
  const original = engine.summarize
  const own = ownSummaries(engine)!
  const agent = (id: string) => ({ session: { id, surface: { nodes: [] }, eventAt: () => undefined, requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }) as StoppingAgent
  await own.run({ start: 2, end: 5 }, agent('s1'), pointerStep(`${ARCHIVE_MARK}已归档`), new AbortController().signal)
  await engine.compactRegion(7, 9, agent('s2'))
  await engine.compactRegion(3, 4, agent('s1'))
  assert.deepEqual(calls, [`2-5:${ARCHIVE_MARK}已归档`, 'model:s2', '7-9:model', 'model:s1', '3-4:model'], "only while it runs its own, and only that session: dsh's own compactions keep its step")
  own.dispose()
  assert.equal(engine.summarize, original)
  assert.equal(ownSummaries({ async compactRegion() { return { shadowedSeqs: [] } } }), undefined, 'no summarize step: nothing to answer')
})

/** A span as dsh replays it to the summarize step: the system prompt, then the conversation. */
const replayed = (said: string) => ({
  tools: [{ name: 'history_search', description: '查以前的对话', parameters: {} }],
  messages: [
    { role: 'system', id: 'm0', source: { kind: 'system-prompt' }, content: [{ type: 'text', text: '你是多游戏助手。'.repeat(500) }] },
    { role: 'user', id: 'm1', source: { kind: 'user' }, content: [{ type: 'text', text: said }] },
    { role: 'user', id: 'm1a', source: { kind: 'runtime-context', form: 'instructions' }, content: [{ type: 'text', text: '工作目录、可用的技能……'.repeat(300) }] },
    { role: 'assistant', id: 'm2', source: { kind: 'model' }, content: [{ type: 'reasoning', text: '想一想'.repeat(1000) }, { type: 'tool-call', id: 'c1', name: 'history_search', arguments: '{"query":"MAA"}' }] },
    { role: 'tool', id: 'm3', source: { kind: 'tool' }, toolCallId: 'c1', content: [{ type: 'text', text: '没有找到' }] },
    { role: 'assistant', id: 'm4', source: { kind: 'model' }, content: [{ type: 'text', text: '好的，每天 04:00 跑。' }] },
  ],
}) as never

/** The agent as dsh hands it to the summarize step: the model its last request went to. */
const summarizing = (route: { provider?: string; model?: string } = { provider: 'deepseek', model: 'deepseek-chat' }, options: { provider?: string; model?: string } = {}) => ({
  session: { id: 's1', requestHeader: () => ({ config: route }), toolHistory: () => ({ tools: [], updates: [] }) },
  options,
})

/** dsh's llm service answering with `chunks`, keeping what it was asked. */
function fakeLlm(chunks: readonly unknown[]) {
  const requests: GenerateOptions[] = []
  return {
    requests,
    async *stream(options: GenerateOptions) {
      requests.push(options)
      yield* chunks as never[]
    },
  }
}

test('the summary is asked for as dsh asks for its own: the span replayed for the prompt cache, then one instruction, in Chinese', async () => {
  const llm = fakeLlm([
    { type: 'block-start', index: 0, blockType: 'reasoning' },
    { type: 'reasoning-delta', index: 0, text: '用户要每天跑日常。' },
    { type: 'block-start', index: 1, blockType: 'text' },
    { type: 'text-delta', index: 1, text: '### 定下的事\n' },
    { type: 'text-delta', index: 1, text: '- 明日方舟日常每天 04:00 跑' },
    { type: 'usage', usage: { inputTokens: 40, outputTokens: 30, cacheReadTokens: 3000 } },
    { type: 'finish', reason: { kind: 'stop' } },
  ])
  const input = replayed('明日方舟的日常每天 4 点帮我跑一下')
  const abort = new AbortController().signal
  const result = await summarizeSpan(llm, { summarizationProvider: '', summarizationModel: '', maxTokens: 8192, modelPolicies: [] }, input, summarizing(), abort)
  assert.deepEqual(result, {
    summary: [{ type: 'text', text: '### 定下的事\n- 明日方舟日常每天 04:00 跑' }],
    rawOutput: [{ type: 'reasoning', text: '用户要每天跑日常。' }, { type: 'text', text: '### 定下的事\n- 明日方舟日常每天 04:00 跑' }],
    llmStreamCall: true,
    provider: 'deepseek',
    model: 'deepseek-chat',
    maxTokens: 8192,
    usage: { inputTokens: 40, outputTokens: 30, cacheReadTokens: 3000 },
  })
  const [request] = llm.requests
  assert.equal(llm.requests.length, 1, 'one call')
  const { messages, tools } = input as unknown as { messages: unknown[]; tools: unknown[] }
  assert.deepEqual(request!.messages.slice(0, -1), messages, 'the span exactly as dsh replays it, so the provider reuses its cache')
  assert.deepEqual(request!.tools, tools)
  assert.deepEqual(request!.toolHistory, { tools: [], updates: [] })
  assert.equal(request!.purpose, 'compaction')
  assert.equal(request!.sessionId, 's1')
  assert.equal(request!.signal, abort)
  const instruction = request!.messages.at(-1)!
  assert.equal(instruction.role, 'user')
  const text = (instruction.content[0] as { text: string }).text
  assert.equal(text, summaryInstruction(150), 'a short span: the shortest budget')
  assert.match(text, /用这段对话本身的语言写/)
  assert.match(text, /没有内容的类整个省掉/)
  assert.doesNotMatch(text, /English/)
})

test("a block the stream ends whole stands over its pieces; the answer's tool calls are kept in the record but are no summary", async () => {
  const { blocks } = await assemble((async function* () {
    yield { type: 'text-delta', index: 0, text: '半句' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: '整句话。' } }
    yield { type: 'text-delta', index: 0, text: '迟到的' }
    yield { type: 'tool-call-delta', index: 1, id: 'c9', name: 'history_search', argumentsDelta: '{"query":' }
    yield { type: 'tool-call-delta', index: 1, id: 'c9', argumentsDelta: '"x"}' }
  })() as never)
  assert.deepEqual(blocks, [{ type: 'text', text: '整句话。' }, { type: 'tool-call', id: 'c9', name: 'history_search', arguments: '{"query":"x"}' }])
})

test("a summary call fails as dsh's does: the llm's error with its code, an answer cut off at the cap, no words", async () => {
  const policy = { maxTokens: 100 }
  const run = (chunks: readonly unknown[]) => summarizeSpan(fakeLlm(chunks), policy, replayed('你好'), summarizing())
  await assert.rejects(run([{ type: 'finish', reason: { kind: 'error', failure: { message: 'rate limited', code: 'RATE_LIMITED', status: 429 } } }]), (error: unknown) => error instanceof SummaryError && error.code === 'RATE_LIMITED' && error.failure?.status === 429 && error.message === 'rate limited')
  await assert.rejects(run([{ type: 'text-delta', index: 0, text: '写到一半' }, { type: 'finish', reason: { kind: 'max-tokens' } }]), { code: 'MAX_TOKENS' })
  await assert.rejects(run([{ type: 'reasoning-delta', index: 0, text: '只想不写' }, { type: 'text-delta', index: 1, text: '  \n' }]), { code: 'EMPTY_SUMMARY' })
})

test('the summarizing model is chosen as dsh chooses it: one set for this model, one set for all, else the conversation’s own', () => {
  const policy = {
    summarizationProvider: '',
    summarizationModel: '',
    maxTokens: 65536,
    modelPolicies: [{ provider: 'deepseek', model: 'deepseek-reasoner', summarizationProvider: 'deepseek', summarizationModel: 'deepseek-chat', maxTokens: 4096 }],
  }
  assert.deepEqual(summaryTarget(policy, summarizing()), { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 65536 }, 'the model the conversation last used')
  assert.deepEqual(summaryTarget(policy, summarizing({ provider: 'deepseek', model: 'deepseek-reasoner' })), { provider: 'deepseek', model: 'deepseek-chat', maxTokens: 4096 }, "that model's own policy")
  assert.deepEqual(summaryTarget({ ...policy, summarizationProvider: 'kimi', summarizationModel: 'k2' }, summarizing()), { provider: 'kimi', model: 'k2', maxTokens: 65536 }, 'a summarizer for all')
  assert.deepEqual(summaryTarget(undefined, summarizing({}, { provider: 'deepseek', model: 'deepseek-chat' })), { provider: 'deepseek', model: 'deepseek-chat' }, 'no request yet: the agent’s model')
  assert.throws(() => summaryTarget(undefined, summarizing({})), /no provider\/model/)
})

test("the summary may run to about a fifth of what it condenses, from a few lines to a page; the system prompt, the harness's notes and reasoning do not count", () => {
  const said = 100 + 'history_search'.length + '{"query":"MAA"}'.length + '没有找到'.length + '好的，每天 04:00 跑。'.length
  assert.equal(spanChars(replayed('一'.repeat(100))), said)
  const earlier = { role: 'user', id: 'm9', source: { kind: 'compact-checkpoint', compactionId: 'c' }, content: [{ type: 'text', text: '旧摘要' }] }
  const { messages } = replayed('一'.repeat(100)) as unknown as { messages: unknown[] }
  assert.equal(spanChars({ messages: [messages[0], earlier, ...messages.slice(1)] } as never), said + 3, 'an earlier summary in the span is condensed again')
  assert.equal(summaryBudget(0), 150)
  assert.equal(summaryBudget(5000), 1000)
  assert.equal(summaryBudget(1_000_000), 2000)
  assert.match(summaryInstruction(1000), /最多约 1000 字/)
})

test("at the end of a task the span is summarized by the app's step, the archive pointer by none, and dsh's own compaction keeps its template", async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-low-context-summary-'))
  const file = join(dir, 'compaction.json')
  writeFileSync(file, JSON.stringify({ auto: true, threshold: 80, lowContext: true, archiveDays: 7 }))
  const now = Date.now()
  const l = log()
  const old = l.say(now - 10 * DAY)
  const s1 = l.summary(now - 9 * DAY, old, '旧要点')
  const aged = l.say(now - 30 * HOUR)
  const today = l.say(now - HOUR)
  const view = { ...l.view([l.system, s1, ...aged, ...today]), requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }), toolHistory: () => ({ tools: [], updates: [] }) }
  const llm = fakeLlm([{ type: 'text-delta', index: 0, text: '### 定下的事\n- 每天 04:00 跑明日方舟日常' }, { type: 'finish', reason: { kind: 'stop' } }])
  const written: string[] = []
  const engine = {
    config: { summarizationProvider: '', summarizationModel: '', maxTokens: 65536, modelPolicies: [] },
    async summarize() { return { summary: [{ type: 'text', text: '## Primary Request and Intent' }], provider: 'deepseek', model: 'deepseek-chat' } },
    async compactRegion(start: number, end: number, agent: unknown) {
      const result = await (this as unknown as { summarize(input: unknown, agent: unknown): Promise<{ summary: { text: string }[] }> }).summarize(replayed('明日方舟日常每天 4 点跑'), agent)
      written.push(`${start}-${end}:${result.summary.map(block => block.text).join('')}`)
      return { shadowedSeqs: [start, end] }
    },
  }
  let stopping: ((event: { agent: StoppingAgent; signal: AbortSignal }) => Promise<void>) | undefined
  let disposeOwn: (() => void) | undefined
  const warnings: string[] = []
  const ctx = {
    logger: () => ({ info: () => {}, warn: (text: string) => warnings.push(text) }),
    compaction: engine,
    effect: (run: () => () => void) => { disposeOwn = run() },
    get: (name: string) => (name === 'llm' ? llm : undefined),
    on: (name: string, handler: typeof stopping) => { if (name === 'agent/turn-stopping') stopping = handler },
  }
  const dshStep = engine.summarize
  apply(ctx as never, { file })
  const agent = { session: view, inbox: {} } as unknown as StoppingAgent
  await stopping!({ agent, signal: new AbortController().signal })
  assert.deepEqual(warnings, [])
  assert.equal(llm.requests.length, 1, 'one model call: the pointer needs none')
  assert.equal(written[0], `${aged[0]}-${aged[1]}:### 定下的事\n- 每天 04:00 跑明日方舟日常`, "the aged day, in the app's words")
  assert.ok(written[1]!.startsWith(`${s1}-${s1}:${ARCHIVE_MARK}`), 'the old summary, archived behind the pointer')
  await engine.compactRegion(1, 2, agent)
  assert.equal(written[2], '1-2:## Primary Request and Intent', "dsh's own compaction (the context filling up mid-task) keeps its step")
  disposeOwn!()
  assert.equal(engine.summarize, dshStep, 'its own step put back')
})

test('archived summaries are kept in summaries.jsonl and read back once each, a broken line aside', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'adg-summaries-')), 'summaries.jsonl')
  const read = summariesReader(file)
  assert.deepEqual(await read(), [], 'none yet')
  const cover = { from: 1, to: 2, firstSeq: 3, lastSeq: 4 }
  await keepSummaries(file, 's1', [{ seq: 10, text: '要点 A', cover }, { seq: 11, text: '要点 B', cover }], 99)
  await keepSummaries(file, 's1', [{ seq: 10, text: '要点 A', cover }], 100)
  appendFileSync(file, '{"cut short\n')
  const rows = await read()
  assert.deepEqual(rows.map(r => [r.sessionId, r.seq, r.text]), [['s1', 10, '要点 A'], ['s1', 11, '要点 B']])
  assert.equal(rows[0]!.archivedAt, 100, 'kept twice (a failed compaction tried again): the last copy')
})

test('a span is priced as dsh prices it, through its token meter; a refusal for size is told from other failures', () => {
  const view = session([{ at: NOW - 30 * HOUR }, { at: NOW - HOUR }])
  const meter = { measure: () => ({ nodes: view.surface.nodes.map(seq => ({ seq, tokens: 10 })) }) }
  const range = lowContextRange(view, { now: NOW })!
  assert.equal(spanTokens(meter, view, range), 60, 'the six nodes of the first turn')
  assert.equal(spanTokens(undefined, view, range), undefined, 'no meter: cannot tell')
  assert.equal(spanTokens({ measure: () => { throw new Error('busy') } }, view, range), undefined)
  assert.equal(spanTokens(meter, view, { start: 9999, end: range.end }), undefined, 'not on the surface')
  assert.equal(refusedForSize(new Error('summary is not smaller than the shadowed content (896 estimated framed tokens >= 749)')), true)
  assert.equal(refusedForSize(new Error('wrapped', { cause: new Error('summary is not smaller than the shadowed content (1 >= 0)') })), true)
  assert.equal(refusedForSize(new Error('fetch failed')), false)
  const refusals = new Refusals()
  refusals.add('s1', 'compact', { start: 1, end: 5 })
  assert.equal(refusals.has('s1', 'compact', { start: 1, end: 5 }), true)
  assert.equal(refusals.has('s1', 'compact', { start: 1, end: 9 }), false, 'the span grew: it is tried again')
  assert.equal(refusals.has('s1', 'archive', { start: 1, end: 5 }), false)
  assert.equal(refusals.has('s2', 'compact', { start: 1, end: 5 }), false)
})

test('a pointer to a stretch within one minute names that minute once', () => {
  const at = Date.parse('2026-11-13T09:30:00Z')
  const text = pointerText({ from: at, to: at + 20_000, firstSeq: 8, lastSeq: 42 })
  assert.doesNotMatch(text, / 到 /)
  assert.match(pointerText({ from: at, to: at + 3 * HOUR, firstSeq: 8, lastSeq: 42 }), / 到 /)
})

test('at the end of a task, a span too small to condense waits, and one dsh refused is not summarized again for nothing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'adg-low-context-apply-'))
  const file = join(dir, 'compaction.json')
  writeFileSync(file, JSON.stringify({ auto: true, threshold: 80, lowContext: true }))
  const now = Date.now()
  const view = session([{ at: now - 30 * HOUR }, { at: now - HOUR }])
  let tokens = 50
  let failure: Error | undefined
  const calls: string[] = []
  const warnings: string[] = []
  let stopping: ((event: { agent: StoppingAgent; signal: AbortSignal }) => Promise<void>) | undefined
  const ctx = {
    logger: () => ({ info: () => {}, warn: (text: string) => warnings.push(text) }),
    compaction: {
      async compactRegion(start: number, end: number) {
        calls.push(`${start}-${end}`)
        if (failure !== undefined) throw failure
        return { shadowedSeqs: [start, end] }
      },
    },
    effect: () => {},
    get: (name: string) => (name === 'tokenMeter' ? { measure: () => ({ nodes: view.surface.nodes.map(seq => ({ seq, tokens })) }) } : undefined),
    on: (name: string, handler: typeof stopping) => { if (name === 'agent/turn-stopping') stopping = handler },
  }
  apply(ctx as never, { file })
  const end = () => stopping!({ agent: { session: view, inbox: {} }, signal: new AbortController().signal })
  await end()
  assert.ok(6 * tokens < MIN_SPAN_TOKENS)
  assert.deepEqual(calls, [], `${6 * tokens} tokens: below ${MIN_SPAN_TOKENS}, left word for word`)
  tokens = 1000
  failure = new Error('summary is not smaller than the shadowed content (6100 estimated framed tokens >= 6000)')
  await end()
  await end()
  assert.equal(calls.length, 1, 'refused for size once: the same span is not tried again')
  assert.match(warnings.join('\n'), /not smaller/)
  failure = new Error('fetch failed')
  const fresh = session([{ at: now - 40 * HOUR }, { at: now - 30 * HOUR }, { at: now - HOUR }])
  const freshEnd = () => stopping!({ agent: { session: fresh, inbox: {} }, signal: new AbortController().signal })
  const before = calls.length
  await freshEnd()
  await freshEnd()
  assert.equal(calls.length - before, 2, 'another failure is tried again at the next task end')
})
