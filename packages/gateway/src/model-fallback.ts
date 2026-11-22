/**
 * 备用模型 (设置 → 模型): when an agent's model fails in a way another model
 * would not (余额不足, a Key that no longer works, the model gone, the service
 * still failing after its retries), the agent goes on with the next model of
 * its fallback list — the agents' list for an agent's own conversation, the
 * sub-agents' list for a sub-agent (agent-models.ts).
 *
 * dsh fixes a step's model before the step starts, so the failed turn ends
 * as it would anyway; then, as the agent goes idle, the next model is chosen
 * for the session and a new turn is opened with a message of the app's own
 * (source MODEL_FALLBACK_SOURCE, `notice` form): the person sees it as a card
 * (which service and model, why), and the agent reads it in its context and
 * goes on with what it was doing. The turn opens in the same moment the agent
 * goes idle, so whoever waits for the agent to settle (dsh's sub-agent
 * service, a hand-off) waits for the new turn too.
 *
 * The models a session has tried since its last completed turn are not tried
 * again, so a list where every model fails ends with the last error.
 */
import { randomUUID } from 'node:crypto'
import { MODEL_FALLBACK_SOURCE, type FallbackRoute, type ModelFallbackNotice, type ModelSelection } from '@adg/protocol'

/** A model failure as dsh reports it (dsh-llm LlmFailure), the parts read here. */
export interface FailureFacts {
  readonly code: string
  readonly message: string
  readonly status?: number
}

/** The failure an agent's error carries: an LlmError's own, else its code and message. */
export function failureOf(error: unknown): FailureFacts | undefined {
  if (error === null || typeof error !== 'object') return undefined
  const e = error as { failure?: unknown; code?: unknown; message?: unknown }
  const failure = e.failure !== null && typeof e.failure === 'object' ? e.failure as { code?: unknown; message?: unknown; status?: unknown } : undefined
  const code = typeof failure?.code === 'string' ? failure.code : typeof e.code === 'string' ? e.code : undefined
  if (code === undefined) return undefined
  const message = typeof failure?.message === 'string' ? failure.message : typeof e.message === 'string' ? e.message : ''
  return { code, message, ...(typeof failure?.status === 'number' ? { status: failure.status } : {}) }
}

const QUOTA_CODES = new Set(['QUOTA', 'ACCOUNT_QUOTA', 'HTTP_402'])
const AUTH_CODES = new Set(['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'ACCOUNT_TOKEN_INVALID', 'ACCOUNT_SIGN_IN_REQUIRED', 'NO_CREDENTIAL_STORE', 'HTTP_401', 'HTTP_403'])
const GONE_CODES = new Set(['NO_ADAPTER', 'UNKNOWN_MODEL', 'MODEL_UNSUPPORTED', 'HTTP_404'])
const LIMIT_CODES = new Set(['RATE_LIMIT', 'HTTP_429'])
/** Balance and quota wording, for services whose error dsh could not classify (a 400 that says 余额不足). */
const QUOTA_WORDS = /insufficient[\s_-]*(account[\s_-]*)?(balance|quota|funds|credit)|exceeded your current quota|quota[\s_-]*(exceeded|exhausted)|out of credits|credit balance is too low|arrears|余额不足|欠费|额度(已)?(用完|用尽|不足|耗尽)|账户余额/i

/**
 * Why a failure is one to go on from with another model, in a few words for
 * the card; undefined for failures another model would have too (the network
 * down, the request too long, the person stopping it).
 */
export function fallbackReason(failure: FailureFacts): string | undefined {
  const { code } = failure
  if (QUOTA_CODES.has(code) || failure.status === 402 || QUOTA_WORDS.test(failure.message)) return '余额或额度不足'
  if (AUTH_CODES.has(code)) return 'Key 无效或没有权限'
  if (GONE_CODES.has(code)) return '模型不可用'
  if (LIMIT_CODES.has(code)) return '请求太频繁，重试后仍被限流'
  if (code === 'TIMEOUT') return '模型请求超时，重试后仍无响应'
  if (code === 'SERVER' || /^HTTP_5\d\d$/.test(code)) return '模型服务出错，重试后仍然失败'
  return undefined
}

const keyOf = (s: { provider: string; model: string }) => `${s.provider}/${s.model}`

/**
 * The model to go on with: the first of `list` after the one that failed
 * (from the top when it is not in the list), then the ones before it; none
 * already tried, none the person cannot use now.
 */
export function nextFallback(current: ModelSelection, list: readonly ModelSelection[], tried: ReadonlySet<string>, usable: (s: ModelSelection) => boolean): ModelSelection | undefined {
  const at = list.findIndex(s => keyOf(s) === keyOf(current))
  const order = at < 0 ? list : [...list.slice(at + 1), ...list.slice(0, at)]
  return order.find(s => keyOf(s) !== keyOf(current) && !tried.has(keyOf(s)) && usable(s))
}

/** What the agent reads: what happened, and that it goes on. */
export function fallbackText(notice: ModelFallbackNotice): string {
  const name = (r: FallbackRoute) => `「${r.providerName}」的 ${r.modelName}`
  return [
    `（软件通知：刚才用的${name(notice.from)}出错了，原因：${notice.reason}（${notice.error.trim() || notice.code}）。`,
    `已经自动换成备用模型${name(notice.to)}，这个对话接下来都用它。用户能看到这次切换的卡片。`,
    '接着做刚才没做完的事，已经做完的步骤不要重做；需要的话可以在回复里提一句换了模型。）',
  ].join('')
}

/** The card's one line. */
export function fallbackSummary(notice: ModelFallbackNotice): string {
  const line = `${notice.from.modelName} ${notice.reason}，已换成 ${notice.to.providerName} / ${notice.to.modelName}`
  return line.length > 120 ? `${line.slice(0, 119)}…` : line
}

/** The message that opens the new turn, as dsh's createUserMessage makes one. */
export function fallbackMessage(notice: ModelFallbackNotice): unknown {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text: fallbackText(notice) })]),
    source: Object.freeze({ kind: MODEL_FALLBACK_SOURCE, form: 'notice', summary: fallbackSummary(notice), fallback: notice }),
  })
}

