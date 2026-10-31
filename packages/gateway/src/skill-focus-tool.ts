/**
 * `skill_focus`: the agent says which scripts and games it is working on now,
 * and sees their skills (and only theirs) from then on (skill-scope.ts). The
 * new focus replaces the last unless `add` is set, so moving on to another
 * script moves the skills along with it.
 */
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { ToolDefinition } from '@deepseek-ai/dsh-tools'
import { z } from 'zod'
import type { SkillScope } from './skill-scope.ts'

const Args = z.object({
  scripts: z.array(z.string().min(1).max(64)).max(20).nullish(),
  games: z.array(z.string().min(1).max(64)).max(20).nullish(),
  add: z.boolean().nullish(),
})

export function skillFocusTool(scope: SkillScope): ToolDefinition {
  return {
    name: 'skill_focus',
    description: [
      '说明你现在在处理哪些脚本、哪些游戏，之后才能看到并加载它们专属的技能（技能隔离：某个脚本、某个游戏的技能只给处理它的会话用）。',
      '开始操作、分析、诊断、编排某个脚本或查看某个游戏之前先调用；换到另一个脚本或游戏时再调用一次（默认替换，旧的技能随之隐藏）。',
      '同时处理几个（例如把几个脚本排成一条流水线）就一起写上。脚本 id 用 script_list 查，游戏 id 用游戏工具查。通用技能一直可见，不用调用。',
    ].join(''),
    parameters: {
      type: 'object',
      properties: {
        scripts: { type: 'array', items: { type: 'string' }, description: '脚本 id（或脚本包 id）。' },
        games: { type: 'array', items: { type: 'string' }, description: '游戏 id（或游戏名）。' },
        add: { type: 'boolean', description: '加到现在的范围里，而不是替换（可选）。' },
      },
      additionalProperties: false,
    },
    output: { schema: {}, render: (_args, value): ContentBlock[] => [{ type: 'text', text: JSON.stringify(value, null, 1) }] },
    timeoutMs: 10_000,
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const parsed = Args.safeParse(args ?? {})
      if (!parsed.success) throw new Error(`参数无效：${parsed.error.issues.map(i => `${i.path.join('.') || '(root)'} ${i.message}`).join('; ')}`)
      if (exec.agent === undefined) throw new Error('只能在会话里设置')
      const { scripts, games, add } = parsed.data
      const focus = await scope.setFocus(exec.agent.session.id, { scripts: scripts ?? [], games: games ?? [] }, add === true ? 'add' : 'replace')
      const own = scope.skillsFor(focus).filter(s => s.owner !== undefined)
      return {
        focus,
        skills: own.map(s => ({ name: s.name, description: s.description })),
        note: own.length === 0
          ? '这些脚本和游戏还没有专属技能；通用技能照常可用。'
          : '这些技能现在可以用 skill 工具加载；技能列表会在下一步更新。',
      } as never
    },
    presentCall: args => {
      const a = (args ?? {}) as { scripts?: unknown; games?: unknown }
      const names = [...(Array.isArray(a.scripts) ? a.scripts : []), ...(Array.isArray(a.games) ? a.games : [])].map(String)
      return { card: 'generic', title: `技能范围：${names.join('、') || '只用通用技能'}`, kind: 'other' }
    },
  }
}
