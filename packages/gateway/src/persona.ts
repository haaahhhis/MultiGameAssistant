/**
 * The reply style the user picked (persona@1), kept in `<dataDir>/persona.json`:
 * one for all agents, and what an agent has of its own. It becomes one
 * system-prompt section for each agent. Only the voice changes: the section
 * says so, so a playful persona does not loosen the rules (approvals, no
 * passwords, no spending), and the app's fixed marks stay as they are.
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { z } from 'zod'
import { Persona, PersonaSettings, QUIET, type PersonaOverride, type PersonaStyle } from '@adg/protocol'

export const STYLE_TEXT: Readonly<Record<PersonaStyle, string>> = {
  default: '',
  concise: '回答简短直接：先给结论，再给必要的细节；少寒暄，不用表情。',
  patient: '耐心、讲清楚：每一步说明为什么这么做，用对方听得懂的话，像教一个刚接触的人。',
  lively: '语气轻松活泼，可以用一点语气词和表情，但信息要准确、不啰嗦。',
  buddy: '像一起玩游戏的老朋友那样说话：熟悉游戏里的说法，可以适当吐槽和鼓励，但不夸张、不油腻。',
  butler: '像一位稳重周到的管家：礼貌、条理清楚，主动汇报进度和需要对方决定的事。',
}

export const DEFAULT_PERSONA: PersonaSettings = { persona: { style: 'default' }, agents: {} }

/** Where the agent works and what the app is called, for every agent: "本软件" means this. */
export const IDENTITY_PROMPT = [
  '# 本软件',
  '你在 MultiGameAssistant（多游戏助手）里工作：它帮用户安装和运行各个游戏的日常脚本、把脚本编成定时流水线、盯着运行出的问题、查游戏活动和进度，并通过飞书通知用户。',
  '用户说「这个软件」「本软件」「助手」指的就是 MultiGameAssistant。介绍自己时说你是 MultiGameAssistant 的 agent（用户在「回复风格」里给你起了名字就用那个名字）。',
  '',
  '# 时间',
  '对话里会插入以「Time sampled」或「（提醒）」开头的消息，那是系统给的时间信息，不是用户说的话，不用回应它。',
  '对话里较早提到的事（待办、没回答的问题、脚本和流水线的状态、活动信息）可能早就过时了：先用工具查现在的情况再说；查不到又必须问时，说明是哪天的事。不要把早就过去的问题当成刚发生的来追问。',
  '',
  '# 技能',
  '每个脚本、每个游戏的专属技能只给正在处理它的会话用：开始操作、分析、诊断或编排某个脚本，或查看某个游戏之前，先用 skill_focus 说明是哪个（几个一起处理就一起写），它们的技能才会出现在技能列表里；换到别的脚本或游戏时再调用一次。不要把一个脚本或游戏的技能套用到另一个上。',
  '',
  '# 先用脚本，再用自己的能力',
  '用户要在游戏里做一件事（刷关卡、清体力、领奖励和邮件、做日常周常、收基建、兑换商店、打活动……）时，按这个顺序：',
  '1. 先看这个游戏下装了哪些脚本（script_list），再看它们有没有做这件事的任务或选项（script_tasks；说不清时看脚本的技能、script_help）。',
  '2. 脚本能做，就用脚本做：运行它对应的任务（script_run，需要时先改这次要用的配置）。不要自己截图、点屏幕去做脚本能做的事。你自己不能运行脚本的，交给能运行的同事（「脚本」agent），把要跑哪个脚本的哪个任务写清楚。',
  '3. 只有确认脚本做不了，才用你自己的能力（截图点击、命令行）去做：装着的脚本都没有这个功能；或者脚本跑了失败、修不好。动手前用一句话告诉用户为什么不用脚本。',
  '4. 有能做这件事的脚本但还没装：先告诉用户是哪个脚本、问要不要装，不要不问就自己点。',
].join('\n')