/** What is used of a dsh agent (dsh-agent-loop ReactLoopAgent), structurally. */
export interface FallbackAgent {
  readonly status?: unknown
  readonly session: { readonly id: string; readonly header?: { readonly origin?: string } }
  readonly lifetimeSignal?: AbortSignal
  readonly model?: {
    current(): Readonly<{ provider: string; model: string; reasoningEffort?: string }> | undefined
    select(selection: Readonly<{ provider: string; model: string; reasoningEffort?: string }>): void
  }
  /** Queue for a new turn and wake the agent. */
  followup(message: unknown): void
  /** Queue without waking (dsh's own `send`): the messages before the last, so one turn takes them all. */
  send?(message: unknown, target: 'next-turn', wakeup: boolean): void
}

export interface FallbackDeps {
  /** The fallback list for an agent's own conversations, or for sub-agents. */
  list(sub: boolean): readonly ModelSelection[]
  /** A model's service and model names; undefined: it cannot be used now (no such service or model configured). */
  route(selection: ModelSelection): Omit<FallbackRoute, 'provider' | 'model'> | undefined
  /** The person's messages the failed step took and never logged, to go into the new turn first (queue.ts). */
  lost?(sessionId: string): readonly unknown[]
  /** Whether the session is the app's (a dsh shared with other work). */
  isOwn?(sessionId: string): boolean
  log?: { info(message: string): void; warn(message: string): void }
}

/**
 * Follows the agents' requests and failures and does the switch. Its methods
 * are called from dsh's events, synchronously, in the order dsh emits them.
 */
export class ModelFallback {
  readonly #deps: FallbackDeps
  /** Sessions whose request of their own model is under way (from `agent/request` until its reply is logged). */
  readonly #requesting = new Set<string>()
  /** The models each session has tried since its last completed turn. */
  readonly #tried = new Map<string, Set<string>>()
  /** The switch decided as the turn failed, to be announced as the agent goes idle. */
  readonly #pending = new WeakMap<object, ModelFallbackNotice>()

  constructor(deps: FallbackDeps) {
    this.#deps = deps
  }

  /** The agent is about to call its model (dsh's `agent/request`). */
  requested(sessionId: string): void {
    this.#requesting.add(sessionId)
  }

