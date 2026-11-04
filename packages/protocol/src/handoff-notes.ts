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

const RETURNS = '（做完后你这一轮的最后一段回复会原样交回去：把结论写在那里。）'

/** What an agent is handed: its note, then the work. `returns`: its reply goes back to whoever asked. */
export function taskMessage(by: string, title: string, body: string, returns = false): string {
  const head = by === BY_YOU ? `（你在软件里点的：${oneLine(title)}）` : `（${by}交给你的事：${oneLine(title)}）`
  return `${head}\n${returns ? `${RETURNS}\n` : ''}\n${body}`
}

export interface TaskNote {
  readonly by: string
  readonly title: string
  readonly returns: boolean
  readonly body: string
}

export function parseTask(text: string): TaskNote | undefined {
  const [first = '', ...rest] = text.split('\n')
  const mine = /^（你在软件里点的：(.*)）$/.exec(first)
  const theirs = mine === null ? /^（([^（）：]{1,20})交给你的事：(.*)）$/.exec(first) : null
  if (mine === null && theirs === null) return undefined
  const returns = rest[0] === RETURNS
  return {
    by: mine !== null ? BY_YOU : theirs![1]!,
    title: mine !== null ? mine[1]! : theirs![2]!,
    returns,
    body: (returns ? rest.slice(1) : rest).join('\n').trim(),
  }
}

/**
 * What comes back to the conversation that asked: the agent's reply (or why
 * it did not finish), and what to do with it.
 * @param asker - who asked, as the receiving agent knows them: `你` for its own call, else 监控, 定时.
 */
export function relayMessage(input: { agent: string; asker: string; title: string; ok: boolean; reply: string }): string {
  const head = `（「${input.agent}」${input.ok ? '交回了' : '没有做完'}${input.asker}交给它的事：${oneLine(input.title)}）`
  const tail = input.ok
    ? `（用一两句话把要点告诉用户；完整过程在「${input.agent}」的对话里。还要别的 agent 接着做的，可以再交。）`
    : `（告诉用户哪里没做成、为什么；需要的话换个说法再交一次，或者问用户。）`
  return `${head}\n\n${input.reply.trim()}\n\n${tail}`
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