/** How one agent talks: its own where it has any, else what is set for all. */
export function personaOf(settings: PersonaSettings, agentId: string): Persona & { name?: string } {
  const own = Object.entries(settings.agents[agentId] ?? {}).filter(([, value]) => value !== undefined)
  return { ...settings.persona, ...Object.fromEntries(own) }
}

/** The system-prompt text for a persona; empty when nothing is set. */
export function personaPrompt(p: Persona & { name?: string | undefined }): string {
  const lines: string[] = []
  if (p.name !== undefined && p.name.trim() !== '') lines.push(`你的名字是「${p.name.trim()}」，自称时用这个名字。`)
  if (p.callUser !== undefined && p.callUser.trim() !== '') lines.push(`称呼用户为「${p.callUser.trim()}」。`)
  if (STYLE_TEXT[p.style] !== '') lines.push(STYLE_TEXT[p.style])
  if (p.custom !== undefined && p.custom.trim() !== '') lines.push(`用户对你说话方式的要求：${p.custom.trim()}`)
  if (lines.length === 0) return ''
  lines.push(p.peerStyle === 'same'
    ? '和其他 agent 说话时也用这个方式。'
    : '上面是对用户说话的方式。和其他 agent 说话（agent_delegate、agent_message、交回去的结论）用平实的话，直接说事，不用人设和称呼：它们要读的是内容。')
  lines.push(`软件约定的固定写法（比如「${QUIET}」这一句、线索编号、工具的参数）一字不差照写，不加语气词和表情。`)
  return ['# 回复风格', ...lines, '这些只影响你说话的方式，不改变做事的规则：确认、安全限制和不能做的事都照旧；在飞书里回复也一样。'].join('\n')
}

/** Blank fields are dropped, spaces trimmed: what is left out follows what is set for all. */
function cleanFields<T extends PersonaOverride>(p: T): PersonaOverride {
  return {
    ...(p.style === undefined ? {} : { style: p.style }),
    ...(p.name?.trim() ? { name: p.name.trim() } : {}),
    ...(p.callUser?.trim() ? { callUser: p.callUser.trim() } : {}),
    ...(p.custom?.trim() ? { custom: p.custom.trim() } : {}),
    ...(p.peerStyle === undefined ? {} : { peerStyle: p.peerStyle }),
  }
}

function clean(settings: PersonaSettings): PersonaSettings {
  const { name: _name, ...rest } = cleanFields(settings.persona)
  const agents = Object.entries(settings.agents).map(([id, own]) => [id, cleanFields(own)] as const).filter(([, own]) => Object.keys(own).length > 0)
  return { persona: { ...rest, style: settings.persona.style }, agents: Object.fromEntries(agents) }
}

/**
 * What the file holds. Before agents had their own it held one persona, whose
 * name only 助手 ever used: that name is 助手's now.
 */
function parseFile(raw: unknown): PersonaSettings | undefined {
  const now = PersonaSettings.safeParse(raw)
  if (now.success) return clean(now.data)
  const old = Persona.extend({ name: z.string().optional() }).safeParse(raw)
  if (!old.success) return undefined
  const { name, ...persona } = old.data
  return clean({ persona, agents: name === undefined ? {} : { main: { name } } })
}

export class PersonaStore {
  readonly #file: string
  #current: PersonaSettings = DEFAULT_PERSONA

  constructor(dataDir: string) {
    this.#file = join(dataDir, 'persona.json')
  }

  get current(): PersonaSettings {
    return this.#current
  }

  of(agentId: string): Persona & { name?: string } {
    return personaOf(this.#current, agentId)
  }

  async load(): Promise<void> {
    try {
      this.#current = parseFile(JSON.parse(await readFile(this.#file, 'utf8'))) ?? DEFAULT_PERSONA
    } catch { /* not set yet */ }
  }

  async set(settings: PersonaSettings): Promise<PersonaSettings> {
    const next = clean(settings)
    await mkdir(join(this.#file, '..'), { recursive: true })
    await writeFile(`${this.#file}.tmp`, `${JSON.stringify(next, null, 2)}\n`)
    await rename(`${this.#file}.tmp`, this.#file)
    this.#current = next
    return next
  }
}
