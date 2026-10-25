/**
 * Slash commands in the chat box: short words that send the agent a full,
 * careful instruction — so the common jobs (keep what was just done as a
 * skill, look up game news, plan scripts into a pipeline, find out why a
 * script failed) are one word away and always asked the same good way.
 */
import { SAVE_SKILL_PROMPT } from '../plugins/chat/SkillOffer.tsx'

export interface SlashCommand {
  /** Typed after the slash. */
  readonly name: string
  /** Also accepted. */
  readonly aliases: readonly string[]
  readonly title: string
  /** What may follow the command, for the hint. */
  readonly arg?: string
  readonly expand: (arg: string) => string
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
]

/** The command a message starts with, and what follows it. */
export function parseCommand(text: string): { command: SlashCommand; arg: string } | undefined {
  const match = /^\/(\S+)(?:\s+([\s\S]*))?$/.exec(text.trim())
  if (match === null) return undefined
  const word = match[1]!.toLowerCase()
  const command = COMMANDS.find(c => c.name === word || c.aliases.includes(word))
  return command === undefined ? undefined : { command, arg: (match[2] ?? '').trim() }
}

/** Commands matching what is typed after the slash (before any space). */
export function suggest(text: string): SlashCommand[] {
  const match = /^\/(\S*)$/.exec(text)
  if (match === null) return []
  const typed = match[1]!.toLowerCase()
  return COMMANDS.filter(c => c.name.startsWith(typed) || c.aliases.some(a => a.startsWith(typed)))
}
