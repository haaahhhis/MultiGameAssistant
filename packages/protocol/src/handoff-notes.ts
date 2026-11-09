/**
 * The first line of a message one agent's conversation receives from
 * somewhere other than the person typing in it (docs/design/agent-roles.md
 * §10): work handed to it (`（监控交给你的事：…）`), or the reply to work it
 * handed on (`（「干预」交回了…）`). The agent reads them as context; the UI
 * reads the same line to draw the message as what it is.
 *
 * ONE DECLARATION, READ FROM BOTH SIDES: a rewording here changes the server
 * and the UI together.
 */

/** Who stands for the person when they clicked something in the app (读取游戏, 安装脚本). */
export const BY_YOU = '你'

/**
 * 助手's whole answer to a reply that came back when there is nothing the
 * person needs to hear: the UI shows it as a quiet line, chat channels
 * (Feishu) get nothing.
 */
export const QUIET = '（不用告诉用户）'

/** A reply that is only `QUIET` (give or take a full stop and spaces). */
export function isQuiet(text: string): boolean {
  return text.replace(/[。.\s]/g, '') === QUIET
}

const RETURNS = '（做完后你这一轮的最后一段回复会原样交回去：把结论写在那里。）'

const THREAD_LINE = /^（这件事的线索是 (\S+)：做的过程中要问清楚什么，用 agent_message 问，thread 填它；不要猜。）$/

/**
 * What an agent is handed: its note, then the work. `returns`: its reply goes
 * back to whoever asked; `thread`: where the two can go on talking about it.
 */
export function taskMessage(by: string, title: string, body: string, returns = false, thread?: string): string {
  const head = by === BY_YOU ? `（你在软件里点的：${oneLine(title)}）` : `（${by}交给你的事：${oneLine(title)}）`
  const notes = [...(returns ? [RETURNS] : []), ...(thread === undefined ? [] : [`（这件事的线索是 ${thread}：做的过程中要问清楚什么，用 agent_message 问，thread 填它；不要猜。）`])]
  return `${head}\n${notes.map(n => `${n}\n`).join('')}\n${body}`
}

export interface TaskNote {
  readonly by: string
  readonly title: string
  readonly returns: boolean
  readonly thread?: string
  readonly body: string
}

export function parseTask(text: string): TaskNote | undefined {
  const [first = '', ...rest] = text.split('\n')
  const mine = /^（你在软件里点的：(.*)）$/.exec(first)
  const theirs = mine === null ? /^（([^（）：]{1,20})交给你的事：(.*)）$/.exec(first) : null
  if (mine === null && theirs === null) return undefined
  const returns = rest[0] === RETURNS
  const after = returns ? rest.slice(1) : rest
  const thread = THREAD_LINE.exec(after[0] ?? '')?.[1]
  return {
    by: mine !== null ? BY_YOU : theirs![1]!,
    title: mine !== null ? mine[1]! : theirs![2]!,
    returns,
    ...(thread === undefined ? {} : { thread }),
    body: (thread === undefined ? after : after.slice(1)).join('\n').trim(),
  }
}

export interface ThreadNote {
  readonly from: string
  readonly kind: 'question' | 'answer'
  readonly thread: string
  readonly title: string
  readonly text: string
}

const THREAD_WORDS = { question: '问你', answer: '回答了你' } as const

/**
 * Something said in a thread while the work goes on: a question, or the answer
 * to one. A reply can be just the agent's next words, so a model that forgets
 * the tool still answers.
 */
export function threadMessage(input: { from: string; kind: 'question' | 'answer'; thread: string; title: string; text: string }): string {
  const head = `（「${input.from}」在线索 ${input.thread} 里${THREAD_WORDS[input.kind]}：${oneLine(input.title)}）`
  const tail = input.kind === 'question'
    ? `（用 agent_message 回答：thread 填 ${input.thread}，kind 填 answer。你这一轮的最后一段回复也算回答。要等用户决定的话，先用 kind: update 说一声，等有了结果再回答。）`
    : '（接着做这件事。）'
  return `${head}\n\n${input.text.trim()}\n\n${tail}`
}

