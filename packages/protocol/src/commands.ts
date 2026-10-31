/**
 * Slash commands: a message (or a pipeline's agent step) that starts with
 * `/word` is sent as a full, careful instruction. `word` is one of the app's
 * commands (keep what was just done as a skill, look up game news, plan
 * scripts into a pipeline, find out why a script failed) or the name of one
 * of the agent's skills, which the agent then loads before acting. The
 * message keeps the typed line first, so the conversation shows what was
 * asked; the expansion follows after a blank line.
 *
 * A few commands are the app's own and never reach the model (`local`):
 * `/压缩` compacts the conversation it is typed in.
 */

export const SAVE_SKILL_PROMPT = [
  '把这次走通的做法保存成技能（用 skill_save），让下次同样的事可以直接照着做、少调用模型。要求：',
  '- 只写最后成功的路径，不写失败的尝试和闲聊；',
  '- 写清楚适用场景（用户会怎么说）、一步一步的操作（用到的工具、命令、路径、参数照实写，会变的写成「把 X 换成…」）、怎样算成功、注意事项和踩过的坑；',
  '- 名字用简短的英文小写加短横线，description 一两句话说清楚做什么、什么时候用；',
  '- 保存后告诉我技能名，以及以后我说什么时会用到它。',
].join('\n')

export interface SlashCommand {
  /** Typed after the slash. */
  readonly name: string
  /** Also accepted. */
  readonly aliases: readonly string[]
  readonly title: string
  /** What may follow the command, for the hint. */
  readonly arg?: string
  readonly expand: (arg: string) => string
  /** Done by the app itself in an open conversation, not sent to the model. */
  readonly local?: 'compact'
}

export const COMMANDS: readonly SlashCommand[] = [
  {
    name: '技能',
    aliases: ['skill'],
    title: '把刚才走通的做法存成技能，下次少调用模型',
    expand: () => SAVE_SKILL_PROMPT,
  },
  {
    name: '资讯',
    aliases: ['news'],
    title: '上网查游戏资讯：活动、版本、维护公告',
    arg: '游戏名（可选，不写就查游戏页上的游戏）',
    expand: arg => [
      `上网查${arg === '' ? '我游戏页上的游戏' : `「${arg}」`}最近的资讯，按技能 web-reading：`,
      '1. 先 game_list、game_activities 看日历里已经有什么，不重复查；',
      '2. 先用公开 API（SRA 公共 API、Wiki 的 api.php），没有再读官网公告列表页，只打开最近的活动、版本和维护公告；',
      '3. 查到起止时间的活动用 game_record（source=site，写上 url）记进日历；',
      '4. 最后按游戏列一下：正在进行、快结束、即将开始的活动，和其他值得知道的消息（新版本、维护、福利、兑换码）。',
    ].join('\n'),
  },
  {
    name: '编排',
    aliases: ['plan', 'pipeline'],
    title: '把脚本编成流水线（先起草，我确认后才生效）',
    arg: '想做什么（可选，例如「每天早上跑完三个游戏的日常」）',
    expand: arg => [
      `帮我把脚本编排成流水线：${arg === '' ? '把我装好的各个脚本的日常任务排成每天能自动跑的流程' : arg}。按技能 pipeline-planning：`,
      '1. 先 system_info 看电脑配置（能不能同时跑几个游戏），pipeline_list 看已有的流水线，script_tasks 看各脚本有哪些任务；',
      '2. 用 pipeline_draft 起草（草稿，我在「编排」页保存后才会按定时运行）：模拟器和前台脚本能并行的并行，失败不要挡住别的；',
      '3. 说清楚为什么这样排、哪些步骤并行、估计多久、建议定在几点跑。',
    ].join('\n'),
  },
  {
    name: '诊断',
    aliases: ['diagnose', 'why'],
    title: '分析脚本为什么失败，给出怎么改的建议',
    arg: '脚本名或运行 id（可选，不写就看最近失败的）',
    expand: arg => [
      `分析${arg === '' ? '最近失败的脚本运行' : `「${arg}」`}为什么失败：`,
      '1. 用 script_runs 找到失败的那次运行，script_run_log 看日志（先按错误级别筛，再看出错前后）；',
      '2. 对照这个脚本包的技能说明原因：是脚本本身、配置、游戏状态（更新、公告、掉线）、模拟器 / ADB，还是电脑环境；',
      '3. 给出怎么改：改哪项配置、游戏里要做什么、要不要重跑。先不要改任何东西、不要重跑，等我决定。',
    ].join('\n'),
  },
  {
    name: '压缩',
    aliases: ['compact'],
    title: '压缩这个对话：较早的部分换成摘要，agent 会忘掉其中的细节',
    expand: () => '',
    local: 'compact',
  },
]

