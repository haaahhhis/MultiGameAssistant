/**
 * @adg/gateway/agent — the app's part of its agent preset, when the dsh is
 * shared with other work (shared.ts). Listed in that preset's plugins, it
 * runs in the preset's scope and registers there what the app's plugins gave
 * the gateway for its agents (tools, prompt sections, step hooks), so the
 * person's other chats in the same dsh never see them.
 */
import type { Context } from '@deepseek-ai/cordis'
import type {} from './index.ts'

export const name = 'adg-agent'
// The parts register through this scope's tools and prompt (shared.ts AgentPart): Cordis lends a plugin only what it declares.
export const inject = ['adgGateway', 'tools', 'systemPrompt']

export function apply(ctx: Context): void {
  ctx.effect(() => ctx.adgGateway.attachAgentScope(ctx), 'adg-agent parts')
}