export function parseThreadNote(text: string): ThreadNote | undefined {
  const [first = '', ...rest] = text.split('\n')
  const head = /^（「([^」]+)」在线索 (\S+) 里(问你|回答了你)：(.*)）$/.exec(first)
  if (head === null) return undefined
  const body = rest.join('\n').trim()
  const end = body.lastIndexOf('\n\n（')
  return { from: head[1]!, thread: head[2]!, kind: head[3] === '问你' ? 'question' : 'answer', title: head[4]!, text: (end === -1 ? body : body.slice(0, end)).trim() }
}

/**
 * What comes back to the conversation that asked: the agent's reply (or why
 * it did not finish), and what to do with it.
 * @param asker - who asked, as the receiving agent knows them: `你` for its own call, else 监控, 定时.
 * @param consulted - the other agents it asked along the way, for 助手, which is not woken for what leads say to each other.
 * @param toLead - it goes to a lead agent working on something: that goes on, and telling the person is not its part.
 */
export function relayMessage(input: { agent: string; asker: string; title: string; ok: boolean; reply: string; consulted?: readonly string[]; toLead?: boolean }): string {
  const head = `（「${input.agent}」${input.ok ? '交回了' : '没有做完'}${input.asker}交给它的事：${oneLine(input.title)}）`
  const tail = input.toLead === true
    ? (input.ok ? '（这是你问它的结果：接着做你手上的事，把它用到你的结论里。）' : '（它没做成：接着做你手上的事，能绕过去就绕过去，绕不过去就在你的结论里说清楚。）')
    : input.ok
      ? `（看情况告诉用户：有用户该知道或要做的，用一两句话说要点，完整过程在「${input.agent}」的对话里；没有的话整段回复只写「${QUIET}」。还要别的 agent 接着做的，可以再交。）`
      : `（告诉用户哪里没做成、为什么；需要的话换个说法再交一次，或者问用户。）`
  const asked = input.consulted !== undefined && input.consulted.length > 0 ? `\n\n（做这件事时它还问了：${input.consulted.join('、')}。）` : ''
  return `${head}\n\n${input.reply.trim()}${asked}\n\n${tail}`
}

export interface RelayNote {
  readonly agent: string
  readonly asker: string
  readonly title: string
  readonly ok: boolean
  readonly reply: string
}

export function parseRelay(text: string): RelayNote | undefined {
  const [first = '', ...rest] = text.split('\n')
  const head = /^（「([^」]+)」(交回了|没有做完)([^（）]{1,20}?)交给它的事：(.*)）$/.exec(first)
  if (head === null) return undefined
  const body = rest.join('\n').trim()
  const end = body.lastIndexOf('\n\n（')
  return { agent: head[1]!, ok: head[2] === '交回了', asker: head[3]!, title: head[4]!, reply: (end === -1 ? body : body.slice(0, end)).trim() }
}

function oneLine(text: string): string {
  return text.replace(/\s+/g, ' ').replace(/[（）]/g, m => (m === '（' ? '(' : ')')).trim()
}

/**
 * A reminder 助手 set for itself (dsh's schedule_create), as dsh delivers it
 * when due: `[SCHEDULE REMINDER]` with one prompt, or a batch of recurring
 * ones. @returns what each was for, in order; undefined for any other message.
 */
export function reminderPrompts(text: string): string[] | undefined {
  const single = /^\[SCHEDULE REMINDER\]\n[\s\S]*?^reminder_prompt_json: (.*)$/m.exec(text)
  if (single !== null) return [jsonString(single[1]!)]
  const batch = /^\[SCHEDULE REMINDER BATCH\]\n[\s\S]*?^reminders_json: (.*)$/m.exec(text)
  if (batch === null) return undefined
  try {
    const items = JSON.parse(batch[1]!) as { reminder_prompt?: unknown }[]
    return items.map(item => String(item.reminder_prompt ?? '')).filter(p => p !== '')
  } catch {
    return []
  }
}

/** A reminder's line, the same in the app and the chat apps. */
export function reminderLine(prompts: readonly string[]): string {
  return prompts.length === 0 ? '定时提醒' : `定时提醒：${prompts.map(p => oneLine(p)).join('；')}`
}

function jsonString(json: string): string {
  try {
    const value = JSON.parse(json) as unknown
    return typeof value === 'string' ? value : json
  } catch {
    return json
  }
}