  /** A session's event was logged: its model answered, or a turn ended. */
  logged(sessionId: string, event: { type?: unknown; data?: unknown }): void {
    if (event.type === 'assistant/message') this.#requesting.delete(sessionId)
    else if (event.type === 'turn/end') {
      const reason = (event.data as { reason?: { kind?: unknown } } | undefined)?.reason
      if (reason?.kind === 'completed') this.#tried.delete(sessionId)
    }
  }

  /**
   * The agent's turn failed (dsh's `agent/error`, before the turn's end is
   * logged). A failure of its own model's request that another model would
   * not have: the next model is chosen now (so the log shows the switch
   * before the turn's end) and announced as the agent goes idle.
   * @returns the switch, if one was made.
   */
  failed(agent: FallbackAgent, error: unknown): ModelFallbackNotice | undefined {
    const sessionId = agent.session.id
    const requesting = this.#requesting.delete(sessionId)
    if (!requesting || agent.model === undefined || this.#deps.isOwn?.(sessionId) === false) return undefined
    const failure = failureOf(error)
    const reason = failure === undefined ? undefined : fallbackReason(failure)
    const current = agent.model.current()
    if (failure === undefined || reason === undefined || current === undefined) return undefined
    const sub = agent.session.header?.origin === 'subagent'
    let tried = this.#tried.get(sessionId)
    if (tried === undefined) this.#tried.set(sessionId, tried = new Set())
    tried.add(keyOf(current))
    const list = this.#deps.list(sub)
    const next = nextFallback(current, list, tried, s => this.#deps.route(s) !== undefined)
    if (next === undefined) {
      if (list.length > 0) this.#deps.log?.warn(`${sessionId}: ${current.provider}/${current.model} failed (${failure.code}) and no fallback model is left to try`)
      return undefined
    }
    const route = (s: { provider: string; model: string }): FallbackRoute => {
      const names = this.#deps.route(s)
      return { provider: s.provider, model: s.model, providerName: names?.providerName ?? s.provider, modelName: names?.modelName ?? s.model }
    }
    const notice: ModelFallbackNotice = {
      from: route(current), to: route(next), reason, error: failure.message, code: failure.code, ...(sub ? { sub: true } : {}),
    }
    try {
      agent.model.select({ provider: next.provider, model: next.model, ...(next.reasoningEffort === undefined ? {} : { reasoningEffort: next.reasoningEffort }) })
    } catch (selectError) {
      this.#deps.log?.warn(`${sessionId}: could not switch to the fallback model ${next.provider}/${next.model}: ${selectError instanceof Error ? selectError.message : String(selectError)}`)
      return undefined
    }
    this.#pending.set(agent, notice)
    this.#deps.log?.info(`${sessionId}: ${current.provider}/${current.model} failed (${failure.code}), going on with ${next.provider}/${next.model}`)
    return notice
  }

  /**
   * The agent went idle (dsh's `agent/status`): after a switch, a new turn
   * opens with the person's lost messages and the card. Not inside dsh's
   * emit (the listeners after this one would hear 「idle」 after the new turn's
   * 「running」) but in the microtask right after it: still before the end of
   * the failed turn resolves, so whoever waits for the agent (`whenIdle`,
   * dsh's sub-agent service) finds it running again and waits on.
   * @returns whether a new turn is about to open.
   */
  idle(agent: FallbackAgent): boolean {
    const notice = this.#pending.get(agent)
    if (notice === undefined || agent.status !== 'idle') return false
    this.#pending.delete(agent)
    queueMicrotask(() => this.#goOn(agent, notice))
    return true
  }

  #goOn(agent: FallbackAgent, notice: ModelFallbackNotice): void {
    if (agent.lifetimeSignal?.aborted === true) return
    try {
      const messages = [...(this.#deps.lost?.(agent.session.id) ?? []), fallbackMessage(notice)]
      for (const message of messages.slice(0, -1)) {
        if (agent.send !== undefined) agent.send(message, 'next-turn', false)
        else agent.followup(message)
      }
      agent.followup(messages.at(-1))
    } catch (error) {
      this.#deps.log?.warn(`${agent.session.id}: could not go on with the fallback model: ${error instanceof Error ? error.message : String(error)}`)
    }
  }

  /** The session is gone. */
  forget(sessionId: string): void {
    this.#requesting.delete(sessionId)
    this.#tried.delete(sessionId)
  }
}
