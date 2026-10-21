/**
 * Question broker: answers dsh's `user-questions/request` waterfall (the
 * built-in `ask_user_question` tool) through connected protocol clients and
 * other answerers (chat channels), like the approval broker. Pending
 * questions are replayed to clients that connect later and withdrawn when the
 * agent stops waiting.
 */
import type { QuestionAnswerItem, QuestionItem, QuestionOutcome, QuestionRequested } from '@adg/protocol'

export interface QuestionAsk {
  readonly sessionId: string
  readonly callId?: string
  readonly questions: readonly QuestionItem[]
  readonly signal?: AbortSignal
}

/** dsh's answer shape: one item per question. */
export interface QuestionAnswer {
  answers: { id: string; selected: string[]; custom?: string }[]
}

/** Another place a person can answer questions, e.g. a Feishu card (`@adg/notify`). */
export interface QuestionAnswerer {
  /** Whether it can reach someone for a question from `sessionId` right now. */
  active(sessionId: string): boolean
  /** A new question; answer it with the gateway's `respondQuestion`. */
  asked(request: QuestionRequested): void
  /** Answered or withdrawn anywhere. */
  resolved(questionId: string, outcome: QuestionOutcome, answers?: readonly QuestionAnswerItem[]): void
}

interface Pending {
  readonly request: QuestionRequested
  readonly settle: (outcome: QuestionOutcome, answer?: QuestionAnswer) => void
}

export interface QuestionBrokerOptions {
  readonly broadcastRequested: (request: QuestionRequested) => void
  readonly broadcastResolved: (questionId: string, outcome: QuestionOutcome, answers?: QuestionAnswer['answers']) => void
}

/** Thrown into the waterfall when nobody will answer any more. */
export class QuestionClosed extends Error {
  readonly outcome: Exclude<QuestionOutcome, 'answered'>
  constructor(outcome: Exclude<QuestionOutcome, 'answered'>) {
    super(outcome === 'cancelled' ? 'the question was withdrawn' : 'the question can no longer be answered')
    this.outcome = outcome
  }
}

export class QuestionBroker {
  private readonly pending = new Map<string, Pending>()
  private readonly answerers = new Set<QuestionAnswerer>()
  private readonly options: QuestionBrokerOptions

  constructor(options: QuestionBrokerOptions) {
    this.options = options
  }

  /** @returns a disposer. */
  addAnswerer(answerer: QuestionAnswerer): () => void {
    this.answerers.add(answerer)
    return () => { this.answerers.delete(answerer) }
  }

  /** Whether some answerer besides protocol clients can take a question from `sessionId` now. */
  hasActiveAnswerer(sessionId: string): boolean {
    for (const answerer of this.answerers) if (safely(() => answerer.active(sessionId), false)) return true
    return false
  }

  /**
   * Put the questions to the clients and answerers and wait for the first answer.
   * @throws QuestionClosed when the agent stops waiting or the broker goes away.
   */
  ask(ask: QuestionAsk): Promise<QuestionAnswer> {
    if (ask.signal?.aborted === true) return Promise.reject(new QuestionClosed('cancelled'))
    const questionId = crypto.randomUUID()
    const request: QuestionRequested = {
      questionId,
      sessionId: ask.sessionId,
      ...(ask.callId === undefined ? {} : { callId: ask.callId }),
      questions: ask.questions.map(q => ({
        id: q.id,
        question: q.question,
        ...(q.detail === undefined ? {} : { detail: q.detail }),
        ...(q.header === undefined ? {} : { header: q.header }),
        ...(q.options === undefined ? {} : { options: q.options.map(o => ({ label: o.label, ...(o.description === undefined ? {} : { description: o.description }) })) }),
        ...(q.multiSelect === undefined ? {} : { multiSelect: q.multiSelect }),
      })),
    }
    return new Promise<QuestionAnswer>((resolve, reject) => {
      const onAbort = () => this.settle(questionId, 'cancelled')
      this.pending.set(questionId, {
        request,
        settle: (outcome, answer) => {
          ask.signal?.removeEventListener('abort', onAbort)
          if (outcome === 'answered' && answer !== undefined) resolve(answer)
          else reject(new QuestionClosed(outcome === 'answered' ? 'unavailable' : outcome))
        },
      })
      ask.signal?.addEventListener('abort', onAbort, { once: true })
      this.options.broadcastRequested(request)
      for (const answerer of this.answerers) if (safely(() => answerer.active(request.sessionId), false)) safely(() => answerer.asked(request), undefined)
    })
  }

  /**
   * Answer a question. Every question of the request gets exactly one item:
   * unknown ids are dropped, missing ones count as skipped.
   * @returns false when the question is unknown or already settled.
   */
  respond(questionId: string, answers: readonly QuestionAnswerItem[]): boolean {
    const entry = this.pending.get(questionId)
    if (entry === undefined) return false
    const items = entry.request.questions.map(q => {
      const given = answers.find(a => a.id === q.id)
      const custom = given?.custom?.trim()
      return { id: q.id, selected: [...(given?.selected ?? [])], ...(custom === undefined || custom === '' ? {} : { custom }) }
    })
    return this.settle(questionId, 'answered', { answers: items })
  }

  /** Questions still waiting, for replay to a newly connected client. */
  open(): readonly QuestionRequested[] {
    return [...this.pending.values()].map(p => p.request)
  }

  /** Fail every pending question (gateway unloading). */
  dispose(): void {
    for (const id of [...this.pending.keys()]) this.settle(id, 'unavailable')
  }

  private settle(questionId: string, outcome: QuestionOutcome, answer?: QuestionAnswer): boolean {
    const entry = this.pending.get(questionId)
    if (entry === undefined) return false
    this.pending.delete(questionId)
    entry.settle(outcome, answer)
    this.options.broadcastResolved(questionId, outcome, answer?.answers)
    for (const answerer of this.answerers) safely(() => answerer.resolved(questionId, outcome, answer?.answers), undefined)
    return true
  }
}

function safely<T>(fn: () => T, fallback: T): T {
  try { return fn() } catch { return fallback }
}