/** The app's own command `text` runs (`/压缩`), or undefined for anything to send. */
export function localCommand(text: string): SlashCommand['local'] {
  const word = /^\/(\S+)/.exec(text.trim())?.[1]?.toLowerCase()
  return word === undefined ? undefined : COMMANDS.find(c => c.local !== undefined && (c.name === word || c.aliases.includes(word)))?.local
}

/** A skill as the slash menu needs it (protocol SkillInfo has more). */
export interface SlashSkill {
  readonly name: string
  readonly description: string
}

/** One entry of the slash menu. */
export type SlashOption =
  | { readonly kind: 'command'; readonly name: string; readonly description: string; readonly arg?: string; readonly command: SlashCommand }
  | { readonly kind: 'skill'; readonly name: string; readonly description: string }

/** The skill instruction that follows `/name request`. */
export function skillInstruction(name: string, request: string): string {
  return `使用技能「${name}」：先用 skill 工具加载它，再按它的说明做${request === '' ? '。' : `：${request}`}`
}

/**
 * The full message for what was typed: a command or a skill becomes the typed
 * line, a blank line and its instruction; anything else is left as it is.
 */
export function expandSlash(text: string, skills: readonly SlashSkill[]): string {
  const typed = text.trim()
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(typed)
  if (match === null) return typed
  const word = match[1]!
  const arg = (match[2] ?? '').trim()
  const command = COMMANDS.find(c => c.name === word.toLowerCase() || c.aliases.includes(word.toLowerCase()))
  if (command?.local !== undefined) return typed
  if (command !== undefined) return `${typed}\n\n${command.expand(arg)}`
  const skill = skills.find(s => s.name === word)
  return skill === undefined ? typed : `${typed}\n\n${skillInstruction(skill.name, arg)}`
}

/** A message sent by `expandSlash`: what was typed, and the instruction it carried. */
export function splitSlash(text: string): { typed: string; expansion: string } | undefined {
  if (!text.startsWith('/')) return undefined
  const at = text.indexOf('\n\n')
  return at < 0 ? undefined : { typed: text.slice(0, at), expansion: text.slice(at + 2) }
}

/**
 * Menu entries for what is typed after the slash (before any space): commands first, then skills; name starts first, then contains.
 * `inSession`: typed in an open conversation, so its own commands (`/压缩`) are offered too.
 */
export function slashOptions(text: string, skills: readonly SlashSkill[], inSession = false): SlashOption[] {
  const match = /^\/(\S*)$/.exec(text)
  if (match === null) return []
  const typed = match[1]!.toLowerCase()
  const commands: SlashOption[] = COMMANDS
    .filter(c => (inSession || c.local === undefined) && [c.name, ...c.aliases].some(n => n.toLowerCase().includes(typed)))
    .map(c => ({ kind: 'command', name: c.name, description: c.title, ...(c.arg === undefined ? {} : { arg: c.arg }), command: c }))
  const rank = (name: string) => (name.toLowerCase().startsWith(typed) ? 0 : 1)
  const found: SlashOption[] = skills
    .filter(s => s.name.toLowerCase().includes(typed) || (typed.length > 0 && s.description.toLowerCase().includes(typed)))
    .sort((a, b) => rank(a.name) - rank(b.name) || a.name.localeCompare(b.name))
    .map(s => ({ kind: 'skill', name: s.name, description: s.description }))
  return [...commands, ...found]
}
