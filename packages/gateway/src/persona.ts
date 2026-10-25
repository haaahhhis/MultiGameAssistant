/**
 * The reply style the user picked (persona@1), kept in `<dataDir>/persona.json`
 * and turned into one system-prompt section for every agent. Only the voice
 * changes: the section says so, so a playful persona does not loosen the
 * rules (approvals, no passwords, no spending).
 */
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { Persona, type PersonaStyle } from '@adg/protocol'

export const STYLE_TEXT: Readonly<Record<PersonaStyle, string>> = {
  default: '',
  concise: '回答简短直接：先给结论，再给必要的细节；少寒暄，不用表情。',
  patient: '耐心、讲清楚：每一步说明为什么这么做，用对方听得懂的话，像教一个刚接触的人。',
  lively: '语气轻松活泼，可以用一点语气词和表情，但信息要准确、不啰嗦。',
  buddy: '像一起玩游戏的老朋友那样说话：熟悉游戏里的说法，可以适当吐槽和鼓励，但不夸张、不油腻。',
  butler: '像一位稳重周到的管家：礼貌、条理清楚，主动汇报进度和需要对方决定的事。',
}

export const DEFAULT_PERSONA: Persona = { style: 'default' }

/** Where the agent works and what the app is called, for every agent: "本软件" means this. */
export const IDENTITY_PROMPT = [
  '# 本软件',
  '你在 MultiGameAssistant（多游戏助手）里工作：它帮用户安装和运行各个游戏的日常脚本、把脚本编成定时流水线、盯着运行出的问题、查游戏活动和进度，并通过飞书通知用户。',
  '用户说「这个软件」「本软件」「助手」指的就是 MultiGameAssistant。介绍自己时说你是 MultiGameAssistant 的 agent（用户在「回复风格」里给你起了名字就用那个名字）。',
].join('\n')

/** The system-prompt text for a persona; empty when nothing is set. */
export function personaPrompt(p: Persona): string {
  const lines: string[] = []
  if (p.name !== undefined && p.name.trim() !== '') lines.push(`你的名字是「${p.name.trim()}」，自称时用这个名字。`)
  if (p.callUser !== undefined && p.callUser.trim() !== '') lines.push(`称呼用户为「${p.callUser.trim()}」。`)
  if (STYLE_TEXT[p.style] !== '') lines.push(STYLE_TEXT[p.style])
  if (p.custom !== undefined && p.custom.trim() !== '') lines.push(`用户对你说话方式的要求：${p.custom.trim()}`)
  if (lines.length === 0) return ''
  return ['# 回复风格', ...lines, '这些只影响你说话的方式，不改变做事的规则：确认、安全限制和不能做的事都照旧；在飞书里回复也一样。'].join('\n')
}

export class PersonaStore {
  readonly #file: string
  #current: Persona = DEFAULT_PERSONA

  constructor(dataDir: string) {
    this.#file = join(dataDir, 'persona.json')
  }

  get current(): Persona {
    return this.#current
  }

  async load(): Promise<void> {
    try {
      const parsed = Persona.safeParse(JSON.parse(await readFile(this.#file, 'utf8')))
      if (parsed.success) this.#current = parsed.data
    } catch { /* not set yet */ }
  }

  async set(persona: Persona): Promise<Persona> {
    const clean: Persona = {
      style: persona.style,
      ...(persona.name?.trim() ? { name: persona.name.trim() } : {}),
      ...(persona.callUser?.trim() ? { callUser: persona.callUser.trim() } : {}),
      ...(persona.custom?.trim() ? { custom: persona.custom.trim() } : {}),
    }
    await mkdir(join(this.#file, '..'), { recursive: true })
    await writeFile(`${this.#file}.tmp`, `${JSON.stringify(clean, null, 2)}\n`)
    await rename(`${this.#file}.tmp`, this.#file)
    this.#current = clean
    return clean
  }
}
