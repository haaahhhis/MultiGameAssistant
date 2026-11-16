/**
 * Waits that give way to new input.
 *
 * dsh hands what is sent into a running turn (the user's message with
 * 「插入当前轮次」, another agent's message, a sub-agent's completion notice) to
 * the agent at its next step, and a step ends only when every tool call in it
 * has. A tool that waits — script_runs for a run to end, up to an hour — so
 * keeps the user's message from the agent for as long as it waits. dsh's own
 * wait_agent ends as soon as such input is there; the app's waits do the same
 * through this.
 */
import type { Context } from '@deepseek-ai/cordis'

/** What a wait reads of its calling agent (dsh-agent's Agent, structurally). */
interface InputAgent {
  readonly inbox?: { readonly nextStep?: readonly { readonly id: string }[] }
}

/** The parts of a tool call a wait needs. */
export interface WaitingCall {
  /** The agent the call runs for; without one, nothing ends the wait early. */
  readonly agent?: unknown
  /** The model's tool call this one belongs to (a run_code program's calls share it). */
  readonly rootCallId: string
}

export interface InputWatch {
  /** Aborts once the calling agent has input at its next step that this model call was not told of. */
  readonly signal: AbortSignal
  /** Stop watching. */
  dispose(): void
}

/** The reason a watch's signal carries. */
export const NEW_INPUT = 'new-input'

export class NewInput {
  readonly #watchers = new Map<object, Set<() => void>>()
  /**
   * Input already reported to one model call. Inside a run_code program the
   * input reaches the model only after the program ends, so a later wait of
   * the same program must not end on it again (it would only spin).
   */
  readonly #reported = new WeakMap<object, { readonly rootCallId: string; readonly ids: ReadonlySet<string> }>()

  constructor(ctx: Context) {
    ctx.on('agent/inbox/inserted' as never, (({ agent }: { agent: object }) => {
      for (const check of this.#watchers.get(agent) ?? []) check()
    }) as never)
  }

  watch(call: WaitingCall): InputWatch {
    const controller = new AbortController()
    const agent = call.agent as (InputAgent & object) | undefined
    if (agent === undefined || agent === null) return { signal: controller.signal, dispose: () => {} }
    const previous = this.#reported.get(agent)
    const seen = previous?.rootCallId === call.rootCallId ? previous.ids : undefined
    const check = () => {
      if (controller.signal.aborted) return
      const pending = agent.inbox?.nextStep ?? []
      if (!pending.some(message => seen?.has(message.id) !== true)) return
      this.#reported.set(agent, { rootCallId: call.rootCallId, ids: new Set(pending.map(message => message.id)) })
      dispose()
      controller.abort(NEW_INPUT)
    }
    const dispose = () => {
      const set = this.#watchers.get(agent)
      set?.delete(check)
      if (set?.size === 0) this.#watchers.delete(agent)
    }
    let set = this.#watchers.get(agent)
    if (set === undefined) this.#watchers.set(agent, set = new Set())
    set.add(check)
    // Watch first, then look: input arriving in between is not missed.
    check()
    return { signal: controller.signal, dispose }
  }
}
